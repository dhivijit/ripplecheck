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
import { GraphPanel } from './webview/graphPanel';
import { buildReferenceGraph, walkSourceFile } from './core/indexing/referenceWalker';
import { persistDependencyGraph } from './core/graph/graphStore';
import { removeFileFromGraph } from './core/watch/incrementalUpdater';
import { registerFileWatcher } from './core/watch/fileWatcher';
import { computeStagedBlastRadius, BlastRadiusResult } from './core/blast/blastRadiusEngine';
import { getStagedFiles } from './core/git/stagedSnapshot';
import { DependencyGraph } from './core/graph/types';
import { SymbolIndex } from './core/indexing/symbolIndex';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {

	console.log('[RippleCheck] Activating...');
	// Declared here so the onRipple closure and ripplecheck.analyze command can
	// both post messages to the sidebar without a separate ref-object indirection.
	let provider: GitVisualizerPanel | undefined;
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

		// ── Helper: run blast radius and push to all open panels ────────────────
		const runAnalysis = async (): Promise<void> => {
			provider?.postAnalysisStart();
			try {
				const result     = await computeStagedBlastRadius(project, symbolIndex, graph, workspaceRootFsPath);
				const stagedFiles = await getStagedFiles(workspaceRootFsPath);
				provider?.postResult(result, stagedFiles, symbolIndex);

				// Push graph data to the Cytoscape panel (if open)
				const { nodes, edges } = buildGraphElements(symbolIndex, graph, result);
				GraphPanel.postGraphData(nodes, edges);
				GraphPanel.postAnalysisResult({
					roots:    result.roots.map(r => r.symbolId),
					direct:   result.directImpact,
					indirect: result.indirectImpact,
				});
			} catch (err) {
				console.error('[RippleCheck] Blast radius error:', err);
				provider?.postError(String(err));
			}
		};

		// Step 6 — watch for file changes and keep graph in sync incrementally
		registerFileWatcher(project, symbolIndex, graph, workspaceRoot, context, {
			onRipple(rippleIds, filePath) {
				console.log(
					`[RippleCheck] ${rippleIds.length} signature ripple(s) in ` +
					`${filePath.split('/').pop()} — running blast radius analysis`,
				);
				void runAnalysis();
			},
		});

		// Step 7 — register the on-demand "Analyze" command
		context.subscriptions.push(
			vscode.commands.registerCommand('ripplecheck.analyze', () => void runAnalysis()),
		);
	}

	provider = new GitVisualizerPanel(context.extensionUri);
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

// ---------------------------------------------------------------------------
// Graph element builder (Cytoscape-format, scoped to blast radius + 1-hop)
// ---------------------------------------------------------------------------

/**
 * Build Cytoscape node/edge objects for the impacted symbol set.
 *
 * To keep the graph manageable we include:
 *   - All roots, direct, and indirect impact symbols
 *   - Their forward/reverse neighbours in the live graph (1-hop context)
 *
 * Each node carries a `role` field: 'root' | 'direct' | 'indirect' | 'other'
 * which graphPanel.ts uses for colour coding.
 */
function buildGraphElements(
    symbolIndex: SymbolIndex,
    graph: DependencyGraph,
    result: BlastRadiusResult,
): { nodes: object[]; edges: object[] } {
    const rootIds     = new Set(result.roots.map(r => r.symbolId));
    const directIds   = new Set(result.directImpact);
    const indirectIds = new Set(result.indirectImpact);

    // Start with the full impacted set
    const allIds = new Set([...rootIds, ...directIds, ...indirectIds]);

    // Add one hop of context around roots so edges have both endpoints
    for (const rootId of rootIds) {
        for (const nid of (graph.forward.get(rootId) ?? [])) { allIds.add(nid); }
        for (const nid of (graph.reverse.get(rootId) ?? [])) { allIds.add(nid); }
    }

    const role = (id: string): string => {
        if (rootIds.has(id))     { return 'root'; }
        if (directIds.has(id))   { return 'direct'; }
        if (indirectIds.has(id)) { return 'indirect'; }
        return 'other';
    };

    const nodes = [...allIds].map(id => {
        const sym   = symbolIndex.get(id);
        const label = sym ? sym.name : id;
        return { data: { id, label, role: role(id) } };
    });

    const edges: object[] = [];
    for (const srcId of allIds) {
        for (const tgtId of (graph.forward.get(srcId) ?? [])) {
            if (allIds.has(tgtId)) {
                edges.push({ data: { id: `${srcId}\u2192${tgtId}`, source: srcId, target: tgtId } });
            }
        }
    }

    return { nodes, edges };
}
