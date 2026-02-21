// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { SourceFile } from 'ts-morph';
import { ensureCacheDirectory, computeProjectHash, writeCacheMetadata } from './core/cache/cacheManager';
import { loadCachedSymbolIndex, loadCachedDependencyGraph, loadCachedMetadata } from './core/cache/cacheLoader';
import { computeFileHash, saveFileHashes, loadFileHashes } from './core/cache/fileHashStore';
import { loadProject } from './core/indexing/projectLoader';
import { buildSymbolIndex, persistSymbolIndex } from './core/indexing/symbolIndex';
import { extractSymbols } from './core/indexing/symbolExtractor';
import { GitVisualizerPanel } from './webview/panel';
import { buildReferenceGraph, walkSourceFile } from './core/indexing/referenceWalker';
import { persistDependencyGraph } from './core/graph/graphStore';
import { removeFileFromGraph } from './core/watch/incrementalUpdater';
import { registerFileWatcher } from './core/watch/fileWatcher';
import { DependencyGraph } from './core/graph/types';
import { SymbolIndex } from './core/indexing/symbolIndex';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {

	console.log('[RippleCheck] Activating...');

	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (workspaceFolders && workspaceFolders.length > 0) {
		const workspaceRoot = workspaceFolders[0].uri;
		const workspaceRootFsPath = workspaceRoot.fsPath;

		// Step 1 — ensure .blastradius/ and its files exist
		await ensureCacheDirectory(workspaceRoot);

		// Step 2 — load the ts-morph project (needed for both cache and full-rebuild paths)
		const project = loadProject(workspaceRootFsPath);
		const currentHash = computeProjectHash(workspaceRootFsPath);

		// Step 3 — attempt to restore from cache (parallel reads)
		const [cachedSymbols, cachedGraph, cachedMeta] = await Promise.all([
			loadCachedSymbolIndex(workspaceRoot),
			loadCachedDependencyGraph(workspaceRoot),
			loadCachedMetadata(workspaceRoot),
		]);

		let symbolIndex: SymbolIndex;
		let graph: DependencyGraph;

		const cacheValid =
			cachedSymbols !== null &&
			cachedGraph  !== null &&
			cachedMeta   !== null &&
			cachedMeta.projectHash === currentHash &&
			cachedSymbols.size > 0;

		if (cacheValid) {
			// Cache hit — restore live structures, patch only content-changed files
			symbolIndex = cachedSymbols!;
			graph       = cachedGraph!;

			const cachedHashes   = await loadFileHashes(workspaceRoot);
			const activeFilePaths = new Set<string>();
			const newHashes       = new Map<string, string>();

			// ── Pass 1: remove stale files and re-index their symbols ───────────
			// All removals must complete BEFORE any re-walks.  If we interleaved
			// (remove A → re-walk A → remove B → re-walk B), re-walking A would
			// add edge A→B, then removing B would erase it.  B's later re-walk
			// would never restore A→B because A is already processed.  Two
			// passes guarantee every cross-file edge is re-established correctly.
			const yield_ = () => new Promise<void>(r => setImmediate(r));
			const staleSourceFiles: SourceFile[] = [];
			let staleI = 0;

			for (const sf of project.getSourceFiles()) {
				const fp = sf.getFilePath();
				activeFilePaths.add(fp);

				const currentHash = computeFileHash(fp);
				newHashes.set(fp, currentHash);

				const isStale = currentHash === '' || currentHash !== cachedHashes.get(fp);
				if (isStale) {
					removeFileFromGraph(fp, symbolIndex, graph);
					try { sf.refreshFromFileSystemSync(); } catch { continue; }
					const newSymbols = extractSymbols(sf);
					for (const sym of newSymbols) { symbolIndex.set(sym.id, sym); }
					staleSourceFiles.push(sf); // only queued if refresh succeeded
				}
				if (++staleI % 20 === 0) { await yield_(); }
			}

			// ── Pass 2: re-walk all stale files now that the full index is ready ─
			staleI = 0;
			for (const sf of staleSourceFiles) {
				walkSourceFile(sf, symbolIndex, workspaceRootFsPath, graph);
				if (++staleI % 20 === 0) { await yield_(); }
			}

			// Remove symbols whose source files were deleted since the cache was written
			const deletedPaths = new Set<string>();
			for (const entry of symbolIndex.values()) {
				if (!activeFilePaths.has(entry.filePath)) { deletedPaths.add(entry.filePath); }
			}
			for (const fp of deletedPaths) { removeFileFromGraph(fp, symbolIndex, graph); }

			// Persist updated hashes, symbol index (with fresh signatureHashes),
			// and graph so the next startup has accurate baselines for all three.
			await Promise.all([
				saveFileHashes(newHashes, workspaceRoot),
				persistSymbolIndex(symbolIndex, workspaceRoot),
				persistDependencyGraph(graph, workspaceRoot),
			]);

			console.log(`[RippleCheck] Cache restored — ${deletedPaths.size} deleted, stale files patched`);

		} else {
			// Cache miss or project structure changed — full rebuild
			console.log('[RippleCheck] Cache miss — full rebuild...');
			symbolIndex = await buildSymbolIndex(project, workspaceRoot);
			graph       = buildReferenceGraph(project, symbolIndex, workspaceRootFsPath);
			await persistDependencyGraph(graph, workspaceRoot);
			await writeCacheMetadata(workspaceRoot, currentHash);

			// Snapshot per-file content hashes so the next startup can diff precisely
			const hashes = new Map<string, string>();
			for (const sf of project.getSourceFiles()) {
				hashes.set(sf.getFilePath(), computeFileHash(sf.getFilePath()));
			}
			await saveFileHashes(hashes, workspaceRoot);
		}

		// Step 6 — watch for file changes and keep graph in sync incrementally
		registerFileWatcher(project, symbolIndex, graph, workspaceRoot, context, {
			onRipple(rippleIds, filePath) {
				console.log(
					`[RippleCheck] ${rippleIds.length} signature ripple(s) in ` +
					`${filePath.split('/').pop()} — blast radius pending webview integration`
				);
				// TODO: call computeStagedBlastRadius and push result to webview panel
			},
		});
	}

	const provider = new GitVisualizerPanel(context.extensionUri);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(GitVisualizerPanel.viewType, provider)
	);

	// The command has been defined in the package.json file
	// Now provide the implementation of the command with registerCommand
	// The commandId parameter must match the command field in package.json
	const disposable = vscode.commands.registerCommand('ripplecheck.helloWorld', () => {
		// The code you place here will be executed every time your command is executed
		// Display a message box to the user
		vscode.window.showInformationMessage('Hello World from RippleCheck!');
	});

	context.subscriptions.push(disposable);
}

// This method is called when your extension is deactivated
export function deactivate() {}
