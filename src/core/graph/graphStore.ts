import * as vscode from 'vscode';
import { DependencyGraph, BlastRadiusEntry } from './types';

const GRAPH_CACHE_PATH = '.blastradius/graph.json';

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export async function persistDependencyGraph(
    graph: DependencyGraph,
    workspaceRoot: vscode.Uri
): Promise<void> {
    const serializable = {
        forward: serializeMap(graph.forward),
        reverse: serializeMap(graph.reverse),
    };
    const graphUri = vscode.Uri.joinPath(workspaceRoot, GRAPH_CACHE_PATH);
    const encoded  = new TextEncoder().encode(JSON.stringify(serializable, null, 2));
    await vscode.workspace.fs.writeFile(graphUri, encoded);
    console.log(`[RippleCheck] Dependency graph persisted → ${graphUri.fsPath}`);
}

function serializeMap(map: Map<string, Set<string>>): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const [key, set] of map) {
        out[key] = Array.from(set);
    }
    return out;
}

// ---------------------------------------------------------------------------
// O(1) edge queries
// ---------------------------------------------------------------------------

/**
 * All symbols that directly reference the given symbol (reverse edge).
 * This is the "who depends on me" direction needed for blast-radius.
 * O(1) — reads directly from the pre-built reverse map.
 */
export function getDependents(graph: DependencyGraph, symbolId: string): string[] {
    return Array.from(graph.reverse.get(symbolId) ?? []);
}

/**
 * All symbols that the given symbol directly references (forward edge).
 * O(1) — reads directly from the forward map.
 */
export function getDependencies(graph: DependencyGraph, symbolId: string): string[] {
    return Array.from(graph.forward.get(symbolId) ?? []);
}

// ---------------------------------------------------------------------------
// Blast radius — BFS on reverse graph
// ---------------------------------------------------------------------------

/**
 * Compute all symbols impacted by a change to `startId`.
 *
 * Traversal follows reverse edges: from changed symbol upward through every
 * dependent, then dependents of dependents, tracking depth at each level.
 *
 * Returns a Map<symbolId, depth> where depth 1 = direct dependent.
 * The starting symbol itself is not included in the result.
 *
 * Time complexity: O(affected nodes + affected edges)
 */
export function computeBlastRadius(
    graph: DependencyGraph,
    startId: string
): Map<string, number> {
    const visited = new Map<string, number>(); // symbolId → depth
    const queue: Array<{ id: string; depth: number }> = [{ id: startId, depth: 0 }];

    while (queue.length > 0) {
        const { id, depth } = queue.shift()!;
        if (visited.has(id)) { continue; }
        visited.set(id, depth);

        const dependents = graph.reverse.get(id);
        if (dependents) {
            for (const depId of dependents) {
                if (!visited.has(depId)) {
                    queue.push({ id: depId, depth: depth + 1 });
                }
            }
        }
    }

    // Remove the starting symbol — it didn't change, it is the change origin
    visited.delete(startId);
    return visited;
}

/**
 * Convert a blast-radius map into a sorted list (nearest impact first).
 */
export function blastRadiusToList(result: Map<string, number>): BlastRadiusEntry[] {
    return Array.from(result.entries())
        .map(([symbolId, depth]) => ({ symbolId, depth }))
        .sort((a, b) => a.depth - b.depth);
}
