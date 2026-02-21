import * as vscode from 'vscode';
import { SymbolEntry } from '../indexing/symbolExtractor';
import { SymbolIndex } from '../indexing/symbolIndex';
import { DependencyGraph } from '../graph/types';

export interface CacheMetadata {
    projectHash: string;
    createdAt: string;
    version: string;
}

async function readJson<T>(workspaceRoot: vscode.Uri, relPath: string): Promise<T | null> {
    try {
        const uri = vscode.Uri.joinPath(workspaceRoot, relPath);
        const bytes = await vscode.workspace.fs.readFile(uri);
        const text = new TextDecoder().decode(bytes).trim();
        if (!text || text === '{}' || text === '[]') { return null; }
        return JSON.parse(text) as T;
    } catch {
        return null;
    }
}

export async function loadCachedSymbolIndex(workspaceRoot: vscode.Uri): Promise<SymbolIndex | null> {
    const raw = await readJson<Record<string, SymbolEntry>>(workspaceRoot, '.blastradius/symbols.json');
    if (!raw || Object.keys(raw).length === 0) { return null; }
    return new Map(Object.entries(raw));
}

export async function loadCachedDependencyGraph(workspaceRoot: vscode.Uri): Promise<DependencyGraph | null> {
    const raw = await readJson<{
        forward: Record<string, string[]>;
        reverse: Record<string, string[]>;
    }>(workspaceRoot, '.blastradius/graph.json');
    if (!raw || !raw.forward) { return null; }
    return {
        forward: new Map(Object.entries(raw.forward).map(([k, v]) => [k, new Set(v)])),
        reverse: new Map(Object.entries(raw.reverse ?? {}).map(([k, v]) => [k, new Set(v)])),
    };
}

export async function loadCachedMetadata(workspaceRoot: vscode.Uri): Promise<CacheMetadata | null> {
    const raw = await readJson<CacheMetadata>(workspaceRoot, '.blastradius/metadata.json');
    if (!raw || !raw.projectHash || !raw.createdAt) { return null; }
    return raw;
}
