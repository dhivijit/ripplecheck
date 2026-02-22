import { SymbolIndex } from '../indexing/symbolIndex';
import { DependencyGraph } from '../graph/types';
import { BlastRadiusResult, traverseImpact } from '../blast/blastRadiusEngine';
import { ResolvedIntent, ResolvedConfidence, ResolvedSymbol } from './types';
import { buildVirtualDiff } from './virtualDiff';

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/**
 * Output of `computePredictiveBlastRadius`.
 *
 * Extends the real-time `BlastRadiusResult` with two predictive fields:
 *
 * - `confidenceMap`  Per-impacted-symbol confidence, reflecting both how well
 *                    the resolver matched the root and how far (in graph hops)
 *                    the symbol is from that root.
 *
 * - `phantomIds`     Symbol IDs synthesised for `add`-intent display only.
 *                    They exist in the shadow index but have no reverse edges
 *                    and produce no BFS impact.  Surface them in the UI so the
 *                    user can see the new symbol that is about to be added.
 */
export interface PredictiveBlastRadiusResult extends BlastRadiusResult {
    /**
     * How confident we are that each impacted symbol is truly at risk.
     *
     * Derivation:
     *  1. Root-level confidence comes from the resolver's match quality
     *     (`high` = exact name match, `medium` = partial, `low` = loose).
     *  2. Depth penalty: depth ≤ 1 → keeps root tier; depth ≥ 2 → demoted
     *     one tier (`high→medium`, `medium→low`, `low→low`).
     *  3. For symbols reachable from multiple roots the highest confidence wins.
     *
     * Roots themselves are NOT included — they are already in
     * `resolvedIntent.symbols` with their own confidence values.
     */
    confidenceMap: Map<string, ResolvedConfidence>;

    /**
     * IDs of phantom symbols inserted for `add` intents.
     * These are purely informational — they do not appear in `directImpact`
     * or `indirectImpact`.
     */
    phantomIds: string[];

    /**
     * Whether the original prompt relates to this codebase.
     * Mirrors `ResolvedIntent.isRelevant` — false means the UI should show
     * a "this change is unrelated to this repo" message instead of a blast radius.
     */
    isRelevant: boolean;

    /**
     * The actual symbols the resolver identified as the change targets.
     * Shown in the UI as "being deleted" / "in scope" depending on changeType.
     * Populated regardless of whether BFS found any downstream impact.
     */
    resolvedRoots: ResolvedSymbol[];

    /** The changeType from the parsed intent, for UI display. */
    changeType: string;
}

// ---------------------------------------------------------------------------
// Confidence helpers
// ---------------------------------------------------------------------------

const CONFIDENCE_RANK: Record<ResolvedConfidence, number> = {
    high:   2,
    medium: 1,
    low:    0,
};

/** Drop one confidence tier (floor: `'low'`). */
function demote(c: ResolvedConfidence): ResolvedConfidence {
    if (c === 'high')   { return 'medium'; }
    if (c === 'medium') { return 'low';    }
    return 'low';
}

