import * as path from 'path';
import { execGit } from './gitUtils';

export type StagedStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T';

export interface StagedFileEntry {
    /** Single-letter status code from git diff --name-status */
    status: StagedStatus;
    /** Absolute path of the file (post-operation, i.e. destination for renames) */
    absolutePath: string;
    /** Only set for R/C: absolute path before the rename / copy */
    oldAbsolutePath?: string;
}

// ---------------------------------------------------------------------------
// Staged file list
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Return every file currently in the git staging area (index) together with
 * its status.
 *
 * Uses `git diff --cached --name-status` which outputs tab-delimited lines:
 *   M\tpath/to/file.ts
 *   A\tnewfile.ts
 *   D\tdeleted.ts
 *   R100\told-name.ts\tnew-name.ts
 *
 * Returns an empty array when the repo has no staged changes or when the
 * working directory is not a git repository.
 */
export async function getStagedFiles(repoRoot: string): Promise<StagedFileEntry[]> {
    let output: string;
    try {
        output = await execGit(['diff', '--cached', '--name-status'], repoRoot);
    } catch {
        // Not a git repo, clean index, or git not available
        return [];
    }

    const entries: StagedFileEntry[] = [];

    for (const line of output.split('\n')) {
        const trimmed = line.trimEnd();
        if (!trimmed) { continue; }

        const parts = trimmed.split('\t');
        // parts[0] is the status code (e.g. "M", "A", "R100")
        const statusCode = parts[0];
        if (!statusCode) { continue; }

        const status = statusCode[0] as StagedStatus;

        if ((status === 'R' || status === 'C') && parts.length >= 3) {
            // Rename or copy: old path is parts[1], new path is parts[2]
            entries.push({
                status,
                absolutePath: path.join(repoRoot, parts[2]).replace(/\\/g, '/'),
                oldAbsolutePath: path.join(repoRoot, parts[1]).replace(/\\/g, '/'),
            });
        } else if (parts.length >= 2) {
            entries.push({
                status,
                absolutePath: path.join(repoRoot, parts[1]).replace(/\\/g, '/'),
            });
        }
    }

    return entries;
}

// ---------------------------------------------------------------------------
// Staged content reader
// ---------------------------------------------------------------------------

/**
 * Read the content of a file **from the git staging area** (the index),
 * not from the filesystem.
 *
 * This is the canonical source of truth for what will actually be committed.
 * Use it instead of reading the file from disk so that partial-hunk staging
 * (where the editor has unstaged edits) is handled correctly.
 *
 * Returns `null` when:
 *   - the file is not staged (e.g. it was deleted and staged as D)
 *   - `git show` fails for any reason
 *
 * @param repoRoot         Absolute path to the repository root.
 * @param absoluteFilePath Absolute path to the file whose staged version is wanted.
 */
export async function readStagedContent(
    repoRoot: string,
    absoluteFilePath: string,
): Promise<string | null> {
    // git show expects a path relative to the repo root, with forward slashes
    const relPath = path.relative(repoRoot, absoluteFilePath).replace(/\\/g, '/');
    try {
        return await execGit(['show', `:${relPath}`], repoRoot);
    } catch {
        return null;
    }
}
