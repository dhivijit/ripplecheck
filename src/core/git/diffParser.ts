import * as path from 'path';
import { execGit } from './gitUtils';

export interface DiffHunk {
    /** Absolute path of the file in its staged (new) form. */
    absoluteFilePath: string;
    /**
     * 1-based first line of the changed region in the new (staged) file.
     * Comes from the `+l` part of the `@@ -old +new @@` header.
     */
    newStartLine: number;
    /**
     * Number of lines affected in the new file.
     * 0 for pure-deletion hunks (all lines removed, nothing added at this offset).
     * We skip those — deleted files are handled via the 'D' status in getStagedFiles.
     */
    newLineCount: number;
}

// ---------------------------------------------------------------------------
// Hunk header parser
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Match: @@ -old_start[,old_count] +new_start[,new_count] @@
 *
 * Capture groups:
 *   1 — new_start  (always present)
 *   2 — new_count  (absent when count is 1, per git unified-diff convention)
 */
const HUNK_HEADER_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run `git diff --cached --unified=0` and return every changed hunk in the
 * staging area as typed objects.
 *
 * `--unified=0` removes context lines so each `@@` header's `+l,n` range maps
 * exactly to the changed region — no over-reporting of surrounding context.
 *
 * ## What is a hunk?
 *
 * A hunk represents a contiguous block of changed lines within a file.  For
 * partial-hunk staging (`git add -p`) a single function can generate multiple
 * small hunks — one per staged block.  We emit one `DiffHunk` per `@@` line.
 *
 * ## Pure-deletion hunks
 *
 * When `+l,0` appears the new file has zero lines at that position (all lines
 * were removed).  We skip these — entirely deleted files are already tracked
 * by `getStagedFiles` as status `D`, and ghost-symbol detection handles them.
 *
 * Returns an empty array when the index is clean or git is unavailable.
 */
export async function getStagedDiffHunks(repoRoot: string): Promise<DiffHunk[]> {
    let output: string;
    try {
        output = await execGit(['diff', '--cached', '--unified=0'], repoRoot);
    } catch {
        return [];
    }

    const hunks: DiffHunk[] = [];
    let currentAbsPath: string | null = null;

    for (const line of output.split('\n')) {
        // `+++ b/src/foo.ts` — the new-file path for the current section.
        // Git prefixes workspace paths with `b/`; `/dev/null` means the file
        // was deleted (no hunks relevant on the `+` side).
        if (line.startsWith('+++ ')) {
            const rawPath = line.slice(4).trim();
            if (rawPath === '/dev/null') {
                currentAbsPath = null;
            } else {
                const relPath = rawPath.startsWith('b/') ? rawPath.slice(2) : rawPath;
                currentAbsPath = path.join(repoRoot, relPath);
            }
            continue;
        }

        // `@@ ... @@` — hunk header.  Only relevant if we have a current file.
        if (line.startsWith('@@') && currentAbsPath !== null) {
            const m = HUNK_HEADER_RE.exec(line);
            if (!m) { continue; }

            const newStartLine = parseInt(m[1], 10);
            // When the `,n` part is absent, git convention means count = 1.
            const newLineCount = m[2] !== undefined ? parseInt(m[2], 10) : 1;

            // Skip pure-deletion hunks — no lines were added in the new file.
            if (newLineCount === 0) { continue; }

            hunks.push({ absoluteFilePath: currentAbsPath, newStartLine, newLineCount });
        }
    }

    return hunks;
}
