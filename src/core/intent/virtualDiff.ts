import { SymbolIndex } from '../indexing/symbolIndex';
import { SymbolEntry } from '../indexing/symbolExtractor';
import { DependencyGraph } from '../graph/types';
import {
    ImpactRoot,
    PropagationMode,
    RootReason,
    REASON_PRIORITY,
} from '../blast/blastRadiusEngine';
import { ResolvedIntent, IntentChangeType } from './types';

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/**
 * The synthetic equivalent of what `computeStagedBlastRadius` builds from a
 * real `git diff --cached`.
 *
 * Produced by `buildVirtualDiff`.
 * Consumed by `predictiveEngine.computePredictiveBlastRadius` (Step 4).
 */
export interface VirtualDiffResult {
    /**
     * Impact roots ready to pass directly to the BFS traversal engine.
     * Already deduplicated — one entry per symbolId, highest-priority reason wins.
     */
    roots: ImpactRoot[];

    /**
     * Shadow clone of the live symbol index, modified to reflect the described
     * change:
     *   - `delete` intent: the deleted symbol is absent from this clone.
     *   - `add` intent:    a phantom entry is present (for UI display only).
     *   - others:          identical to the live index.
     */
    shadowIndex: SymbolIndex;

    /**
     * Deep clone of the live dependency graph.
     * The predictive BFS runs on the live graph (because we need existing reverse
     * edges to find who currently depends on the changed symbols).
     * This clone is returned so the caller can persist or visualise the
     * "post-change" graph without touching live state.
     */
    shadowGraph: DependencyGraph;

