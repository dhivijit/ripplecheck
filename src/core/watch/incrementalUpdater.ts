import * as vscode from 'vscode';
import { Project } from 'ts-morph';
import { SymbolIndex } from '../indexing/symbolIndex';
import { extractSymbols } from '../indexing/symbolExtractor';
import { walkSourceFile } from '../indexing/referenceWalker';
import { DependencyGraph } from '../graph/types';
import { snapshotSignatures, detectSignatureChanges, SignatureChangeResult } from '../analysis/signatureAnalyzer';
import { persistDependencyGraph } from '../graph/graphStore';
import { computeFileHash, saveFileHashes } from '../cache/fileHashStore';

// ---------------------------------------------------------------------------
// Step A + B — remove a file's symbols and their edges from the graph
// ---------------------------------------------------------------------------

/**
 * Erase all knowledge of `filePath` from the symbol index and dependency graph.
 *
 * For each symbol S that belongs to this file:
 *   - Remove every forward edge S → D  (and the corresponding reverse entry D → S)
 *   - Remove every reverse entry where other symbols had S as a dependency
 *     (i.e., forward edge O → S and reverse entry S → O both cleaned up)
 *   - Delete S from the symbol index
 */
export function removeFileFromGraph(
    filePath: string,
    symbolIndex: SymbolIndex,
    graph: DependencyGraph
): void {
    const fileSymbolIds: string[] = [];
    for (const [id, entry] of symbolIndex) {
        if (entry.filePath === filePath) {
            fileSymbolIds.push(id);
        }
    }

    for (const symbolId of fileSymbolIds) {
        // Remove forward edges this symbol made (and matching reverse entries)
        const deps = graph.forward.get(symbolId);
        if (deps) {
            for (const depId of deps) {
                const reverseSet = graph.reverse.get(depId);
                if (reverseSet) {
                    reverseSet.delete(symbolId);
                    if (reverseSet.size === 0) { graph.reverse.delete(depId); }
                }
            }
            graph.forward.delete(symbolId);
        }

        // Remove reverse edges pointing back to this symbol from other owners
        // (their forward edges to this symbol are now dangling — clean both)
        const owners = graph.reverse.get(symbolId);
        if (owners) {
            for (const ownerId of owners) {
                const forwardSet = graph.forward.get(ownerId);
                if (forwardSet) {
                    forwardSet.delete(symbolId);
                    if (forwardSet.size === 0) { graph.forward.delete(ownerId); }
                }
            }
            graph.reverse.delete(symbolId);
        }

        // Remove from symbol index
        symbolIndex.delete(symbolId);
    }
}

// ---------------------------------------------------------------------------
// Step C + D — reparse and re-index a single file
// ---------------------------------------------------------------------------

function refreshSourceFile(
    project: Project,
    fsPath: string,
    newContent: string | undefined
): ReturnType<Project['getSourceFiles']>[number] | undefined {
    let sourceFile = project.getSourceFile(fsPath);

    if (newContent !== undefined) {
        if (sourceFile) {
            // Refresh in-memory without touching disk (handles unsaved edits)
            sourceFile.replaceWithText(newContent);
        } else {
            sourceFile = project.createSourceFile(fsPath, newContent, { overwrite: true });
        }
    } else {
        if (sourceFile) {
            sourceFile.refreshFromFileSystemSync();
        } else {
            sourceFile = project.addSourceFileAtPath(fsPath);
        }
    }

    return sourceFile;
}

function reindexSourceFile(
    sourceFile: ReturnType<Project['getSourceFiles']>[number],
    symbolIndex: SymbolIndex
): void {
    const symbols = extractSymbols(sourceFile);
    for (const symbol of symbols) {
        symbolIndex.set(symbol.id, symbol);
    }
}

// ---------------------------------------------------------------------------
// Public handlers
// ---------------------------------------------------------------------------

/**
 * A file was edited (content changed in the editor).
 * `newContent` is the current in-memory text — may differ from disk.
 */
