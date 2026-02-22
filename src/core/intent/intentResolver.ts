import { SymbolIndex } from '../indexing/symbolIndex';
import { SymbolEntry } from '../indexing/symbolExtractor';
import {
    IntentDescriptor,
    ResolvedConfidence,
    ResolvedSymbol,
    ResolvedIntent,
} from './types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOG_PREFIX = '[RippleCheck][Resolver]';

/**
 * Maximum number of resolved symbols returned.  Keeps the predictive blast
 * radius focused — too many roots produce noise rather than signal.
 */
const MAX_RESOLVED = 20;

// ---------------------------------------------------------------------------
// Tokenisation helpers
// ---------------------------------------------------------------------------

/**
 * Split an identifier or path into lowercase tokens.
 *
 * Handles:
 *  - camelCase / PascalCase  →  ["get", "user", "by", "id"]
 *  - snake_case / kebab-case →  ["get", "user", "by", "id"]
 *  - file paths               →  splits on `/`, `.`, `-`, `_`
 *
 * Short tokens (≤ 2 chars) are kept only if the original string was short,
 * to avoid matching on noise like "a", "to", "is".
 */
function tokenise(s: string): string[] {
    // Insert word boundaries before uppercase letters in camelCase
    const spaced = s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
    const raw = spaced
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean);

    return s.length <= 4 ? raw : raw.filter(t => t.length > 2);
}

/**
 * Jaccard-like token overlap score: |A ∩ B| / |A ∪ B|.
 * Returns a float in [0, 1].  Exact-string equality short-circuits to 1.
 */
function tokenOverlap(a: string, b: string): number {
    if (a === b) { return 1; }
    const ta = new Set(tokenise(a));
    const tb = new Set(tokenise(b));
    if (ta.size === 0 || tb.size === 0) { return 0; }
    let intersection = 0;
    for (const t of ta) { if (tb.has(t)) { intersection++; } }
    const union = ta.size + tb.size - intersection;
    return intersection / union;
}

// ---------------------------------------------------------------------------
// Per-hint match scoring
// ---------------------------------------------------------------------------

/**
 * Score how well a single `symbolHint` string matches a `SymbolEntry`.
 *
 * Returns null when there is no meaningful match (score below threshold).
 *
 * Scoring tiers (highest wins):
 *  1.0  exact name match (case-insensitive)
 *  0.8  hint is a substring of name, or name is a substring of hint
 *  0.4–0.9  token overlap (Jaccard on camelCase tokens)
 */
function scoreSymbolHint(hint: string, entry: SymbolEntry): number | null {
    const hintLower = hint.toLowerCase();
    const nameLower = entry.name.toLowerCase();

    // Tier 1: exact
    if (hintLower === nameLower) { return 1.0; }

    // Tier 2: substring containment (covers "auth" matching "authenticate")
    // Use the symmetric ratio: shorter / longer, so a 1-char name matching a
    // 20-char hint scores near-zero rather than 0.5.
    if (nameLower.includes(hintLower) || hintLower.includes(nameLower)) {
        const longer  = Math.max(hintLower.length, nameLower.length);
        const shorter = Math.min(hintLower.length, nameLower.length);
        const lengthSimilarity = shorter / longer;
        // Require at least 40% length similarity so "a" doesn't match "applyRateLimiting"
        if (lengthSimilarity < 0.40) { return null; }
        return 0.5 + 0.3 * lengthSimilarity;
    }

    // Tier 3: token overlap
    const overlap = tokenOverlap(hint, entry.name);
    if (overlap >= 0.25) { return overlap * 0.9; }

    return null;
}

/**
 * Score how well a single `fileHint` string matches a `SymbolEntry`'s file path.
 *
 * Returns null when there is no meaningful match.
 */
function scoreFileHint(hint: string, entry: SymbolEntry, workspaceRoot: string): number | null {
    const normalRoot = workspaceRoot.replace(/\\/g, '/').replace(/\/$/, '');
    const relPath = entry.filePath.replace(/\\/g, '/')
        .replace(normalRoot + '/', '').toLowerCase();
    const hintLower = hint.replace(/\\/g, '/').toLowerCase();

    // Exact path match
    if (relPath === hintLower) { return 1.0; }

    // Hint is a path segment of the file
    if (relPath.includes(hintLower)) {
        return 0.6;
    }

    // Token overlap on path segments
    const overlap = tokenOverlap(hintLower, relPath);
    if (overlap >= 0.2) { return overlap * 0.5; }

    return null;
}

// ---------------------------------------------------------------------------
// Confidence from score
// ---------------------------------------------------------------------------

