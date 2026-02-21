import * as vscode from 'vscode';
import { Project } from 'ts-morph';
import { extractSymbols, SymbolEntry } from './symbolExtractor';

export type SymbolIndex = Map<string, SymbolEntry>;

const SYMBOLS_CACHE_PATH = '.blastradius/symbols.json';

export async function buildSymbolIndex(
    project: Project,
    workspaceRoot: vscode.Uri
): Promise<SymbolIndex> {
    const index: SymbolIndex = new Map();
    const sourceFiles = project.getSourceFiles();

    console.log(`[RippleCheck] Building symbol index across ${sourceFiles.length} source file(s)...`);

    for (const sourceFile of sourceFiles) {
        const symbols = extractSymbols(sourceFile);
        for (const symbol of symbols) {
            index.set(symbol.id, symbol);
        }
    }

    console.log(`[RippleCheck] Symbol index complete — ${index.size} symbol(s) indexed`);

    await persistSymbolIndex(index, workspaceRoot);

    return index;
}

async function persistSymbolIndex(
    index: SymbolIndex,
    workspaceRoot: vscode.Uri
): Promise<void> {
    const symbolsUri = vscode.Uri.joinPath(workspaceRoot, SYMBOLS_CACHE_PATH);
    const serializable = Object.fromEntries(index);
    const encoded = new TextEncoder().encode(JSON.stringify(serializable, null, 2));
    await vscode.workspace.fs.writeFile(symbolsUri, encoded);
    console.log(`[RippleCheck] Symbol index persisted → ${symbolsUri.fsPath}`);
}
