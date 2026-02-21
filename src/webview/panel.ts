import * as vscode from 'vscode';
import { GitService } from '../git/gitService';
import { IntentDescriptor, IntentParseError } from '../core/intent/types';

export class GitVisualizerPanel implements vscode.WebviewViewProvider {
    public static readonly viewType = 'ripplecheck.gitVisualizer';
    private _view?: vscode.WebviewView;

    /**
     * Assigned by extension.ts after activation.
     * Called when the user submits a "What if?" prompt in the sidebar.
     * Returns a Promise so extension.ts can run the intent parser asynchronously.
     */
    public onWhatIfRequest?: (
        prompt: string,
        token: vscode.CancellationToken,
    ) => Promise<IntentDescriptor>;

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

            if (message.command === 'whatIf') {
                if (!this.onWhatIfRequest) {
                    this._view?.webview.postMessage({
                        type: 'whatIfError',
                        reason: 'Intent parser not initialised yet — workspace still loading.',
                    });
                    return;
                }
                const cts = new vscode.CancellationTokenSource();
                this.onWhatIfRequest(message.prompt as string, cts.token)
                    .then(descriptor => {
                        this._view?.webview.postMessage({ type: 'whatIfResult', descriptor });
                    })
                    .catch((err: unknown) => {
                        this._view?.webview.postMessage({
                            type:   'whatIfError',
                            reason: String(err),
                        });
                    })
                    .finally(() => cts.dispose());
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

    /** Push a successful intent parse result to the webview. */
    public postWhatIfResult(descriptor: IntentDescriptor): void {
        this._view?.webview.postMessage({ type: 'whatIfResult', descriptor });
    }

    /** Push a parse error to the webview. */
    public postWhatIfError(error: IntentParseError): void {
        this._view?.webview.postMessage({ type: 'whatIfError', reason: error.reason });
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
                body  { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); }
                button { margin-bottom: 12px; padding: 4px 10px; cursor: pointer; }

                /* ── What If section ── */
                #whatif-section {
                    border-top: 1px solid var(--vscode-panel-border, #444);
                    padding: 10px;
                    margin-top: 12px;
                }
                #whatif-section h2 { font-size: 12px; margin: 0 0 6px; text-transform: uppercase; letter-spacing: 0.05em; }
                #whatif-prompt {
                    width: 100%;
                    box-sizing: border-box;
                    min-height: 60px;
                    resize: vertical;
                    background: var(--vscode-input-background);
                    color: var(--vscode-input-foreground);
                    border: 1px solid var(--vscode-input-border, #555);
                    border-radius: 2px;
                    padding: 6px;
                    font-family: var(--vscode-font-family);
                    font-size: var(--vscode-font-size);
                }
                #whatif-submit {
                    margin-top: 6px;
                    background: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: none;
                    border-radius: 2px;
                    padding: 4px 12px;
                    cursor: pointer;
                    font-size: 12px;
                }
                #whatif-submit:disabled { opacity: 0.5; cursor: default; }
                #whatif-status {
                    font-size: 11px;
                    margin-top: 6px;
                    color: var(--vscode-descriptionForeground);
                    min-height: 16px;
                }
                #whatif-result {
                    margin-top: 8px;
                    font-size: 11px;
                    display: none;
                }
                #whatif-result .field { margin-bottom: 4px; }
                #whatif-result .label { font-weight: 600; color: var(--vscode-foreground); }
                #whatif-result .pill {
                    display: inline-block;
                    background: var(--vscode-badge-background);
                    color: var(--vscode-badge-foreground);
                    border-radius: 10px;
                    padding: 0 6px;
                    font-size: 10px;
                    margin: 1px 2px;
                }
                #whatif-result .pill.api-yes { background: #b71c1c; color: #fff; }
                #whatif-result .pill.api-no  { background: #2e7d32; color: #fff; }
            </style>
        </head>
        <body>
            <button onclick="refresh()">&#8635; Refresh</button>
            <h2>Commit History</h2>
            <pre>${commitsJson}</pre>

            <h2>Current Diff</h2>
            <pre>${diffEscaped}</pre>

            <!-- ══ WHAT IF? ══════════════════════════════════ -->
            <div id="whatif-section">
                <h2>&#129300; What if&hellip;?</h2>
                <textarea
                    id="whatif-prompt"
                    placeholder="Describe a planned change&hellip; e.g. &quot;add auth middleware to all API routes&quot;"
                ></textarea>
                <br>
                <button id="whatif-submit" onclick="submitWhatIf()">Predict Impact</button>
                <div id="whatif-status"></div>
                <div id="whatif-result"></div>
            </div>

            <script>
                const vscode = acquireVsCodeApi();

                function refresh() {
                    vscode.postMessage({ command: 'refresh' });
                }

                function submitWhatIf() {
                    const prompt = document.getElementById('whatif-prompt').value.trim();
                    if (!prompt) { return; }

                    document.getElementById('whatif-submit').disabled = true;
                    document.getElementById('whatif-status').textContent = 'Analysing intent\u2026';
                    document.getElementById('whatif-result').style.display = 'none';

                    vscode.postMessage({ command: 'whatIf', prompt });
                }

                window.addEventListener('message', function(event) {
                    const msg = event.data;

                    if (msg.type === 'whatIfResult') {
                        document.getElementById('whatif-submit').disabled = false;
                        document.getElementById('whatif-status').textContent = '';

                        const d = msg.descriptor;
                        const symbols = (d.symbolHints || []).map(function(s) {
                            return '<span class="pill">' + escHtml(s) + '</span>';
                        }).join('');
                        const files = (d.fileHints || []).map(function(f) {
                            return '<span class="pill">' + escHtml(f) + '</span>';
                        }).join('');
                        const apiPill = d.affectsPublicApi
                            ? '<span class="pill api-yes">Public API affected</span>'
                            : '<span class="pill api-no">Internal only</span>';

                        document.getElementById('whatif-result').innerHTML =
                            '<div class="field"><span class="label">Summary:</span> ' + escHtml(d.summary) + '</div>' +
                            '<div class="field"><span class="label">Change type:</span> ' + escHtml(d.changeType) + '</div>' +
                            '<div class="field"><span class="label">API impact:</span> ' + apiPill + '</div>' +
                            (symbols ? '<div class="field"><span class="label">Symbols:</span> ' + symbols + '</div>' : '') +
                            (files   ? '<div class="field"><span class="label">Files:</span> '   + files   + '</div>' : '');
                        document.getElementById('whatif-result').style.display = 'block';
                    }

                    if (msg.type === 'whatIfError') {
                        document.getElementById('whatif-submit').disabled = false;
                        document.getElementById('whatif-status').textContent = '\u26a0\ufe0f ' + (msg.reason || 'Unknown error');
                    }
                });

                function escHtml(s) {
                    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
                }
            </script>
        </body>
        </html>
        `;
    }
}