/** Return whichever confidence level is higher. */
function maxConfidence(a: ResolvedConfidence, b: ResolvedConfidence): ResolvedConfidence {
    return CONFIDENCE_RANK[a] >= CONFIDENCE_RANK[b] ? a : b;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Compute a predictive blast radius from a resolved developer intent, without
 * touching the git staging area.
 *
 * ## Pipeline
 *
 * ```
 *   resolvedIntent
 *       │
 *       ▼
 *   buildVirtualDiff          (Step 3 — synthetic ImpactRoot[] from resolver output)
 *       │  roots, shadowGraph, phantomIds
 *       │
 *       ▼  (filter phantom roots — they have no reverse edges)
 *   traverseImpact            (shared BFS engine — live graph, same as real analysis)
 *       │  directImpact, indirectImpact, depthMap, paths
 *       │
 *       ▼
 *   confidence map            (Step 5 — per-symbol confidence with depth penalty)
 *       │  confidenceMap
 *       ▼
 *   PredictiveBlastRadiusResult
 * ```
 *
 * ## Live graph vs. shadow graph
 *
 * BFS runs on the **live** `graph`, not the shadow.  We want to answer:
 * "who depends on these symbols *right now*?"  The shadow graph (post-change
 * state) is returned as `stagedGraph` so the webview can visualise the
 * future dependency structure.
 *
 * @param resolvedIntent   Output of `resolveIntent` (Step 2).
 * @param symbolIndex      Live symbol index — never mutated.
 * @param graph            Live dependency graph — never mutated.
 */
export function computePredictiveBlastRadius(
    resolvedIntent: ResolvedIntent,
    symbolIndex: SymbolIndex,
    graph: DependencyGraph,
): PredictiveBlastRadiusResult {

    // ── Step 3: build synthetic roots ────────────────────────────────────────
    const { roots, shadowGraph, phantomIds } = buildVirtualDiff(
        resolvedIntent,
        symbolIndex,
        graph,
    );

    // ── Filter phantoms before BFS ────────────────────────────────────────────
    // Phantom symbols are added to the shadow index for `add`-intent display.
    // They are NEVER added as roots by buildVirtualDiff (no reverse edges exist
    // for brand-new symbols), but we guard here defensively in case that changes.
    const phantomSet = new Set(phantomIds);
    const bfsRoots = roots.filter(r => !phantomSet.has(r.symbolId));

    // ── Step 4: BFS on the live graph ─────────────────────────────────────────
    const blastResult: BlastRadiusResult = bfsRoots.length > 0
        ? traverseImpact(bfsRoots, graph)
        : emptyBlastResult(bfsRoots);

    // ── Step 5: build per-symbol confidence map ───────────────────────────────
    //
    // For every symbol in depthMap:
    //   1. Collect all `paths` entries — each path starts with a root ID.
    //   2. Look up that root's resolver confidence from resolvedIntent.symbols.
    //   3. Apply depth penalty: depth ≤ 1 → keep tier; depth ≥ 2 → demote one.
    //   4. Take the maximum confidence across all contributing roots.
    //
    // Symbols reachable from a `high`-confidence root at depth 1 stay `high`.
    // The same symbols reachable from a `low`-confidence root at depth 3 get
    // `low`; the `high` path wins, so the final value is `high`.

    // Build a fast root-id → confidence look-up table.
    const rootConfidenceOf = new Map<string, ResolvedConfidence>();
    for (const sym of resolvedIntent.symbols) {
        rootConfidenceOf.set(sym.symbolId, sym.confidence);
    }

    const confidenceMap = new Map<string, ResolvedConfidence>();
    const { depthMap, paths } = blastResult;

    for (const [symbolId, depth] of depthMap) {
        const symbolPaths = paths.get(symbolId) ?? [];
        let best: ResolvedConfidence = 'low';

        for (const path of symbolPaths) {
            // path[0] is always the root (either a deep-BFS root or a shallow root).
            const rootId   = path[0];
            const rootConf = rootConfidenceOf.get(rootId);
            if (rootConf === undefined) { continue; } // root not in resolver output — skip

            // depth ≤ 1: direct dependent, no penalty.
            // depth ≥ 2: indirect, drop one tier.
            const effective = depth <= 1 ? rootConf : demote(rootConf);
            best = maxConfidence(best, effective);
        }

        confidenceMap.set(symbolId, best);
    }

    // ── Filter: for delete intent, strip intra-folder self-references ─────────
    // When deleting a folder, BFS via reverse edges finds symbols INSIDE the
    // same folder referencing each other (e.g. a method referencing its own
    // class).  Those symbols are also being deleted — they're not real external
    // dependents.  Remove them so only callers outside the deleted scope appear.
    let outDirect   = blastResult.directImpact;
    let outIndirect = blastResult.indirectImpact;
    let outDepthMap = depthMap;
    let outPaths    = paths;
    let outConfMap  = confidenceMap;

    if (resolvedIntent.descriptor.changeType === 'delete' && resolvedIntent.symbols.length > 0) {
        // Collect the absolute file paths of every symbol being deleted.
        const deletedAbsFiles = new Set<string>(
            resolvedIntent.symbols
                .map(s => { const h = s.symbolId.lastIndexOf('#'); return h >= 0 ? s.symbolId.slice(0, h) : ''; })
                .filter(Boolean),
        );
        const isInDeletedFile = (id: string): boolean => {
            const h = id.lastIndexOf('#');
            return h >= 0 && deletedAbsFiles.has(id.slice(0, h));
        };
        outDirect   = outDirect.filter(id => !isInDeletedFile(id));
        outIndirect = outIndirect.filter(id => !isInDeletedFile(id));
        const fdm = new Map<string, number>();
        const fpm = new Map<string, string[][]>();
        const fcm = new Map<string, ResolvedConfidence>();
        for (const [id, d] of outDepthMap) {
            if (isInDeletedFile(id)) { continue; }
            fdm.set(id, d);
            const pp = outPaths.get(id);    if (pp) { fpm.set(id, pp); }
            const cc = outConfMap.get(id);  if (cc) { fcm.set(id, cc); }
        }
        outDepthMap = fdm;
        outPaths    = fpm;
        outConfMap  = fcm;
    }

    // ── Logging ───────────────────────────────────────────────────────────────
    console.log(
        `[RippleCheck][PredictiveEngine]` +
        ` roots=${bfsRoots.length}` +
        ` direct=${outDirect.length}` +
        ` indirect=${outIndirect.length}` +
        ` | confidence: high=${countConf(outConfMap, 'high')}` +
        ` medium=${countConf(outConfMap, 'medium')}` +
        ` low=${countConf(outConfMap, 'low')}` +
        ` | phantoms=${phantomIds.length}` +
        ` | resolvedRoots=${resolvedIntent.symbols.length}`,
    );

    return {
        roots:         blastResult.roots,
        directImpact:  outDirect,
        indirectImpact: outIndirect,
        depthMap:      outDepthMap,
        paths:         outPaths,
        stagedGraph:   shadowGraph,
        confidenceMap: outConfMap,
        phantomIds,
        isRelevant:    resolvedIntent.isRelevant,
        resolvedRoots: resolvedIntent.symbols,
        changeType:    resolvedIntent.descriptor.changeType,
    };
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Return a zero-impact `BlastRadiusResult` when there are no BFS roots.
 *
 * This happens when the resolver produced no symbols (or all were phantoms).
 * We still return a well-formed result so callers never have to null-check.
 */
function emptyBlastResult(roots: BlastRadiusResult['roots']): BlastRadiusResult {
    return {
        roots,
        directImpact:   [],
        indirectImpact: [],
        depthMap:       new Map(),
        paths:          new Map(),
    };
}

/** Count how many entries in `confidenceMap` equal `level`. */
function countConf(map: Map<string, ResolvedConfidence>, level: ResolvedConfidence): number {
    let n = 0;
    for (const v of map.values()) { if (v === level) { n++; } }
    return n;
}
