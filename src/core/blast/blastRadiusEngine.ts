import { Project } from 'ts-morph';
import { SymbolIndex, findSymbolsInCharRange, diffLinesToCharRange } from '../indexing/symbolIndex';
import { DependencyGraph } from '../graph/types';
import { analyzeStagedChanges } from '../git/stagedAnalyzer';
import { getStagedDiffHunks } from '../git/diffParser';
import { getStagedFiles, readStagedContent } from '../git/stagedSnapshot';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PropagationMode = 'shallow' | 'deep';

/**
 * Why a symbol was chosen as a blast-radius root.
 *
 * - `body-change`       : Lines inside the symbol changed but its public API
 *                         (signature hash) did not.  Only direct callers see
 *                         risk.  Propagation stops at depth 1.
 * - `signature-ripple`  : The symbol's public API changed (return type, param
 *                         types, etc.).  Every transitive dependent is at risk.
 *                         Propagation is unlimited.
 * - `deleted`           : The symbol no longer exists in the staged snapshot.
 *                         All callers are now broken.  Propagation is unlimited.
 * - `renamed`           : The file containing the symbol was renamed / moved.
 *                         Module-path identity changed, so every consumer that
 *                         has not yet updated its import is broken.  All symbols
 *                         in the new file are deep roots; the old path's symbols
 *                         become ghosts and propagate independently.
 *                         Propagation is unlimited.
 */
export type RootReason = 'body-change' | 'signature-ripple' | 'deleted' | 'renamed';

/**
 * Priority used during root deduplication.  When the same symbol appears in
 * multiple source sets (e.g. both a signature-ripple AND a body-change because
 * a hunk touched its signature), the highest-priority reason wins.
 *
 * deleted > signature-ripple > renamed > body-change
 *
 * Exported so `virtualDiff.ts` and `predictiveEngine.ts` can reuse the same
 * deduplication logic without duplicating the priority table.
 */
export const REASON_PRIORITY: Record<RootReason, number> = {
    'deleted':          3,
    'signature-ripple': 2,
    'renamed':          1,
    'body-change':      0,
};

export interface ImpactRoot {
    symbolId: string;
    propagationMode: PropagationMode;
    reason: RootReason;
}

export interface BlastRadiusResult {
    /** Every symbol that seeded the traversal (the origin set). */
    roots: ImpactRoot[];

    /**
     * Symbols at depth 1 — directly depend on at least one root.
     * Reported regardless of whether the root is shallow or deep.
     */
    directImpact: string[];

    /**
     * Symbols at depth ≥ 2 — transitively impacted.
     * Only populated when the path passes through a deep root.
     * Nodes reachable exclusively via shallow roots are NOT included here.
     */
    indirectImpact: string[];

    /**
     * Minimum graph distance from any root for every impacted symbol.
     * Roots themselves are excluded (depth 0 entries are removed).
     */
    depthMap: Map<string, number>;

    /**
     * All explanation paths for every impacted symbol, grouped by root.
     * Each outer array contains one path per root that can reach the symbol.
     * Each inner array is ordered: [root, …intermediates…, impactedSymbol].
     *
     * A symbol reachable from multiple roots has multiple entries — all are
     * preserved so callers can display the richest explanation rather than
     * an arbitrarily-chosen single path.
     */
    paths: Map<string, string[][]>;
    /**
     * The dependency graph as it will look after the staged changes are
     * committed.  Only set by `computeStagedBlastRadius`; `traverseImpact`
     * leaves this undefined.
     *
     * Pass to `persistDependencyGraph(stagedGraph, workspaceRoot, 'future')`
     * to write the future section of graph.json so the webview can compare
     * present vs. post-commit structure side-by-side.
     */
    stagedGraph?: DependencyGraph;}

// ---------------------------------------------------------------------------
// Shadow-copy helpers
// ---------------------------------------------------------------------------

/**
 * Deep-clone a DependencyGraph so staged analysis can mutate it freely
 * without touching the live workspace state.
 *
 * SymbolIndex values (SymbolEntry objects) are treated as immutable, so a
 * shallow Map clone is sufficient for the index.  The graph Sets ARE mutated
 * by walkSourceFile, so every Set must be copied.
 */
