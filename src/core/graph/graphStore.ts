import * as vscode from 'vscode';
import { ReferenceGraph } from '../indexing/referenceWalker';

const GRAPH_CACHE_PATH = '.blastradius/graph.json';

export async function persistReferenceGraph(
    graph: ReferenceGraph,
    workspaceRoot: vscode.Uri
): Promise<void> {
    const serializable: Record<string, string[]> = {};
    for (const [fromId, toIds] of graph) {
        serializable[fromId] = Array.from(toIds);
    }
    const graphUri = vscode.Uri.joinPath(workspaceRoot, GRAPH_CACHE_PATH);
    const encoded  = new TextEncoder().encode(JSON.stringify(serializable, null, 2));
    await vscode.workspace.fs.writeFile(graphUri, encoded);
    console.log(`[RippleCheck] Reference graph persisted → ${graphUri.fsPath}`);
}

/**
 * All symbols that directly reference the given symbol.
 * This is the reverse edge — the "who calls me" direction used for blast-radius.
 */
export function getDependents(graph: ReferenceGraph, symbolId: string): string[] {
    const result: string[] = [];
    for (const [fromId, toIds] of graph) {
        if (toIds.has(symbolId)) { result.push(fromId); }
    }
    return result;
}

/**
 * All symbols that the given symbol directly references (outgoing edges).
 */
export function getDependencies(graph: ReferenceGraph, symbolId: string): string[] {
    return Array.from(graph.get(symbolId) ?? []);
}