function scoreToConfidence(score: number): ResolvedConfidence {
    if (score >= 0.85) { return 'high';   }
    if (score >= 0.45) { return 'medium'; }
    return 'low';
}

// ---------------------------------------------------------------------------
// Keyword extraction and direct-prompt scoring
// ---------------------------------------------------------------------------

/**
 * Common English words and programming meta-words that carry no domain signal.
 * Stripped before keyword matching so only domain-specific words remain.
 */
const STOPWORDS = new Set<string>([
    'a','an','the','and','or','but','in','on','at','to','for','of','with','by',
    'from','as','is','was','are','were','be','been','being','have','has','had',
    'do','does','did','will','would','could','should','may','might','shall','can',
    'new','add','make','create','all','this','that','it','its','into','onto',
    'up','out','about','our','my','we','i','you','some','any','each','every',
    'more','most','other','another','so','also','just','than','then','when',
    'where','which','who','how','what','there','here','get','set','not','no',
    'if','want','need','use','using','used','update','change','modify','delete',
    'remove','implement','existing','current','code','codebase','repo','feature',
    'file','files','module','modules','function','class','method','type','interface',
    'support','allow','enable','ensure','provide','return','call','pass','handle',
]);

/**
 * Extract meaningful domain keywords from a natural-language prompt.
 *
 * Examples:
 *   "Add a new plot graph to the codebase"  → ["plot", "graph"]
 *   "Add rate limiting to all API routes"   → ["rate", "limiting", "api", "routes"]
 */
function extractKeywords(prompt: string): string[] {
    const raw = prompt.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const seen = new Set<string>();
    const result: string[] = [];
    for (const w of raw) {
        if (w.length < 3 || STOPWORDS.has(w) || seen.has(w)) { continue; }
        seen.add(w);
        result.push(w);
    }
    return result;
}

/**
 * Score how relevant an indexed symbol is to a set of prompt domain keywords.
 *
 * For each keyword:
 *   - Exact camelCase token match         → 1.0 point
 *   - Prefix/suffix overlap with a token  → 0.7 points  ("plot" ↔ "plotting")
 *   - Substring of the lowercased name    → 0.4 points  (wider net, lower weight)
 *
 * Final score = sum_of_points / keyword_count  (clamped to [0, 1]).
 * Returns null when no keyword matches at all.
 */