function cloneGraph(graph: DependencyGraph): DependencyGraph {
    const cloneMap = (m: Map<string, Set<string>>): Map<string, Set<string>> => {
        const out = new Map<string, Set<string>>();
        for (const [k, v] of m) { out.set(k, new Set(v)); }
        return out;
    };
    return { forward: cloneMap(graph.forward), reverse: cloneMap(graph.reverse) };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Phase 5 — compute the blast radius of all currently staged changes.
 *
 * ## Flow
 *
 * 1. **Staged snapshot analysis** (`analyzeStagedChanges`):
 *    Reads the git-index content of each staged file, re-analyzes symbols,
 *    detects signature changes, and updates the live symbol index + graph.
 *    Returns ripple roots (API changes) and ghost symbols (deletions).
 *
 * 2. **Diff-hunk → symbol mapping** (`getStagedDiffHunks` + `findSymbolsInCharRange`):
 *    Parses `git diff --cached --unified=0` to get exact changed-line ranges,
 *    converts them to character offsets using the staged file content, then
 *    looks up every overlapping symbol in the now-updated index.
 *
 * 3. **Impact-root classification**:
 *    - `deleted`          → deep  (ghost symbols)
 *    - `signature-ripple` → deep  (API changed)
 *    - `body-change`      → shallow (implementation changed only)
 *
 * 4. **Multi-source BFS** (two passes):
 *    - Pass 1: unlimited BFS from all deep roots.
 *    - Pass 2: depth-1 expansion from shallow roots (improves depth if BFS
 *              found the same node deeper).
 *
 * 5. **Path reconstruction** from parentMap.
 *
 * @param project              The live ts-morph project.
 * @param symbolIndex          The live symbol index — read-only, never mutated.
 * @param graph                The live dependency graph — used for BFS traversal only.
 * @param workspaceRootFsPath  Absolute path to the repo / workspace root.
 */
export async function computeStagedBlastRadius(
    project: Project,
    symbolIndex: SymbolIndex,
    graph: DependencyGraph,
    workspaceRootFsPath: string,
): Promise<BlastRadiusResult> {
    // ── Shadow copies — staged analysis must NEVER touch live state ──────────
    //
    // A developer can stage changes, inspect the blast radius, then unstage.
    // Mutating the live symbolIndex/graph during staged analysis would leave the
    // workspace model incorrect after an unstage.  All re-indexing and edge
    // updates are confined to these disposable clones.
    //
    // SymbolEntry objects are immutable by convention  → shallow Map clone.
    // Graph Sets are mutated by walkSourceFile          → full deep clone.
    const shadowIndex = new Map(symbolIndex);
    const shadowGraph = cloneGraph(graph);

    // ── Step 1: analyze staged snapshot (on shadow copies) ──────────────────
    // Reads git-index content for every staged file, re-parses AST, updates
    // shadowIndex and shadowGraph to reflect what will actually be committed.
    const stagedResult = await analyzeStagedChanges(
        project, shadowIndex, shadowGraph, workspaceRootFsPath,
    );

    const rippleRootSet = new Set(stagedResult.rippleRoots);
    const ghostSet      = new Set(stagedResult.ghostSymbols);

    // Collect new-path absolute paths for every staged rename or copy.
    // git diff --cached --name-status (already called inside analyzeStagedChanges)
    // is re-read here so we don't need to thread extra data through the return type.
    // The call is fast (git reads from the in-memory index).
    const allStagedFiles   = await getStagedFiles(workspaceRootFsPath);
    const renamedNewPaths  = new Set(
        allStagedFiles
            .filter(e => e.status === 'R' || e.status === 'C')
            .map(e => e.absolutePath),
    );

    // ── Step 2: diff-hunk → changed symbols ─────────────────────────────────
    // Parse `git diff --cached --unified=0` and map each changed line range to
    // the symbols that overlap it in the staged index.
    const hunks = await getStagedDiffHunks(workspaceRootFsPath);

    // Group hunks by file to call readStagedContent once per file (not per hunk).
    const hunksByFile = new Map<string, typeof hunks>();
    for (const hunk of hunks) {
        let list = hunksByFile.get(hunk.absoluteFilePath);
        if (!list) { list = []; hunksByFile.set(hunk.absoluteFilePath, list); }
        list.push(hunk);
    }

    const changedSymbolIds = new Set<string>();

    for (const [absPath, fileHunks] of hunksByFile) {
        // Read staged content for this file (ground truth: what will be committed).
        const stagedContent = await readStagedContent(workspaceRootFsPath, absPath);
        if (stagedContent === null) { continue; }

        // Collect all symbols touched by any hunk in this file into a local set
        // first.  Multiple hunks can map to the same symbol (e.g. two partial-stage
        // edits inside one function body, or overlapping hunk boundaries around a
        // short function).  Deduplicating per-file before merging into the global
        // set keeps changedSymbolIds clean and makes the intent explicit.
        const fileSymbolIds = new Set<string>();
        for (const hunk of fileHunks) {
            const endLine   = hunk.newStartLine + hunk.newLineCount - 1;
            const { startPos, endPos } = diffLinesToCharRange(stagedContent, hunk.newStartLine, endLine);
            // shadowIndex — staged symbol positions, not live positions.
            const symbols = findSymbolsInCharRange(shadowIndex, absPath, startPos, endPos);
            for (const sym of symbols) { fileSymbolIds.add(sym.id); }
        }
        for (const id of fileSymbolIds) { changedSymbolIds.add(id); }
    }

    // ── Step 3: collect all root candidates, then deduplicate ────────────────
    //
    // Each source set is iterated unconditionally; all candidates are pushed
    // into a flat array.  A single deduplication pass then keeps the
    // highest-priority reason for each symbolId:
    //
    //   deleted > signature-ripple > renamed > body-change
    //
    // Separating collection from deduplication means adding a new source never
    // requires touching priority-guard logic scattered across multiple loops.
    const candidates: ImpactRoot[] = [];

    // Ghost symbols — deleted or renamed out of existence.  Deep.
    for (const id of ghostSet) {
        candidates.push({ symbolId: id, propagationMode: 'deep', reason: 'deleted' });
    }

    // Signature-ripple symbols — API changed.  Deep.
    for (const id of rippleRootSet) {
        candidates.push({ symbolId: id, propagationMode: 'deep', reason: 'signature-ripple' });
    }

    // Renamed-file symbols — all symbols whose file path is the rename target.
    for (const [id, entry] of shadowIndex) {
        if (renamedNewPaths.has(entry.filePath)) {
            candidates.push({ symbolId: id, propagationMode: 'deep', reason: 'renamed' });
        }
    }

    // Body-change symbols — touched lines but API fingerprint unchanged.  Shallow.
    for (const id of changedSymbolIds) {
        candidates.push({ symbolId: id, propagationMode: 'shallow', reason: 'body-change' });
    }

    // Deduplicate: one entry per symbolId, highest REASON_PRIORITY wins.
    const rootMap = new Map<string, ImpactRoot>();
    for (const candidate of candidates) {
        const existing = rootMap.get(candidate.symbolId);
        if (!existing || REASON_PRIORITY[candidate.reason] > REASON_PRIORITY[existing.reason]) {
            rootMap.set(candidate.symbolId, candidate);
        }
    }

    const roots = Array.from(rootMap.values());

    // ── Step 4 + 5: BFS on the LIVE graph ───────────────────────────────────
    // The staged snapshot tells us WHAT changed; the live graph tells us WHO
    // depends on it right now.  We never pass shadowGraph here.
    //
    // shadowGraph is returned as stagedGraph so the caller can persist it
    // as the 'future' section of graph.json via persistDependencyGraph.
    return { ...traverseImpact(roots, graph), stagedGraph: shadowGraph };
}

// ---------------------------------------------------------------------------
// In-editor (live) blast radius
// ---------------------------------------------------------------------------

/**
 * Compute blast radius from **live in-editor** changes without requiring
 * anything to be staged in git.
 *
 * Unlike `computeStagedBlastRadius` (which reads `git diff --cached`), this
 * function works entirely from the already-updated live graph and the
 * pre-removal dependent snapshot captured in `handleFileChanged`.
 *
 * ## Why a temp graph for deleted symbols?
 *
 * `removeFileFromGraph` cleans up reverse edges before this function is called.
 * If we ran BFS on the live graph from a deleted symbol ID, `graph.reverse.get(id)`
 * would return undefined and we'd find no dependents.
 *
 * We restore the missing reverse edges into a shallow clone of the live graph
 * so that `traverseImpact` can BFS through them normally, then discard the clone.
 *
 * @param rippleIds           IDs of symbols whose signature changed in the editor.
 * @param removedIds          IDs of symbols deleted from the file in the editor.
 * @param preRemovalDependents Map of removedId → [dependentIds] captured before removal.
 * @param graph               The live dependency graph (not mutated).
 */
export function computeInEditorBlastRadius(
    rippleIds: string[],
    removedIds: string[],
    preRemovalDependents: Map<string, string[]>,
    graph: DependencyGraph,
): BlastRadiusResult {
    const roots: ImpactRoot[] = [
        ...rippleIds.map(id => ({
            symbolId: id,
            propagationMode: 'deep' as const,
            reason: 'signature-ripple' as const,
        })),
        ...removedIds.filter(id => preRemovalDependents.has(id)).map(id => ({
            symbolId: id,
            propagationMode: 'deep' as const,
            reason: 'deleted' as const,
        })),
    ];

    if (roots.length === 0) {
        return { roots: [], directImpact: [], indirectImpact: [], depthMap: new Map(), paths: new Map() };
    }

    // Build a shallow-clone of the live graph and inject the pre-removal reverse
    // edges back so BFS from deleted roots can find their dependents.
    const tempReverse = new Map(graph.reverse);
    for (const [removedId, deps] of preRemovalDependents) {
        if (deps.length > 0) {
            tempReverse.set(removedId, new Set(deps));
        }
    }
    const tempGraph: DependencyGraph = { forward: graph.forward, reverse: tempReverse };

    return traverseImpact(roots, tempGraph);
}

// ---------------------------------------------------------------------------
// Traversal
// ---------------------------------------------------------------------------

/**
 * Separate-set traversal implementing the correct propagation rules:
 *
 *   deepReachable    = full BFS from all deep roots (unlimited depth)
 *   shallowReachable = direct neighbors of shallow roots only (one hop)
 *
 * Classification:
 *   - in deepReachable                    → indirect  (deep always wins)
 *   - in shallowReachable but NOT deep    → direct
 *   - in both                             → indirect  (deep wins, shallow never
 *                                            downgrades an API-ripple node)
 *
 * This guarantees that staging a shallow body-change alongside a deep API
 * change never reclassifies a transitively-impacted symbol as "direct".
 *
 * Exported so `predictiveEngine.ts` can feed a virtual diff into the same BFS
 * without duplicating traversal logic.
 */
export function traverseImpact(roots: ImpactRoot[], graph: DependencyGraph): BlastRadiusResult {
    const rootSet      = new Set(roots.map(r => r.symbolId));
    const deepRoots    = roots.filter(r => r.propagationMode === 'deep');
    const shallowRoots = roots.filter(r => r.propagationMode === 'shallow');

    // ── Pass 1: per-root BFS from each deep root ─────────────────────────────
    // Run BFS independently for each deep root so that every reachable node
    // retains a complete parent chain back to that specific root.  This enables
    // full path reconstruction even when the same symbol is reachable from
    // multiple roots (e.g. both `service` and `cache` changed their API).
    //
    // globalDepthMap is still shared and updated with the minimum depth across
    // all roots so that Pass 2's "deep wins" guard remains correct.
    const deepDepthMap      = new Map<string, number>();
    const perRootParentMaps = new Map<string, Map<string, string | null>>();
    for (const root of deepRoots) {
        const perRootParent = new Map<string, string | null>();
        bfsUnlimited(root.symbolId, graph, deepDepthMap, perRootParent);
        perRootParentMaps.set(root.symbolId, perRootParent);
    }

    // ── Pass 2: one-hop expansion from shallow roots ─────────────────────────
    // Collect direct neighbors only.  Nodes already reached by Pass 1 are
    // deliberately excluded: deep reachability always wins over shallow.
    const shallowParentMap = new Map<string, string>(); // depId → shallow root id
    for (const root of shallowRoots) {
        const dependents = graph.reverse.get(root.symbolId);
        if (!dependents) { continue; }
        for (const depId of dependents) {
            if (rootSet.has(depId))           { continue; } // skip other roots
            if (deepDepthMap.has(depId))      { continue; } // deep wins — not direct
            if (!shallowParentMap.has(depId)) {
                shallowParentMap.set(depId, root.symbolId);
            }
        }
    }

    // ── Build unified depth map ───────────────────────────────────────────────
    // parentMap is no longer needed here — per-root parent chains live in
    // perRootParentMaps and shallowParentMap, which buildPaths reads directly.
    const depthMap = new Map<string, number>();

    // Deep-reachable nodes (exclude the roots themselves at depth 0)
    for (const [id, depth] of deepDepthMap) {
        if (rootSet.has(id)) { continue; }
        depthMap.set(id, depth);
    }

    // Shallow-only nodes (already excluded from deepDepthMap by the guard above)
    for (const id of shallowParentMap.keys()) {
        depthMap.set(id, 1);
    }

    // ── Classify ──────────────────────────────────────────────────────────────
    // Classify by actual graph distance from any root, regardless of root type:
    //   depth 1 → directImpact   (immediate callers)
    //   depth ≥ 2 → indirectImpact (transitive callers)
    //
    // This matches user expectations: a depth-1 caller of an API-changed symbol
    // is a "direct" dependent; only nodes further down the chain are "indirect".
    // Shallow roots never populate depth ≥ 2 (BFS stops at 1 hop), so
    // indirectImpact naturally remains empty for pure body-only changes.
    const directImpact: string[]   = [];
    const indirectImpact: string[] = [];
    for (const [id, depth] of depthMap) {
        if (depth === 1) { directImpact.push(id);   }
        else             { indirectImpact.push(id); }
    }

    // ── Reconstruct all explanation paths ─────────────────────────────────────
    const paths = buildPaths(depthMap, perRootParentMaps, shallowParentMap);

    return { roots, directImpact, indirectImpact, depthMap, paths };
}

// ---------------------------------------------------------------------------
// BFS helpers
// ---------------------------------------------------------------------------

/**
 * Single-source FIFO BFS from `rootId`, fanning out through reverse edges
 * without depth limit.
 *
 * `perRootParent` records the immediate parent of every visited node within
 * THIS root's traversal only.  This lets callers reconstruct the full path
 * from `rootId` to any reachable node independently per root.
 *
 * `globalDepthMap` is a shared map updated with the minimum depth seen across
 * ALL roots.  It is used by the caller for:
 *   - classification (depth 1 = direct, depth ≥ 2 = indirect)
 *   - the "deep wins" guard in Pass 2 that prevents shallow roots from
 *     overriding nodes already reached by any deep root
 */
function bfsUnlimited(
    rootId: string,
    graph: DependencyGraph,
    globalDepthMap: Map<string, number>,
    perRootParent: Map<string, string | null>,
): void {
    // localDepth tracks visited nodes within this root's own BFS, preventing
    // cycles and ensuring the shortest local path is recorded per-root.
    const localDepth = new Map<string, number>();
    const queue: Array<{ id: string; depth: number }> = [];

    localDepth.set(rootId, 0);
    perRootParent.set(rootId, null);
    queue.push({ id: rootId, depth: 0 });
    if ((globalDepthMap.get(rootId) ?? Infinity) > 0) { globalDepthMap.set(rootId, 0); }

    while (queue.length > 0) {
        const { id, depth } = queue.shift()!;
        if ((localDepth.get(id) ?? Infinity) < depth) { continue; }

        const dependents = graph.reverse.get(id);
        if (!dependents) { continue; }

        for (const depId of dependents) {
            if (!localDepth.has(depId)) {
                localDepth.set(depId, depth + 1);
                perRootParent.set(depId, id);
                queue.push({ id: depId, depth: depth + 1 });

                // Update the shared minimum-depth map across all roots.
                if ((globalDepthMap.get(depId) ?? Infinity) > depth + 1) {
                    globalDepthMap.set(depId, depth + 1);
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Path reconstruction
// ---------------------------------------------------------------------------

/**
 * Reconstruct all explanation paths for every impacted symbol.
 *
 * For each deep root, walk its `perRootParent` map backward from the impacted
 * symbol to produce [rootId, …intermediates…, symbolId].  A node reachable
 * from N deep roots yields N paths.  Shallow-root nodes yield one additional
 * two-element path [shallowRootId, symbolId].
 *
 * Because each per-root BFS stores a complete parent chain back to its own
 * root (root → null sentinel), the walk always terminates cleanly.
 */
function buildPaths(
    depthMap: Map<string, number>,
    perRootParentMaps: Map<string, Map<string, string | null>>,
    shallowParentMap: Map<string, string>,
): Map<string, string[][]> {
    const paths = new Map<string, string[][]>();

    for (const id of depthMap.keys()) {
        const allPaths: string[][] = [];

        // One path per deep root that reaches this node.
        for (const [, parentMap] of perRootParentMaps) {
            if (!parentMap.has(id)) { continue; } // root does not reach this node

            const path: string[] = [id];
            let cur: string | null | undefined = parentMap.get(id);

            while (cur !== null && cur !== undefined) {
                path.unshift(cur);
                cur = parentMap.get(cur) ?? null;
            }

            allPaths.push(path);
        }

        // Shallow-root path: always exactly [shallowRoot, id].
        const shallowParent = shallowParentMap.get(id);
        if (shallowParent !== undefined) {
            allPaths.push([shallowParent, id]);
        }

        if (allPaths.length > 0) {
            paths.set(id, allPaths);
        }
    }

    return paths;
}
