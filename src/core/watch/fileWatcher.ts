import * as vscode from 'vscode';
import { Project } from 'ts-morph';
import { SymbolIndex } from '../indexing/symbolIndex';
import { DependencyGraph } from '../graph/types';
import {
    handleFileChanged,
    handleFileCreated,
    handleFileDeleted,
    rebuildInPlace,
} from './incrementalUpdater';

// ---------------------------------------------------------------------------
// Debounce helper
// ---------------------------------------------------------------------------

function debounce<T extends (...args: any[]) => void>(fn: T, delayMs: number): T {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return ((...args: Parameters<T>) => {
        if (timer !== undefined) { clearTimeout(timer); }
        timer = setTimeout(() => fn(...args), delayMs);
    }) as T;
}

// ---------------------------------------------------------------------------
// File filter
// ---------------------------------------------------------------------------

function isWatchedFile(fsPath: string, workspaceRootFsPath: string): boolean {
    return (
        fsPath.startsWith(workspaceRootFsPath) &&
        !fsPath.includes('/node_modules/') &&
        !fsPath.includes('/.blastradius/') &&
        /\.(ts|tsx|js|jsx)$/.test(fsPath)
    );
}

// ---------------------------------------------------------------------------
// Async background rebuild with status bar
// ---------------------------------------------------------------------------

function triggerRebuild(
    project: Project,
    symbolIndex: SymbolIndex,
    graph: DependencyGraph,
    rootFsPath: string,
    reason: string
): void {
    console.log(`[RippleCheck] ${reason} — starting background rebuild...`);
    const promise = rebuildInPlace(project, symbolIndex, graph, rootFsPath)
        .then(() => vscode.window.setStatusBarMessage('$(check) RippleCheck: ready', 3000))
        .catch(e => {
            console.error('[RippleCheck] Rebuild failed:', e);
            vscode.window.setStatusBarMessage('$(error) RippleCheck: rebuild failed', 5000);
        });
    vscode.window.setStatusBarMessage('$(loading~spin) RippleCheck: rebuilding…', promise);
}

// ---------------------------------------------------------------------------
// Public registration
// ---------------------------------------------------------------------------

export function registerFileWatcher(
    project: Project,
    symbolIndex: SymbolIndex,
    graph: DependencyGraph,
    workspaceRoot: vscode.Uri,
    context: vscode.ExtensionContext
): void {
    const rootFsPath = workspaceRoot.fsPath;

    // --- Track files recently touched by the editor so we can skip them in
    //     the external FS watcher (avoids double-processing editor saves). ---
    const editorSavedFiles = new Map<string, number>(); // fsPath → save timestamp
    const EDITOR_SAVE_WINDOW_MS = 5_000;

    function markEditorSaved(fsPath: string): void {
        editorSavedFiles.set(fsPath, Date.now());
    }
    function wasEditorSaved(fsPath: string): boolean {
        const ts = editorSavedFiles.get(fsPath);
        if (ts === undefined) { return false; }
        if (Date.now() - ts > EDITOR_SAVE_WINDOW_MS) { editorSavedFiles.delete(fsPath); return false; }
        return true;
    }

    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument(doc => markEditorSaved(doc.uri.fsPath))
    );

    // --- Document edits (in-memory, before save) — debounced ---
    const onEdit = debounce((document: vscode.TextDocument) => {
        const fsPath = document.uri.fsPath;
        if (!isWatchedFile(fsPath, rootFsPath)) { return; }
        handleFileChanged(fsPath, document.getText(), project, symbolIndex, graph, rootFsPath);
    }, 300);

    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(e => onEdit(e.document))
    );

    // --- File created ---
    context.subscriptions.push(
        vscode.workspace.onDidCreateFiles(e => {
            for (const file of e.files) {
                if (!isWatchedFile(file.fsPath, rootFsPath)) { continue; }
                handleFileCreated(file.fsPath, project, symbolIndex, graph, rootFsPath);
            }
        })
    );

    // --- File deleted ---
    context.subscriptions.push(
        vscode.workspace.onDidDeleteFiles(e => {
            for (const file of e.files) {
                if (!isWatchedFile(file.fsPath, rootFsPath)) { continue; }
                handleFileDeleted(file.fsPath, project, symbolIndex, graph);
            }
        })
    );

    // --- File renamed ---
    context.subscriptions.push(
        vscode.workspace.onDidRenameFiles(e => {
            for (const { oldUri, newUri } of e.files) {
                if (isWatchedFile(oldUri.fsPath, rootFsPath)) {
                    handleFileDeleted(oldUri.fsPath, project, symbolIndex, graph);
                }
                if (isWatchedFile(newUri.fsPath, rootFsPath)) {
                    handleFileCreated(newUri.fsPath, project, symbolIndex, graph, rootFsPath);
                }
            }
        })
    );

    // --- External file changes (git pull, reset, stash pop, rebase, merge) ---
    // The FS watcher fires for ALL file changes. Skip files the editor just
    // saved (already handled by onDidChangeTextDocument above).
    const externalFileWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(workspaceRoot, '**/*.{ts,tsx,js,jsx}'),
        /*ignoreCreateEvents*/ true,  // handled by onDidCreateFiles
        /*ignoreChangeEvents*/ false,
        /*ignoreDeleteEvents*/ true   // handled by onDidDeleteFiles
    );
    context.subscriptions.push(externalFileWatcher);

    const onExternalChange = debounce((uri: vscode.Uri) => {
        const fsPath = uri.fsPath;
        if (!isWatchedFile(fsPath, rootFsPath)) { return; }
        if (wasEditorSaved(fsPath)) { return; } // editor already handled it
        // Read from disk — this is an external change (git, CLI, another editor)
        handleFileCreated(fsPath, project, symbolIndex, graph, rootFsPath);
    }, 400);

    externalFileWatcher.onDidChange(onExternalChange);

    // --- Git ref changes — cover all operations that rewrite file content ---
    //   .git/HEAD         → checkout, switch
    //   .git/ORIG_HEAD    → reset --hard, merge (before)
    //   .git/MERGE_HEAD   → in-progress merge
    //   .git/FETCH_HEAD   → after fetch / pull
    const gitPatterns = [
        '.git/HEAD',
        '.git/ORIG_HEAD',
        '.git/MERGE_HEAD',
        '.git/FETCH_HEAD',
    ];

    const onGitRefChange = debounce(() => {
        triggerRebuild(project, symbolIndex, graph, rootFsPath, 'Git ref change');
    }, 600);

    for (const pattern of gitPatterns) {
        const w = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(workspaceRoot, pattern)
        );
        context.subscriptions.push(w);
        w.onDidChange(onGitRefChange);
        w.onDidCreate(onGitRefChange);
    }

    console.log('[RippleCheck] File watcher registered');
}
