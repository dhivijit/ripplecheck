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