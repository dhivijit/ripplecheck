/**
 * LEGACY — webview commit-history display only.
 *
 * This module is the sole consumer of `simple-git` in the codebase.
 * It exists exclusively to feed the sidebar panel's commit log and diff view.
 *
 * ALL analysis-path git operations (staged snapshot, diff hunks, blast radius)
 * use `child_process.execFile` via `src/core/git/gitUtils.ts` — never this class.
 * Do NOT add blast-radius or indexing logic here.
 */
import simpleGit, { SimpleGit } from 'simple-git';
import * as vscode from 'vscode';

export class GitService {
    private git: SimpleGit;

    constructor() {
        const workspacePath = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
        if (!workspacePath) {
            throw new Error('No workspace found');
        }

        this.git = simpleGit(workspacePath);
    }

    async getCommitHistory() {
        return await this.git.log();
    }

    async getDiff() {
        return await this.git.diff();
    }

    async getStatus() {
        return await this.git.status();
    }
}