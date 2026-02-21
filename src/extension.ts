// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { Project, SourceFile } from 'ts-morph';
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
import { parseIntent } from './core/intent/intentParser';
import { computeStagedBlastRadius } from './core/blast/blastRadiusEngine';
import { resolveIntent } from './core/intent/intentResolver';
import { computePredictiveBlastRadius } from './core/intent/predictiveEngine';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {

	console.log('[RippleCheck] Activating...');

	// Hoisted so closures in registerFileWatcher and provider callbacks capture live values.
	let symbolIndex: SymbolIndex | undefined;
	let project: Project | undefined;
	let graph: DependencyGraph | undefined;
	let provider: GitVisualizerPanel | undefined;
	let workspaceRootFsPath = '';

	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (workspaceFolders && workspaceFolders.length > 0) {
		const workspaceRoot = workspaceFolders[0].uri;
		workspaceRootFsPath = workspaceRoot.fsPath;

		// Step 1 — ensure .blastradius/ and its files exist
		await ensureCacheDirectory(workspaceRoot);

		// Step 2 — load the ts-morph project (needed for both cache and full-rebuild paths)
		project = loadProject(workspaceRootFsPath);
		const currentHash = computeProjectHash(workspaceRootFsPath);

		// Step 3 — attempt to restore from cache (parallel reads)
		const [cachedSymbols, cachedGraph, cachedMeta] = await Promise.all([
			loadCachedSymbolIndex(workspaceRoot),
			loadCachedDependencyGraph(workspaceRoot),
			loadCachedMetadata(workspaceRoot),
		]);

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
		registerFileWatcher(project!, symbolIndex!, graph!, workspaceRoot, context, {
			onRipple(_rippleIds, _filePath) {
				if (!project || !symbolIndex || !graph || !provider) { return; }
				provider.postAnalysisStart();
				computeStagedBlastRadius(project, symbolIndex, graph, workspaceRootFsPath)
					.then(result => {
						provider!.postResult(result);
					})
					.catch((err: unknown) => {
						provider!.postError(`Blast radius failed: ${String(err)}`);
					});
			},
		});
	}

	provider = new GitVisualizerPanel();

	// Wire the on-demand blast radius analysis (sidebar Analyse button).
	provider.onAnalyseRequest = () => {
		if (!project || !symbolIndex || !graph || !provider) { return; }
		provider.postAnalysisStart();
		computeStagedBlastRadius(project, symbolIndex, graph, workspaceRootFsPath)
			.then(result => {
				provider!.postResult(result);
			})
			.catch((err: unknown) => {
				provider!.postError(`Blast radius failed: ${String(err)}`);
			});
	};

	// Wire the full What If? pipeline: parse → resolve → virtual diff → BFS → confidence.
	provider.onWhatIfRequest = async (prompt, token) => {
		if (!symbolIndex || !graph) {
			throw new Error('Workspace still loading — try again in a moment.');
		}
		console.log(`[RippleCheck] What-if: "${prompt}" | ${symbolIndex.size} symbols`);

		// Step 1: parse intent via LLM
		const parseResult = await parseIntent(prompt, token, symbolIndex, workspaceRootFsPath || undefined);
		if (!parseResult.ok) { throw new Error(parseResult.error.reason); }

		// Post intent immediately so the UI shows something before BFS finishes.
		provider!.postWhatIfIntent(parseResult.value);

		// Step 2: fuzzy-match hints → real symbol IDs
		const resolved = resolveIntent(parseResult.value, symbolIndex, workspaceRootFsPath || '');

		// Steps 3–5: virtual diff → BFS → confidence map
		const predicted = computePredictiveBlastRadius(resolved, symbolIndex, graph);
		provider!.postPredictedResult(predicted);
	};

	console.log('[RippleCheck] Blast radius + What If? pipeline wired to panel');

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
