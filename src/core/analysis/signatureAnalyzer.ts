import { SymbolIndex } from '../indexing/symbolIndex';
import { DependencyGraph } from '../graph/types';

export interface SignatureChangeResult {
    /** Symbols whose public API (signature) changed — these cause ripple impact. */
    ripple: string[];
    /** Symbols that exist in both old and new but are unchanged — safe edits. */
    safe: string[];
    /** Symbols newly added to this file. */
    added: string[];
    /** Symbols removed from this file. */
    removed: string[];
}

/**
 * Snapshot the signature hashes for all symbols belonging to `filePath`
 * BEFORE a re-analysis wipes them from the index.
 *
 * Call this before `removeFileFromGraph` to preserve the old state for comparison.
 */
export function snapshotSignatures(filePath: string, symbolIndex: SymbolIndex): Map<string, string> {
    const snap = new Map<string, string>();
    for (const [id, entry] of symbolIndex) {
        if (entry.filePath === filePath) {
            snap.set(id, entry.signatureHash);
        }
    }
    return snap;
}

/**
 * Compare pre-analysis hashes against the freshly-indexed symbols for a file.
 *
 * @param filePath  The file that was re-analysed.
 * @param oldHashes Snapshot taken before the file was wiped (from snapshotSignatures).
 * @param newIndex  The full symbol index AFTER re-analysis.
 */
export function detectSignatureChanges(
    filePath: string,
    oldHashes: Map<string, string>,
    newIndex: SymbolIndex,
): SignatureChangeResult {
    const result: SignatureChangeResult = { ripple: [], safe: [], added: [], removed: [] };

    for (const [id, entry] of newIndex) {
        if (entry.filePath !== filePath) { continue; }
        const oldHash = oldHashes.get(id);
        if (oldHash === undefined) {
            result.added.push(id);
        } else if (oldHash !== entry.signatureHash) {
            result.ripple.push(id);
        } else {
            result.safe.push(id);
        }
    }

    for (const id of oldHashes.keys()) {
        if (!newIndex.has(id)) {
            result.removed.push(id);
        }
    }

    return result;
}

/**
 * Find "ghost symbols" — IDs present in the dependency graph but absent from
 * the live symbol index after a file has been re-analysed or deleted.
 *
 * A ghost arises when a symbol is renamed, deleted, or moved to another file.
 * Because other symbols in the graph still hold edges pointing TO the ghost,
 * every direct caller/dependent is now broken and should be treated as a
 * blast-radius root for Phase 4 impact reporting.
 *
 * @param graph        The live dependency graph (forward + reverse).
 * @param symbolIndex  The symbol index AFTER re-analysis.
 * @returns Array of symbol IDs that exist in the graph but not in the index.
 */
export function detectGhostSymbols(
    graph: DependencyGraph,
    symbolIndex: SymbolIndex,
): string[] {
    const ghosts: string[] = [];
    // We check the reverse map because every reachable symbol — even leaf
    // nodes that nothing depends ON — has an entry in reverse (possibly empty).
    // Using forward.keys() would miss symbols that are only dependents, not
    // depended-upon.  Checking BOTH maps avoids any coverage gap.
    const allIds = new Set([...graph.forward.keys(), ...graph.reverse.keys()]);
    for (const id of allIds) {
        if (!symbolIndex.has(id)) {
            ghosts.push(id);
        }
    }
    return ghosts;
}
