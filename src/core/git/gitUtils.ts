import { execFile } from 'child_process';

/**
 * Shared git execution helper.
 *
 * Runs a git command in `cwd` and resolves with its stdout as UTF-8.
 * Rejects if git exits non-zero (not a repo, git not installed, etc.).
 *
 * All staged-analysis modules (`stagedSnapshot`, `diffParser`) use this
 * instead of duplicating the same `execFile` wrapper.
 */
export function execGit(args: string[], cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(
            'git', args,
            { cwd, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 },
            (err, stdout) => {
                if (err) { reject(err); } else { resolve(stdout as string); }
            }
        );
    });
}
