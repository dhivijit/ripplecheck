import * as vscode from 'vscode';
import { GitService } from '../git/gitService';

export class GitVisualizerPanel implements vscode.WebviewViewProvider {
    public static readonly viewType = 'ripplecheck.gitVisualizer';
    private _view?: vscode.WebviewView;

    constructor(private readonly extensionUri: vscode.Uri) {}

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void | Thenable<void> {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        this.refresh();

        // Manual refresh button messages from the webview
        const messageHandler = webviewView.webview.onDidReceiveMessage(message => {
            if (message.command === 'refresh') {
                this.refresh();
            }
        });

        // Auto-refresh whenever any file is saved
        const saveWatcher = vscode.workspace.onDidSaveTextDocument(() => this.refresh());

        // Auto-refresh on git index/HEAD changes (stage, commit, checkout, pull, etc.)
        const gitWatcher = vscode.workspace.createFileSystemWatcher(
            '**/.git/{index,HEAD,COMMIT_EDITMSG}'
        );
        gitWatcher.onDidChange(() => this.refresh());
        gitWatcher.onDidCreate(() => this.refresh());

        webviewView.onDidDispose(() => {
            messageHandler.dispose();
            saveWatcher.dispose();
            gitWatcher.dispose();
        });
    }

    public async refresh() {
        if (!this._view) { return; }
        const gitService = new GitService();
        const commits = await gitService.getCommitHistory();
        const diff = await gitService.getDiff();
        this._view.webview.html = this.getHtml(commits, diff);
    }

    private escapeHtml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    private getHtml(commits: any, diff: string): string {
        const commitsJson = this.escapeHtml(JSON.stringify(commits.all, null, 2));
        const diffEscaped = this.escapeHtml(diff);
        return `
        <html>
        <head>
            <style>
                button { margin-bottom: 12px; padding: 4px 10px; cursor: pointer; }
            </style>
        </head>
        <body>
            <button onclick="refresh()">&#8635; Refresh</button>
            <h2>Commit History</h2>
            <pre>${commitsJson}</pre>

            <h2>Current Diff</h2>
            <pre>${diffEscaped}</pre>

            <script>
                const vscode = acquireVsCodeApi();
                function refresh() {
                    vscode.postMessage({ command: 'refresh' });
                }
            </script>
        </body>
        </html>
        `;
    }
}