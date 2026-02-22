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
import { GraphPanel } from './webview/graphPanel';
import { buildReferenceGraph, walkSourceFile } from './core/indexing/referenceWalker';
import { persistDependencyGraph } from './core/graph/graphStore';
import { buildGraphElements } from './core/graph/graphElements';
import { removeFileFromGraph } from './core/watch/incrementalUpdater';
import { registerFileWatcher } from './core/watch/fileWatcher';
import { computeStagedBlastRadius, computeInEditorBlastRadius, BlastRadiusResult } from './core/blast/blastRadiusEngine';
import { getStagedFiles } from './core/git/stagedSnapshot';
import { DependencyGraph } from './core/graph/types';
import { SymbolIndex } from './core/indexing/symbolIndex';
import { parseIntent } from './core/intent/intentParser';
import { resolveIntent } from './core/intent/intentResolver';
import { computePredictiveBlastRadius } from './core/intent/predictiveEngine';
import { buildImpactReport, persistImpactReport } from './core/impact/impactReport';

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
		workspaceRootFsPath = workspaceRoot.fsPath.replace(/\\/g, '/');

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

		// ── Register the file-based graph loader for the panel ─────────────────
		// Called every time the graph panel opens so it always reflects the
		// latest graph.json + symbols.json written to .blastradius/.
		GraphPanel.setGraphLoader(async () => {
			console.log('[RippleCheck] Graph loader called — reading .blastradius/graph.json + symbols.json...');
			const [idx, g] = await Promise.all([
				loadCachedSymbolIndex(workspaceRoot),
				loadCachedDependencyGraph(workspaceRoot),
			]);
			if (!idx) {
				console.warn('[RippleCheck] Graph loader — symbols.json missing or empty, cannot build graph');
				return { nodes: [], edges: [] };
			}
			if (!g) {
				console.warn('[RippleCheck] Graph loader — graph.json missing or empty, cannot build graph');
				return { nodes: [], edges: [] };
			}
			console.log(`[RippleCheck] Graph loader — index: ${idx.size} symbol(s), forward edges: ${g.forward.size} owner(s)`);
			const empty: BlastRadiusResult = {
				roots: [], directImpact: [], indirectImpact: [],
				depthMap: new Map(), paths: new Map(),
			};
			const { nodes, edges } = buildGraphElements(idx, g, empty);
			console.log(`[RippleCheck] Graph loader — built ${nodes.length} node(s), ${edges.length} edge(s) — posting to panel`);
			return { nodes, edges };
		});
		console.log('[RippleCheck] Graph panel loader registered');

		// ── Analysis version — prevents stale async results from clobbering newer ones ──
		// Both runAnalysis (async/staged) and runInEditorAnalysis (sync/live)
		// increment this counter when they start.  Before posting results the
		// handler checks that the version hasn't moved forward — if it has, a
		// newer analysis has already started and this result is discarded.
		let analysisVersion = 0;

		// ── Helper: run blast radius and push to all open panels ────────────────
		const runAnalysis = async (): Promise<void> => {
			const myVersion = ++analysisVersion;
			provider?.postAnalysisStart();
			try {
				const result     = await computeStagedBlastRadius(project!, symbolIndex!, graph!, workspaceRootFsPath);
				if (myVersion !== analysisVersion) { return; } // stale — newer analysis started
				const stagedFiles = await getStagedFiles(workspaceRootFsPath);
				if (myVersion !== analysisVersion) { return; }
				provider?.postResult(result, stagedFiles, symbolIndex!, workspaceRootFsPath);

				// Push fresh graph data (with blast-radius overlay) to the open panel.
				const { nodes, edges } = buildGraphElements(symbolIndex!, graph!, result);
				GraphPanel.postGraphData(nodes, edges);
				GraphPanel.postAnalysisResult({
					roots:    result.roots.map(r => r.symbolId),
					direct:   result.directImpact,
					indirect: result.indirectImpact,
				});

				// Persist impact.json
				const report = buildImpactReport(result, symbolIndex!, graph!, workspaceRootFsPath, 'staged');
				void persistImpactReport(report, workspaceRoot);
			} catch (err) {
				if (myVersion !== analysisVersion) { return; }
				console.error('[RippleCheck] Blast radius error:', err);
				provider?.postError(String(err));
			}
		};

		// ── Helper: in-editor blast radius (no git staging required) ────────────
		// Called when the file watcher detects a signature change or symbol
		// deletion in the editor buffer, before the user has run `git add`.
		const runInEditorAnalysis = (changeResult: import('./core/analysis/signatureAnalyzer').SignatureChangeResult, filePath: string): void => {
			const myVersion = ++analysisVersion;
			provider?.postAnalysisStart();
			try {
				const result = computeInEditorBlastRadius(
					changeResult.ripple,
					changeResult.removed,
					changeResult.preRemovalDependents,
					graph!,
				);
				if (myVersion !== analysisVersion) { return; }
				// Show the changed file itself in the "Changed Files" list so the
				// panel isn't completely empty on that section.
				const fakeEntry: import('./core/git/stagedSnapshot').StagedFileEntry = {
					status: 'M',
					absolutePath: filePath,
				};
				provider?.postResult(result, [fakeEntry], symbolIndex!, workspaceRootFsPath);

				const { nodes, edges } = buildGraphElements(symbolIndex!, graph!, result);
				GraphPanel.postGraphData(nodes, edges);
				GraphPanel.postAnalysisResult({
					roots:    result.roots.map(r => r.symbolId),
					direct:   result.directImpact,
					indirect: result.indirectImpact,
				});
				console.log(
					`[RippleCheck] In-editor blast radius — ` +
					`${result.roots.length} root(s), ` +
					`${result.directImpact.length} direct, ` +
					`${result.indirectImpact.length} indirect`,
				);

				// Persist impact.json
				const report = buildImpactReport(result, symbolIndex!, graph!, workspaceRootFsPath, 'in-editor');
				void persistImpactReport(report, workspaceRoot);
			} catch (err) {
				if (myVersion !== analysisVersion) { return; }
				console.error('[RippleCheck] In-editor blast radius error:', err);
				provider?.postError(String(err));
			}
		};

		// Step 6 — watch for file changes and keep graph in sync incrementally
		registerFileWatcher(project!, symbolIndex!, graph!, workspaceRoot, context, {
			onRipple(changeResult, filePath) {
				console.log(
					`[RippleCheck] Signature/removal change in ` +
					`${filePath.split('/').pop()} (${changeResult.ripple.length} ripple(s), ` +
					`${changeResult.removed.length} removed) — running in-editor blast radius`,
				);
				runInEditorAnalysis(changeResult, filePath);
			},
			onStagingChange() {
				console.log('[RippleCheck] Staging area changed — running blast radius analysis');
				void runAnalysis();
			},
		});

		// Step 7 — register the on-demand "Analyze" command
		context.subscriptions.push(
			vscode.commands.registerCommand('ripplecheck.analyze', () => void runAnalysis()),
		);
	}

	provider = new GitVisualizerPanel(context.extensionUri);

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

		// Persist impact.json for the What-If prediction
		if (workspaceFolders && workspaceFolders.length > 0) {
			const report = buildImpactReport(predicted, symbolIndex, graph, workspaceRootFsPath, 'what-if', predicted.confidenceMap);
			void persistImpactReport(report, workspaceFolders[0].uri);
		}
	};

	console.log('[RippleCheck] Blast radius + What If? pipeline wired to panel');
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(GitVisualizerPanel.viewType, provider),
	);

	// Legacy hello-world command kept for package.json compatibility
	context.subscriptions.push(
		vscode.commands.registerCommand('ripplecheck.helloWorld', () =>
			vscode.window.showInformationMessage('RippleCheck is active — use the sidebar to analyze staged changes.')
		),
	);
}

// This method is called when your extension is deactivated
export function deactivate() {}

