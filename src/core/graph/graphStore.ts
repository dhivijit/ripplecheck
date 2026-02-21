import * as vscode from 'vscode';
import { DependencyGraph } from './types';

const GRAPH_CACHE_PATH = '.blastradius/graph.json';

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export async function persistDependencyGraph(
    graph: DependencyGraph,
    workspaceRoot: vscode.Uri,
    section: 'present' | 'future' = 'present',
): Promise<void> {
    const graphUri = vscode.Uri.joinPath(workspaceRoot, GRAPH_CACHE_PATH);

    // Read-modify-write: update only the requested section so the other
    // section is not clobbered by an unrelated persist call.
    let stored: Record<string, unknown> = {
        present: { forward: {}, reverse: {} },
        future:  { forward: {}, reverse: {} },
    };
    try {
        const bytes  = await vscode.workspace.fs.readFile(graphUri);
        const parsed = JSON.parse(new TextDecoder().decode(bytes));
        if (parsed.present) {
            stored = parsed;                    // new sectioned format
        } else if (parsed.forward) {
            stored.present = parsed;            // migrate old flat format
        }
    } catch { /* file does not exist yet — use defaults */ }

    (stored as any)[section] = {
        forward: serializeMap(graph.forward),
        reverse: serializeMap(graph.reverse),
    };

    const encoded = new TextEncoder().encode(JSON.stringify(stored, null, 2));
    await vscode.workspace.fs.writeFile(graphUri, encoded);
    console.log(`[RippleCheck] Dependency graph[${section}] persisted → ${graphUri.fsPath}`);
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

