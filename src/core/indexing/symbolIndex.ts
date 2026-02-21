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

/**
 * Return the most specific symbol whose line range contains `line`.
 * "Most specific" = smallest range (deepest node in the nesting hierarchy).
 *
 * Returns null when no indexed symbol covers that line in the file.
 */
export function findSymbolAtLine(
    symbolIndex: SymbolIndex,
    filePath: string,
    line: number,
): import('./symbolExtractor').SymbolEntry | null {
    let best: import('./symbolExtractor').SymbolEntry | null = null;
    let bestRange = Infinity;

    for (const entry of symbolIndex.values()) {
        if (entry.filePath !== filePath) { continue; }
        if (line >= entry.startLine && line <= entry.endLine) {
            const range = entry.endLine - entry.startLine;
            if (range < bestRange) {
                best = entry;
                bestRange = range;
            }
        }
    }

    return best;
}

/**
 * Return ALL symbols whose character range overlaps with [startPos, endPos].
 *
 * Overlap condition: symbol.startPos <= endPos && symbol.endPos >= startPos
 *
 * Unlike findSymbolAtLine, this returns multiple results — e.g. for a line like
 *   `const a = foo(), b = bar();`
 * both `a` and `b` will be returned if the diff range covers both declarators.
 *
 * @param symbolIndex  The live symbol index.
 * @param filePath     Absolute path of the file (must match SymbolEntry.filePath).
 * @param startPos     Inclusive start character offset.
 * @param endPos       Inclusive end character offset.
 */
export function findSymbolsInCharRange(
    symbolIndex: SymbolIndex,
    filePath: string,
    startPos: number,
    endPos: number,
): import('./symbolExtractor').SymbolEntry[] {
    const results: import('./symbolExtractor').SymbolEntry[] = [];
    for (const entry of symbolIndex.values()) {
        if (entry.filePath !== filePath) { continue; }
        if (entry.startPos <= endPos && entry.endPos >= startPos) {
            results.push(entry);
        }
    }
    return results;
}

/**
 * Convert a git-diff line range (1-based, inclusive) to absolute character
 * offsets that can be passed to findSymbolsInCharRange.
 *
 * The offsets span from the first character of `startLine` to the last
 * character of `endLine` (i.e. the newline itself is excluded from endPos).
 *
 * @param sourceText  Full text content of the file.
 * @param startLine   1-based first changed line (from git diff `@@ -l,n +l,n @@`).
 * @param endLine     1-based last changed line (inclusive).
 */
export function diffLinesToCharRange(
    sourceText: string,
    startLine: number,
    endLine: number,
): { startPos: number; endPos: number } {
    // Build the start offset of each line (0-indexed: lineStarts[0] = line 1).
    const lineStarts: number[] = [0];
    for (let i = 0; i < sourceText.length; i++) {
        if (sourceText[i] === '\n') {
            lineStarts.push(i + 1);
        }
    }

    const lineCount = lineStarts.length;
    const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

    const s = clamp(startLine - 1, 0, lineCount - 1); // 0-based index for startLine
    const e = clamp(endLine - 1, 0, lineCount - 1);   // 0-based index for endLine

    const startPos = lineStarts[s];
    // endPos = first char of the NEXT line minus 1 (last char of endLine, before \n)
    const endPos = (e + 1 < lineStarts.length)
        ? lineStarts[e + 1] - 1
        : sourceText.length - 1;

    return { startPos, endPos };
}