function scoreByKeywords(keywords: string[], entry: SymbolEntry): number | null {
    const nameLower  = entry.name.toLowerCase();
    const nameTokens = new Set(tokenise(entry.name));

    let matchedPoints = 0;
    for (const kw of keywords) {
        if (nameTokens.has(kw)) {
            matchedPoints += 1.0;
        } else {
            let partial = 0;
            for (const t of nameTokens) {
                if (t.startsWith(kw) || kw.startsWith(t)) { partial = 0.7; break; }
            }
            if (partial === 0 && nameLower.includes(kw)) { partial = 0.4; }
            matchedPoints += partial;
        }
    }

    if (matchedPoints === 0) { return null; }
    return Math.min(1, matchedPoints / keywords.length);
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Resolve an {@link IntentDescriptor} against the live symbol index to produce
 * a ranked list of real symbol IDs the described change would touch.
 *
 * ## Two-pass scoring
 *
 * ### Pass 1 — LLM hint matching (high precision)
 * When the LLM provided explicit symbolHints / fileHints, score every indexed
 * symbol against those hints using the substring + token-overlap algorithm.
 * Results are kept only when they exceed a strict confidence threshold (0.45).
 *
 * ### Pass 2 — Keyword matching (higher recall, always runs)
 * Extract domain keywords directly from the raw user prompt (stripping English
 * stopwords and programming meta-words).  Score every symbol by how many
 * keywords appear in its camelCase token set.
 *
 * Pass 2 serves two roles:
 *  - **Fallback**: when LLM returned empty symbolHints (e.g. "add a new Plot"
 *    — the LLM correctly sees no existing symbol named "new Plot"), keyword
 *    search finds existing symbols in the same domain (AreaPlot, BarPlot …).
 *  - **Relevance gate**: if the best keyword score across the whole index is
 *    below 0.30, the prompt describes something foreign to this codebase and
 *    `isRelevant` is set false so the UI can explain the mismatch.
 */
export function resolveIntent(
    descriptor: IntentDescriptor,
    symbolIndex: SymbolIndex,
    workspaceRootFsPath: string,
): ResolvedIntent {
    const { symbolHints, fileHints } = descriptor;
    const hasSymbolHints = symbolHints.length > 0;
    const hasFileHints   = fileHints.length   > 0;

    const normalRoot = workspaceRootFsPath.replace(/\\/g, '/').replace(/\/$/, '');

    console.log(
        `${LOG_PREFIX} Resolving: symbolHints=[${symbolHints.join(', ')}]` +
        ` fileHints=[${fileHints.join(', ')}]` +
        ` against ${symbolIndex.size} symbol(s)`,
    );

    // ── Pass 1: LLM-hint-based scoring (high precision) ──────────────────
    // Only runs when the LLM provided explicit hints.  Uses strict threshold.
    const hintCandidates: Array<{ entry: SymbolEntry; score: number; matchedHints: string[] }> = [];

    if (hasSymbolHints || hasFileHints) {
        for (const entry of symbolIndex.values()) {
            const matchedHints: string[] = [];
            let symbolScore = 0;
            let fileScore   = 0;

            if (hasSymbolHints) {
                for (const hint of symbolHints) {
                    const s = scoreSymbolHint(hint, entry);
                    if (s !== null && s > symbolScore) { symbolScore = s; matchedHints.push(hint); }
                }
            }
            if (hasFileHints) {
                for (const hint of fileHints) {
                    const s = scoreFileHint(hint, entry, workspaceRootFsPath);
                    if (s !== null && s > fileScore) {
                        fileScore = s;
                        if (!matchedHints.includes(hint)) { matchedHints.push(hint); }
                    }
                }
            }

            let score: number;
            if (hasSymbolHints && hasFileHints)  { score = 0.7 * symbolScore + 0.3 * fileScore; }
            else if (hasSymbolHints)             { score = symbolScore; }
            else                                 { score = 0.4 * fileScore; }

            if (entry.isExported) { score = Math.min(1, score + 0.05); }
            if (score < 0.45 || matchedHints.length === 0) { continue; }

            hintCandidates.push({ entry, score, matchedHints });
        }
        hintCandidates.sort((a, b) => b.score - a.score);
    }

    // ── Pass 2: keyword-based scoring from raw prompt (always runs) ───────
    // Extracts domain words from the user's prompt directly, bypassing the LLM.
    // Acts as primary source when LLM hints are empty, and as relevance gate.
    const promptKeywords = extractKeywords(descriptor.prompt);
    const keywordCandidates: Array<{ entry: SymbolEntry; score: number; matchedHints: string[] }> = [];
    let bestKeywordScore = 0;

    if (promptKeywords.length > 0) {
        for (const entry of symbolIndex.values()) {
            const ks = scoreByKeywords(promptKeywords, entry);
            if (ks === null) { continue; }
            const score = Math.min(1, entry.isExported ? ks + 0.05 : ks);
            if (score > bestKeywordScore) { bestKeywordScore = score; }
            if (score < 0.25) { continue; }
            keywordCandidates.push({ entry, score, matchedHints: promptKeywords });
        }
        keywordCandidates.sort((a, b) => b.score - a.score);
    }

    // ── Relevance gate ────────────────────────────────────────────────────
    // isRelevant = true if EITHER LLM hints matched something OR keyword
    // search found a symbol scoring ≥ 0.30.  Below that threshold the prompt
    // almost certainly describes a feature foreign to this codebase.
    const isRelevant = hintCandidates.length > 0 || bestKeywordScore >= 0.30;

    // ── Choose final candidates ───────────────────────────────────────────
    // Prefer LLM hints (higher precision).  Fall back to keywords (capped at
    // 10 — keyword results are noisier so we keep the blast radius focused).
    const finalCandidates =
        hintCandidates.length > 0
            ? hintCandidates.slice(0, MAX_RESOLVED)
            : keywordCandidates.slice(0, 10);

    const symbols: ResolvedSymbol[] = finalCandidates.map(c => {
        const relPath = c.entry.filePath.replace(/\\/g, '/').replace(normalRoot + '/', '');
        return {
            symbolId:     c.entry.id,
            name:         c.entry.name,
            filePath:     relPath,
            confidence:   scoreToConfidence(c.score),
            matchedHints: [...new Set(c.matchedHints)],
        };
    });

    const symbolIds = new Set(symbols.map(s => s.symbolId));

    console.log(
        `${LOG_PREFIX} Resolved ${symbols.length} symbol(s) (relevant=${isRelevant},` +
        ` source=${hintCandidates.length > 0 ? 'hints' : 'keywords'}):` +
        symbols.slice(0, 5).map(s => ` ${s.name}(${s.confidence})`).join('') +
        (symbols.length > 5 ? ` … +${symbols.length - 5} more` : ''),
    );

    return { descriptor, symbols, symbolIds, isRelevant };
}