    /**
     * IDs of any phantom symbols inserted for `add` intents.
     * These exist only in `shadowIndex`, never in the live index.
     * The predictive engine excludes them from BFS results.
     */
    phantomIds: string[];
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/** Deep-clone a DependencyGraph without touching the original Sets. */
function cloneGraph(graph: DependencyGraph): DependencyGraph {
    const cloneMap = (m: Map<string, Set<string>>): Map<string, Set<string>> => {
        const out = new Map<string, Set<string>>();
        for (const [k, v] of m) { out.set(k, new Set(v)); }
        return out;
    };
    return { forward: cloneMap(graph.forward), reverse: cloneMap(graph.reverse) };
}

// ---------------------------------------------------------------------------
// Root classification
// ---------------------------------------------------------------------------

/**
 * Map an `(IntentChangeType, affectsPublicApi)` pair to a blast-radius root
 * reason and propagation mode.
 *
 * | changeType          | affectsPublicApi | reason             | mode    |
 * |---------------------|------------------|--------------------|---------|
 * | delete              | (any)            | deleted            | deep    |
 * | modify/refactor/add | true             | signature-ripple   | deep    |
 * | modify/refactor/add | false            | body-change        | shallow |
 * | unknown             | true             | signature-ripple   | deep    |
 * | unknown             | false            | body-change        | shallow |
 *
 * `add` intent:
 *   The resolved symbols are the EXISTING code that will be modified to
 *   accommodate the new feature (e.g. "add auth middleware" → existing route
 *   handlers that will call the new middleware).  We treat them as modify.
 *   The new symbol itself has no existing callers → zero blast radius → no root.
 */
function classifyRoot(
    changeType: IntentChangeType,
    affectsPublicApi: boolean,
): { reason: RootReason; propagationMode: PropagationMode } | null {
    switch (changeType) {
        case 'delete':
            return { reason: 'deleted', propagationMode: 'deep' };

        case 'add':
        case 'modify':
        case 'refactor':
        case 'unknown':
        default:
            return affectsPublicApi
                ? { reason: 'signature-ripple', propagationMode: 'deep'    }
                : { reason: 'body-change',      propagationMode: 'shallow' };
    }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Construct a synthetic blast-radius input from a resolved intent descriptor,
 * bypassing the git index entirely.
 *
 * ## What this replaces
 *
 * In the real pipeline:
 *   `git diff --cached` → `analyzeStagedChanges` → rippleRoots + ghostSymbols
 *   `git diff --cached` → `getStagedDiffHunks`   → changedSymbolIds
 *
 * Here we skip all of that and directly produce `ImpactRoot[]` from the
 * symbols the resolver matched:
 *
 *   `delete`                       → deep root,    reason = 'deleted'
 *   `modify/add/refactor/unknown`
 *     affectsPublicApi = true      → deep root,    reason = 'signature-ripple'
 *     affectsPublicApi = false     → shallow root, reason = 'body-change'
 *
 * Deduplication uses the same priority ordering as `computeStagedBlastRadius`:
 *   deleted > signature-ripple > renamed > body-change
 *
 * @param resolvedIntent        Output of `resolveIntent` (Step 2).
 * @param symbolIndex           Live symbol index — never mutated.
 * @param graph                 Live dependency graph — never mutated.
 */
export function buildVirtualDiff(
    resolvedIntent: ResolvedIntent,
    symbolIndex: SymbolIndex,
    graph: DependencyGraph,
): VirtualDiffResult {
    const { descriptor, symbols } = resolvedIntent;
    const { changeType, affectsPublicApi } = descriptor;

    // Shadow copies — predictive analysis must never touch live state.
    const shadowIndex = new Map(symbolIndex);
    const shadowGraph = cloneGraph(graph);

    const candidates: ImpactRoot[] = [];
    const phantomIds: string[] = [];

    const classification = classifyRoot(changeType, affectsPublicApi);

    for (const sym of symbols) {
        // ── Special handling: 'delete' removes the symbol from the shadow index ──
        // The live graph still has its reverse edges so BFS can find dependents.
        if (changeType === 'delete') {
            shadowIndex.delete(sym.symbolId);
            candidates.push({ symbolId: sym.symbolId, propagationMode: 'deep', reason: 'deleted' });
            continue;
        }

        // ── Special handling: 'add' inserts a phantom for the NEW symbol ────
        // A brand-new symbol has no existing callers in the live graph, so the
        // phantom represents the thing being created (shown in the UI with a NEW
        // badge).  We derive it from the symbolHint that was NOT found in the live
        // index — i.e. it only exists in the LLM's description, not the codebase.
        //
        // The EXISTING resolved symbols (the code that will call / wire up the new
        // feature) are still classified below as modify — they're the real blast-
        // radius roots because they have actual reverse edges.
        if (changeType === 'add') {
            // Fall through to the modify classification below — do NOT create
            // a phantom from a resolved symbol (it's already real code).
            // Phantoms are added after this loop from unresolved hints.
        }

        // ── Standard case: modify / refactor / add-with-side-effects ───────────
        if (classification) {
            candidates.push({
                symbolId:        sym.symbolId,
                propagationMode: classification.propagationMode,
                reason:          classification.reason,
            });
        }
    }

    // ── For 'add' intent: create phantoms from symbolHints that had NO match ──
    // These represent the brand-new symbols being introduced.  They have no
    // reverse edges in the live graph, so they produce zero BFS impact — which
    // is correct.  We surface them in the UI with a "NEW" badge so the developer
    // can see what is being added alongside the blast radius of existing code.
    if (changeType === 'add') {
        const resolvedNames = new Set(symbols.map(s => s.name.toLowerCase()));
        for (const hint of descriptor.symbolHints) {
            if (resolvedNames.has(hint.toLowerCase())) { continue; } // already in live index
            const phantomId = `__phantom__#${hint}`;
            if (!shadowIndex.has(phantomId)) {
                const entry: SymbolEntry = {
                    id:            phantomId,
                    name:          hint,
                    kind:          'function',
                    filePath:      '',
                    startLine:     0,
                    endLine:       0,
                    startPos:      0,
                    endPos:        0,
                    isExported:    true,
                    parentId:      null,
                    signatureHash: '',
                };
                shadowIndex.set(phantomId, entry);
                phantomIds.push(phantomId);
            }
        }
    }

    // ── Deduplicate: same priority ordering as computeStagedBlastRadius ───────
    // deleted > signature-ripple > renamed > body-change
    const rootMap = new Map<string, ImpactRoot>();
    for (const candidate of candidates) {
        const existing = rootMap.get(candidate.symbolId);
        if (!existing || REASON_PRIORITY[candidate.reason] > REASON_PRIORITY[existing.reason]) {
            rootMap.set(candidate.symbolId, candidate);
        }
    }

    const roots = Array.from(rootMap.values());

    console.log(
        `[RippleCheck][VirtualDiff] changeType=${changeType}` +
        ` affectsPublicApi=${affectsPublicApi}` +
        ` | ${symbols.length} resolved symbol(s)` +
        ` → ${roots.length} root(s) (deep=${roots.filter(r => r.propagationMode === 'deep').length}` +
        `, shallow=${roots.filter(r => r.propagationMode === 'shallow').length})` +
        ` | ${phantomIds.length} phantom(s)`,
    );

    return { roots, shadowIndex, shadowGraph, phantomIds };
}
