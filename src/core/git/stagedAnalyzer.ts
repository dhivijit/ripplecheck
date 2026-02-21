import { Project } from 'ts-morph';
import { SymbolIndex } from '../indexing/symbolIndex';
import { DependencyGraph } from '../graph/types';
import { SignatureChangeResult, detectGhostSymbols } from '../analysis/signatureAnalyzer';
import { handleFileChanged, handleFileDeleted } from '../watch/incrementalUpdater';
import { getStagedFiles, readStagedContent } from './stagedSnapshot';

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface StagedAnalysisResult {
    /**
     * Absolute paths of every staged TypeScript/JS file that was analysed.
     * Files with unsupported extensions (e.g. .json, .md) are excluded.
     */
    stagedFilePaths: string[];

    /**
     * Per-file signature change breakdown.
     * Keys are absolute file paths.
     */
    perFile: Map<string, SignatureChangeResult>;

    /**
     * Deduplicated set of symbol IDs whose public API changed in the staged
     * snapshot.  These are the roots for blast-radius computation in Phase 4.
     *
     * Includes both:
     *   - symbols whose signatureHash changed (ripple from each perFile result)
     *   - ghost symbols (deleted or renamed away, so dependents are now broken)
     */
    rippleRoots: string[];

    /**
     * Symbol IDs that exist in the dependency graph but are absent from the
     * symbol index after analysis — i.e. their declaration was deleted or
     * renamed in the staged snapshot.
     */
    ghostSymbols: string[];
}

// ---------------------------------------------------------------------------
// File filter
// ---------------------------------------------------------------------------

const WATCHED_EXT = /\.(ts|tsx|js|jsx)$/;

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Analyse the **staged** (git index) version of every changed file and update
 * the live symbol index + dependency graph to reflect what will actually be
 * committed.
 *
 * ## Why staged content, not filesystem content?
 *
 * `git add -p` lets developers stage only *part* of their edits. If we read
 * from the filesystem we would analyse unstaged code and report false impact
 * for changes that are not being committed. `git show :path` returns exactly
 * the bytes that are in the index — the ground truth for what goes into the
 * next commit.
 *
 * ## Newly added files (Blocker 2)
 *
 * `git add newFile.ts` can happen before VSCode's file-system watcher fires.
 * When a staged file is absent from the symbol index, the underlying
 * `handleFileChanged` call transparently handles it: `refreshSourceFile`
 * creates an in-memory ts-morph SourceFile from the staged content, so no
 * special pre-check is needed. The "added" bucket of the returned
 * `SignatureChangeResult` will contain all newly discovered symbols.
 *
 * @param project            The live ts-morph project.
 * @param symbolIndex        The live symbol index (mutated in place).
 * @param graph              The live dependency graph (mutated in place).
 * @param workspaceRootFsPath Absolute path to the repository / workspace root.
 */
export async function analyzeStagedChanges(
    project: Project,
    symbolIndex: SymbolIndex,
    graph: DependencyGraph,
    workspaceRootFsPath: string,
): Promise<StagedAnalysisResult> {
    // ── Step 1: enumerate staged files ──────────────────────────────────────
    const stagedFiles = await getStagedFiles(workspaceRootFsPath);

    const perFile = new Map<string, SignatureChangeResult>();
    const allRippleRoots: string[] = [];
    const analysedPaths: string[] = [];

    // ── Step 2: process each staged file ────────────────────────────────────
    for (const entry of stagedFiles) {
        const { status, absolutePath } = entry;

        // Only care about TypeScript / JavaScript files
        if (!WATCHED_EXT.test(absolutePath)) { continue; }
        analysedPaths.push(absolutePath);

        if (status === 'D') {
            // ── Deleted: wipe symbols & edges, nothing to re-index ──────────
            handleFileDeleted(absolutePath, project, symbolIndex, graph);
            // An all-empty result; ghost detection below will surface orphaned dependents
            perFile.set(absolutePath, { ripple: [], safe: [], added: [], removed: [] });

        } else if (status === 'R' || status === 'C') {
            // ── Rename / copy: treat old path as deleted, new path as added ─
            if (entry.oldAbsolutePath) {
                handleFileDeleted(entry.oldAbsolutePath, project, symbolIndex, graph);
            }
            await analyzeOneStagedFile(
                absolutePath, workspaceRootFsPath,
                project, symbolIndex, graph,
                perFile, allRippleRoots,
            );

        } else {
            // ── Added (A) or Modified (M) ────────────────────────────────────
            //
            // Both cases are handled identically:
            //   • Modified: handleFileChanged snapshots old hashes, wipes, re-indexes
            //     with staged content, returns diff.
            //   • Added (not yet in index): snapshotSignatures returns empty map →
            //     removeFileFromGraph is a no-op → file is created in-memory from
            //     staged content → all symbols land in the "added" bucket.
            //     No special-casing needed.
            await analyzeOneStagedFile(
                absolutePath, workspaceRootFsPath,
                project, symbolIndex, graph,
                perFile, allRippleRoots,
            );
        }
    }

    // ── Step 3: ghost symbol detection ──────────────────────────────────────
    // Symbols that are still referenced in the graph but no longer exist in
    // the index after analysis.  Their dependents are effectively broken.
    const ghostSymbols = detectGhostSymbols(graph, symbolIndex);
    allRippleRoots.push(...ghostSymbols);

    return {
        stagedFilePaths: analysedPaths,
        perFile,
        rippleRoots: [...new Set(allRippleRoots)],
        ghostSymbols,
    };
}

// ---------------------------------------------------------------------------
// Internal helper
// ---------------------------------------------------------------------------

/**
 * Read staged content for one file and run the incremental update pipeline
 * with that content.  Mutates `perFile` and `allRippleRoots`.
 */
async function analyzeOneStagedFile(
    absolutePath: string,
    workspaceRootFsPath: string,
    project: Project,
    symbolIndex: SymbolIndex,
    graph: DependencyGraph,
    perFile: Map<string, SignatureChangeResult>,
    allRippleRoots: string[],
): Promise<void> {
    const stagedContent = await readStagedContent(workspaceRootFsPath, absolutePath);

    if (stagedContent === null) {
        // git show failed — file may have been removed from the index between
        // getStagedFiles and this call. Log and skip.
        console.warn(`[RippleCheck] analyzeStagedChanges: could not read staged content for ${absolutePath}`);
        return;
    }

    // Feed the staged snapshot (not the filesystem version) into the standard
    // incremental update pipeline.  The pipeline:
    //   1. Snapshots old signature hashes
    //   2. Wipes the file's symbols and graph edges
    //   3. Parses `stagedContent` as an in-memory ts-morph SourceFile
    //   4. Re-extracts symbols and re-walks references
    //   5. Returns the diff (ripple / safe / added / removed)
    const result = handleFileChanged(
        absolutePath,
        stagedContent,
        project,
        symbolIndex,
        graph,
        workspaceRootFsPath,
    );

    perFile.set(absolutePath, result);
    allRippleRoots.push(...result.ripple);
}