export function handleFileChanged(
    fsPath: string,
    newContent: string,
    project: Project,
    symbolIndex: SymbolIndex,
    graph: DependencyGraph,
    workspaceRootFsPath: string
): SignatureChangeResult {
    const t0 = Date.now();

    // Snapshot signatures BEFORE wiping so we can detect what changed
    const oldHashes = snapshotSignatures(fsPath, symbolIndex);

    // Step A + B: erase stale knowledge
    removeFileFromGraph(fsPath, symbolIndex, graph);

    // Step C: refresh source file with in-memory content
    const sourceFile = refreshSourceFile(project, fsPath, newContent);
    if (!sourceFile) {
        return { ripple: [], safe: [], added: [], removed: Array.from(oldHashes.keys()) };
    }

    // Step D: re-extract symbols and re-walk references
    reindexSourceFile(sourceFile, symbolIndex);
    walkSourceFile(sourceFile, symbolIndex, workspaceRootFsPath, graph);

    const changes = detectSignatureChanges(fsPath, oldHashes, symbolIndex);
    const elapsed = Date.now() - t0;
    console.log(
        `[RippleCheck] Incremental update (edit) — ${fsPath} — ${elapsed}ms ` +
        `| ripple: ${changes.ripple.length}, safe: ${changes.safe.length}, ` +
        `added: ${changes.added.length}, removed: ${changes.removed.length}`
    );
    return changes;
}

/**
 * A file was created on disk.
 */
export function handleFileCreated(
    fsPath: string,
    project: Project,
    symbolIndex: SymbolIndex,
    graph: DependencyGraph,
    workspaceRootFsPath: string
): void {
    const t0 = Date.now();

    // Step C: add new file to project from disk
    const sourceFile = refreshSourceFile(project, fsPath, undefined);
    if (!sourceFile) { return; }

    // Step D: index symbols and record references
    reindexSourceFile(sourceFile, symbolIndex);
    walkSourceFile(sourceFile, symbolIndex, workspaceRootFsPath, graph);

    console.log(`[RippleCheck] Incremental update (create) — ${fsPath} — ${Date.now() - t0}ms`);
}

/**
 * A file was deleted from disk.
 */
export function handleFileDeleted(
    fsPath: string,
    project: Project,
    symbolIndex: SymbolIndex,
    graph: DependencyGraph
): void {
    const t0 = Date.now();

    // Step A + B: erase all edges and symbols for this file
    removeFileFromGraph(fsPath, symbolIndex, graph);

    // Remove the source file from the ts-morph project
    const sourceFile = project.getSourceFile(fsPath);
    if (sourceFile) {
        project.removeSourceFile(sourceFile);
    }

    console.log(`[RippleCheck] Incremental update (delete) — ${fsPath} — ${Date.now() - t0}ms`);
}

/**
 * Full in-place rebuild — used after a git branch switch.
 *
 * Clears the symbol index and both graph maps, then re-analyses every source
 * file in the existing project. Yields to the event loop every 10 files so
 * the VSCode UI stays responsive during large-project rebuilds.
 *
 * The Maps are mutated in-place so all existing closure references stay valid.
 */
export async function rebuildInPlace(
    project: Project,
    symbolIndex: SymbolIndex,
    graph: DependencyGraph,
    workspaceRootFsPath: string,
    workspaceRoot: vscode.Uri,
): Promise<void> {
    const t0 = Date.now();

    symbolIndex.clear();
    graph.forward.clear();
    graph.reverse.clear();

    const yield_ = () => new Promise<void>(r => setImmediate(r));

    // Refresh all source files from disk
    let i = 0;
    for (const sf of project.getSourceFiles()) {
        try { sf.refreshFromFileSystemSync(); } catch { /* deleted on this branch — skip */ }
        if (++i % 20 === 0) { await yield_(); }
    }

    // Re-extract symbols
    i = 0;
    for (const sf of project.getSourceFiles()) {
        const symbols = extractSymbols(sf);
        for (const sym of symbols) { symbolIndex.set(sym.id, sym); }
        if (++i % 20 === 0) { await yield_(); }
    }

    // Re-walk references
    i = 0;
    for (const sf of project.getSourceFiles()) {
        walkSourceFile(sf, symbolIndex, workspaceRootFsPath, graph);
        if (++i % 20 === 0) { await yield_(); }
    }

    // ── Persist rebuilt state ─────────────────────────────────────────────────────
    // Without this the on-disk cache diverges from the in-memory state after
    // every git checkout / merge / reset.  The next startup would re-patch all
    // files even when switching back to a branch the cache already knows about.
    const newHashes = new Map<string, string>();
    for (const sf of project.getSourceFiles()) {
        const fp   = sf.getFilePath();
        const hash = computeFileHash(fp);
        if (hash) { newHashes.set(fp, hash); }
    }
    await Promise.all([
        persistDependencyGraph(graph, workspaceRoot),
        saveFileHashes(newHashes, workspaceRoot),
    ]);

    console.log(`[RippleCheck] Full rebuild complete — ${Date.now() - t0}ms`);
}
