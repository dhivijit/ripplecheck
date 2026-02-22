import * as vscode from 'vscode';
import { GraphPanel } from './graphPanel';
import { BlastRadiusResult } from '../core/blast/blastRadiusEngine';
import { StagedFileEntry } from '../core/git/stagedSnapshot';
import { SymbolIndex } from '../core/indexing/symbolIndex';
import { IntentDescriptor, IntentParseError } from '../core/intent/types';
import { PredictiveBlastRadiusResult } from '../core/intent/predictiveEngine';

export class GitVisualizerPanel implements vscode.WebviewViewProvider {
    public static readonly viewType = 'ripplecheck.gitVisualizer';
    private _view?: vscode.WebviewView;

    /**
     * Called when the user submits a "What if?" prompt.
     * Extension.ts runs the full pipeline (parse → resolve → BFS) and posts
     * results back via postWhatIfIntent() / postPredictedResult() / postError().
     */
    public onWhatIfRequest?: (
        prompt: string,
        token: vscode.CancellationToken,
    ) => Promise<void>;

    constructor(private readonly extensionUri: vscode.Uri) { }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extensionUri],
        };

        webviewView.webview.html = this.getHtml(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(message => {
            switch (message.command) {
                case 'analyze':
                    vscode.commands.executeCommand('ripplecheck.analyze');
                    break;
                case 'openFile':
                    vscode.workspace.openTextDocument(message.path)
                        .then(doc => vscode.window.showTextDocument(doc, { preview: false }))
                        .then(undefined, err => console.error('[RippleCheck] openFile error:', err));
                    break;
                case 'openGraph':
                    GraphPanel.createOrShow(this.extensionUri);
                    break;
                case 'graphToggle':
                    GraphPanel.postToggle(message.mode as 'full' | 'session');
                    break;
                case 'whatIf': {
                    if (!this.onWhatIfRequest) {
                        this._view?.webview.postMessage({
                            type:    'error',
                            source:  'whatIf',
                            message: 'Workspace still loading — try again in a moment.',
                        });
                        return;
                    }
                    const cts = new vscode.CancellationTokenSource();
                    this.onWhatIfRequest(message.prompt as string, cts.token)
                        .catch((err: unknown) => {
                            this._view?.webview.postMessage({
                                type:    'error',
                                source:  'whatIf',
                                message: String(err),
                            });
                        })
                        .finally(() => cts.dispose());
                    break;
                }
            }
        });
    }

    /** Called from extension.ts to signal that analysis is starting. */
    public postAnalysisStart(): void {
        this._view?.webview.postMessage({ type: 'analysisStart' });
    }

    /** Called from extension.ts to push a fatal analysis error to the webview. */
    public postError(message: string, source: 'analyse' | 'whatIf' = 'analyse'): void {
        this._view?.webview.postMessage({ type: 'error', source, message });
    }

    /**
     * Called from extension.ts after computeStagedBlastRadius completes.
     * Serialises Maps to plain objects before posting (JSON cannot handle Map).
     */
    public postResult(
        result: BlastRadiusResult,
        stagedFiles: StagedFileEntry[],
        symbolIndex: SymbolIndex,
        workspaceRootPath: string,
    ): void {
        if (!this._view) { return; }

        // Normalise and ensure trailing slash so startsWith strips cleanly.
        const normalRoot = workspaceRootPath.replace(/\\/g, '/').replace(/\/?$/, '/');

        const toRelPath = (absPath: string): string => {
            const p = absPath.replace(/\\/g, '/');
            return p.startsWith(normalRoot) ? p.slice(normalRoot.length) : p;
        };

        // Parse a raw symbol ID (`absFilePath#symbolName`) into display parts.
        const parseSymbolId = (id: string): { name: string; filePath: string } => {
            const hash = id.indexOf('#');
            if (hash === -1) { return { name: id, filePath: '' }; }
            return { name: id.slice(hash + 1), filePath: toRelPath(id.slice(0, hash)) };
        };

        // Serialise a symbol ID to a plain object the webview can render.
        const serialiseSymbol = (id: string) => {
            const e = symbolIndex.get(id);
            if (!e) {
                const { name, filePath } = parseSymbolId(id);
                return { id, name, filePath, kind: 'unknown', startLine: 0 };
            }
            return { id, name: e.name, filePath: toRelPath(e.filePath), kind: e.kind, startLine: e.startLine };
        };

        // Build a flat name-lookup table for every symbol referenced in any path
        // so the webview can display human-readable path traces.
        const symbolNameMap: Record<string, string> = {};
        for (const pathList of result.paths.values()) {
            for (const path of pathList) {
                for (const sid of path) {
                    if (!symbolNameMap[sid]) {
                        const sym = symbolIndex.get(sid);
                        symbolNameMap[sid] = sym ? sym.name : sid;
                    }
                }
            }
        }

        this._view.webview.postMessage({
            type: 'analysisResult',
            roots: result.roots,
            directImpact: result.directImpact.map(serialiseSymbol),
            indirectImpact: result.indirectImpact.map(serialiseSymbol),
            depthMap: Object.fromEntries(result.depthMap),
            paths: Object.fromEntries(result.paths),
            symbolNameMap,
            stagedFiles,
        });
    }

    /** Push the parsed intent descriptor immediately after LLM parsing completes. */
    public postWhatIfIntent(descriptor: IntentDescriptor): void {
        this._view?.webview.postMessage({ type: 'whatIfIntent', descriptor });
    }

    /** Push the full predicted blast radius (What If pipeline completion). */
    public postPredictedResult(result: PredictiveBlastRadiusResult): void {
        this._view?.webview.postMessage({
            type:           'predictedResult',
            isRelevant:     result.isRelevant,
            changeType:     result.changeType,
            roots:          result.roots,
            directImpact:   result.directImpact,
            indirectImpact: result.indirectImpact,
            depthMap:       Object.fromEntries(result.depthMap),
            confidenceMap:  Object.fromEntries(result.confidenceMap),
            phantomIds:     result.phantomIds,
            resolvedRoots:  result.resolvedRoots.map(s => ({
                name:       s.name,
                filePath:   s.filePath,
                confidence: s.confidence,
            })),
            paths:          Object.fromEntries(
                Array.from(result.paths.entries()).map(([k, v]) => [k, v]),
            ),
        });
    }

    /** Compatibility shim — converts an IntentParseError to a postError call. */
    public postWhatIfError(error: IntentParseError): void {
        this.postError(error.reason, 'whatIf');
    }

    private getNonce(): string {
        let text = '';
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        for (let i = 0; i < 32; i++) {
            text += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return text;
    }

    private getHtml(webview: vscode.Webview): string {
        const nonce = this.getNonce();
        return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none';
                 script-src 'nonce-${nonce}';
                 style-src  'unsafe-inline';">
  <title>RippleCheck</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    html, body {
      height: 100%;
    }

    body {
        display:     flex;
        flex-direction: column;
      font-family: var(--vscode-font-family);
      font-size:   var(--vscode-font-size);
      color:       var(--vscode-foreground);
      background:  var(--vscode-sideBar-background);
      overflow-y:  auto;
    }

    /* ─── Header ──────────────────────────────────────── */
    #rc-header {
      display:    flex;
      align-items: center;
      gap:        6px;
      padding:    8px 10px;
      border-bottom: 1px solid var(--vscode-panel-border, #444);
      position:   sticky;
      top:        0;
      background: var(--vscode-sideBar-background);
      z-index:    10;
    }

    #status-dot {
      width:        8px;
      height:       8px;
      border-radius: 50%;
      flex-shrink:  0;
      background:   var(--vscode-descriptionForeground);
      transition:   background 0.3s;
    }
    #status-dot.analyzing { background: #f0a500; }
    #status-dot.done      { background: #4caf50; }
    #status-dot.error     { background: #f44336; }

    #rc-title {
      flex:           1;
      font-weight:    600;
      font-size:      11px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--vscode-sideBarTitle-foreground, var(--vscode-foreground));
    }

    /* ─── Buttons ─────────────────────────────────────── */
    .rc-btn {
      background:   var(--vscode-button-background);
      color:        var(--vscode-button-foreground);
      border:       none;
      border-radius: 2px;
      padding:      3px 8px;
      font-size:    11px;
      cursor:       pointer;
      white-space:  nowrap;
    }
    .rc-btn:hover { background: var(--vscode-button-hoverBackground); }
    .rc-btn:disabled { opacity: 0.5; cursor: default; }

    .rc-btn-sm {
      background:   transparent;
      color:        var(--vscode-foreground);
      border:       1px solid var(--vscode-button-border, var(--vscode-panel-border, #666));
      border-radius: 2px;
      padding:      2px 7px;
      font-size:    10px;
      cursor:       pointer;
      white-space:  nowrap;
    }
    .rc-btn-sm:hover  { background: var(--vscode-toolbar-hoverBackground); }
    .rc-btn-sm.active {
      background: var(--vscode-button-background);
      color:      var(--vscode-button-foreground);
      border-color: var(--vscode-button-background);
    }

    .icon-btn {
      background:    transparent;
      border:        none;
      color:         var(--vscode-foreground);
      cursor:        pointer;
      padding:       2px 5px;
      border-radius: 2px;
      font-size:     13px;
      line-height:   1;
    }
    .icon-btn:hover { background: var(--vscode-toolbar-hoverBackground); }

    /* ─── Section / collapsible ───────────────────────── */
    .rc-section {
      border-bottom: 1px solid var(--vscode-panel-border, #444);
    }

    details.rc-coll > summary {
      display:        flex;
      align-items:    center;
      gap:            6px;
      padding:        6px 10px;
      cursor:         pointer;
      user-select:    none;
      list-style:     none;
      font-size:      11px;
      font-weight:    600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--vscode-sideBarSectionHeader-foreground, var(--vscode-foreground));
    }
    details.rc-coll > summary::-webkit-details-marker { display: none; }
    details.rc-coll > summary::before {
      content:    '\\25B6';
      font-size:  8px;
      transition: transform 0.15s;
      flex-shrink: 0;
    }
    details.rc-coll[open] > summary::before { transform: rotate(90deg); }

    .sec-inner { padding: 6px 10px 10px; }

    /* ─── Badge ───────────────────────────────────────── */
    .badge {
      background:   var(--vscode-badge-background);
      color:        var(--vscode-badge-foreground);
      border-radius: 10px;
      padding:      0 5px;
      font-size:    10px;
      font-weight:  600;
      min-width:    16px;
      text-align:   center;
      margin-left:  auto;
    }

    /* ─── Empty state ─────────────────────────────────── */
    .empty-state {
      font-size: 11px;
      color:     var(--vscode-descriptionForeground);
      text-align: center;
      padding:   8px 0;
    }

    .error-state {
      color: var(--vscode-errorForeground, #f88);
      font-size: 11px;
      word-break: break-word;
    }

    /* ─── LLM Summary Card ────────────────────────────── */
    #summary-card { padding: 10px; }

    .skel {
      height:       10px;
      border-radius: 4px;
      background:   var(--vscode-editor-inactiveSelectionBackground, #333);
      margin-bottom: 7px;
      animation:    shimmer 1.6s ease-in-out infinite;
    }
    .skel.w-full   { width: 100%; }
    .skel.w-3q     { width: 75%;  }
    .skel.w-half   { width: 50%;  }

    @keyframes shimmer {
      0%, 100% { opacity: 0.45; }
      50%       { opacity: 0.9;  }
    }

    #summary-text {
      font-size:   12px;
      line-height: 1.5;
      display:     none;
    }

    /* ─── Changed files ───────────────────────────────── */
    .file-row {
      display:     flex;
      align-items: center;
      gap:         6px;
      padding:     3px 2px;
      cursor:      pointer;
      border-radius: 2px;
    }
    .file-row:hover { background: var(--vscode-list-hoverBackground); }

    .st-badge {
      font-size:    10px;
      font-weight:  700;
      border-radius: 2px;
      padding:      0 4px;
      flex-shrink:  0;
    }
    .st-M { background: #1565c0; color: #fff; }
    .st-A { background: #2e7d32; color: #fff; }
    .st-D { background: #b71c1c; color: #fff; }
    .st-R { background: #e65100; color: #fff; }
    .st-C { background: #6a1b9a; color: #fff; }

    .file-path {
      font-size:     11px;
      overflow:      hidden;
      text-overflow: ellipsis;
      white-space:   nowrap;
    }

    /* ─── Impact rows ─────────────────────────────────── */
    .impact-row {
      padding:       4px 2px;
      border-bottom: 1px solid var(--vscode-panel-border, transparent);
    }
    .impact-row:last-child { border-bottom: none; }

    .impact-hdr {
      display:     flex;
      align-items: center;
      gap:         5px;
      cursor:      pointer;
    }
    .sym-name {
      font-size:     12px;
      font-weight:   500;
      flex:          1;
      overflow:      hidden;
      text-overflow: ellipsis;
      white-space:   nowrap;
    }
    .depth-badge {
      font-size:    10px;
      border-radius: 10px;
      padding:      0 5px;
      background:   var(--vscode-badge-background);
      color:        var(--vscode-badge-foreground);
      flex-shrink:  0;
    }
    .reason-tag {
      font-size:    9px;
      border-radius: 2px;
      padding:      1px 4px;
      flex-shrink:  0;
      background:   var(--vscode-editor-inactiveSelectionBackground, #333);
      color:        var(--vscode-descriptionForeground);
    }
    .sym-file {
      font-size:     10px;
      color:         var(--vscode-descriptionForeground);
      margin-top:    2px;
      overflow:      hidden;
      text-overflow: ellipsis;
      white-space:   nowrap;
    }
    .path-trace {
      font-size:   10px;
      color:       var(--vscode-descriptionForeground);
      margin-top:  4px;
      padding-left: 10px;
      display:     none;
    }
    .impact-row.expanded .path-trace { display: block; }

    /* ─── Blast radius fills space when open; graph stays at bottom ── */
    #blast-radius-section[open] {
      flex:       1;
      min-height: 0;
      overflow-y: auto;
    }

    #graph-section {
      margin-top: auto;
    }

    /* ─── Graph open section ──────────────────────────── */
    .graph-open-area {
      display:        flex;
      flex-direction: column;
      gap:            8px;
    }

    .wide-btn {
      width:      100%;
      text-align: center;
      padding:    6px 8px;
      font-size:  12px;
    }

    #graph-toggle-row {
      display:     flex;
      align-items: center;
      gap:         5px;
    }

    .toggle-label {
      font-size: 10px;
      color:     var(--vscode-descriptionForeground);
    }

    /* ─── What If? ────────────────────────────────────── */
    #whatif-textarea {
      width: 100%;
      min-height: 58px;
      resize: vertical;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, #555);
      border-radius: 2px;
      padding: 5px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      margin-bottom: 6px;
    }
    #whatif-textarea:focus { outline: 1px solid var(--vscode-focusBorder); border-color: transparent; }

    .spinner {
      width: 10px; height: 10px; flex-shrink: 0;
      border: 2px solid var(--vscode-descriptionForeground);
      border-top-color: var(--vscode-button-background);
      border-radius: 50%; animation: spin 0.7s linear infinite; display: none;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .spinner.active { display: inline-block; }

    .status-bar {
      font-size: 10px; color: var(--vscode-descriptionForeground);
      min-height: 14px; display: flex; align-items: center; gap: 5px;
    }

    .intent-box { margin-top: 8px; font-size: 11px; }
    .intent-row { margin-bottom: 3px; }
    .intent-label { font-weight: 600; margin-right: 4px; }
    .pill {
      display: inline-flex; align-items: center;
      background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
      border-radius: 10px; padding: 0 6px; font-size: 10px; margin: 1px 2px;
    }
    .pill-api-yes { background: #7b1e1e; color: #ffcdd2; }
    .pill-api-no  { background: #1b5e20; color: #c8e6c9; }
    .b-pred   { background: #5c3d9e; color: #e0d0ff; }
    .b-high   { background: #1a5c1a; color: #a8ffb0; }
    .b-medium { background: #7a5200; color: #ffe5a0; }
    .b-low    { background: #5c1a1a; color: #ffc8c8; }
    .predict-divider {
      font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em;
      color: #c0a0ff; display: flex; align-items: center; gap: 5px;
      margin: 8px 0 6px; border-top: 1px solid var(--vscode-panel-border, #444); padding-top: 8px;
    }
    .sym-list { list-style: none; display: flex; flex-direction: column; gap: 2px; }
    .sym-item {
      display: flex; align-items: flex-start; justify-content: space-between; gap: 4px;
      padding: 3px 5px; border-radius: 2px;
      background: var(--vscode-list-inactiveSelectionBackground, rgba(255,255,255,0.04));
      font-size: 11px;
    }
    .sym-info { flex: 1; overflow: hidden; min-width: 0; }
    .badges { display: flex; align-items: center; gap: 2px; flex-shrink: 0; }
    .more-hint { font-size: 10px; color: var(--vscode-descriptionForeground); padding: 2px 4px; font-style: italic; }
    .impact-group { margin-bottom: 8px; }
    .impact-group:last-child { margin-bottom: 0; }
    .impact-label {
      font-size: 10px; font-weight: 600; text-transform: uppercase;
      letter-spacing: 0.04em; color: var(--vscode-descriptionForeground); margin-bottom: 3px;
    }
  </style>
</head>
<body>

  <!-- ══ HEADER ════════════════════════════════════════ -->
  <div id="rc-header">
    <span id="status-dot" title="Idle"></span>
    <span id="rc-title">RippleCheck</span>
    <button class="rc-btn" id="analyze-btn">&#9654; Analyze</button>
  </div>

  <!-- ══ CHANGED FILES ═════════════════════════════════ -->
  <details class="rc-coll rc-section" id="changed-files-section" open>
    <summary>
      Changed Files
      <span class="badge" id="changed-count">0</span>
    </summary>
    <div class="sec-inner" id="changed-files-list">
      <div class="empty-state">No staged changes detected</div>
    </div>
  </details>

  <!-- ══ BLAST RADIUS ══════════════════════════════════ -->
  <details class="rc-coll rc-section" id="blast-radius-section" open>
    <summary>Blast Radius</summary>
    <div class="sec-inner">

      <details class="rc-coll" id="direct-section" open>
        <summary>
          Direct Impact
          <span class="badge" id="direct-count">0</span>
        </summary>
        <div class="sec-inner" id="direct-list">
          <div class="empty-state">&#8212;</div>
        </div>
      </details>

      <details class="rc-coll" id="indirect-section" open>
        <summary>
          Indirect Impact
          <span class="badge" id="indirect-count">0</span>
        </summary>
        <div class="sec-inner" id="indirect-list">
          <div class="empty-state">&#8212;</div>
        </div>
      </details>

    </div>
  </details>

  <!-- ══ WHAT IF? ══════════════════════════════════════ -->
  <details class="rc-coll rc-section" id="whatif-section" open>
    <summary>&#129300; What if?</summary>
    <div class="sec-inner">
      <textarea id="whatif-textarea"
        placeholder="Describe a planned change\\u2026\\ne.g. &quot;add rate limiting to all API routes&quot;"
      ></textarea>
      <button class="rc-btn" id="whatif-submit-btn">Predict Impact</button>
      <div class="status-bar" style="margin-top:6px">
        <div class="spinner" id="whatif-spinner"></div>
        <span id="whatif-status"></span>
      </div>
      <div id="whatif-intent"></div>
      <div id="whatif-content"></div>
    </div>
  </details>

  <!-- ══ GRAPH ═════════════════════════════════════════ -->
  <div id="graph-section" class="rc-section">
    <div class="sec-inner graph-open-area">
      <button class="rc-btn wide-btn" id="open-graph-btn">&#9741; Open Graph View</button>
    </div>
  </div>

  <script nonce="${nonce}">
  (function () {
    'use strict';

    var vscode = acquireVsCodeApi();

    // ── Analyze button ───────────────────────────────────────────────────
    document.getElementById('analyze-btn').addEventListener('click', function() {
      vscode.postMessage({ command: 'analyze' });
    });

    // ── Open Graph button ────────────────────────────────────────────────
    document.getElementById('open-graph-btn').addEventListener('click', function() {
      vscode.postMessage({ command: 'openGraph' });
    });

    // ── What If? submit ──────────────────────────────────────────────────
    document.getElementById('whatif-submit-btn').addEventListener('click', function() {
      var prompt = document.getElementById('whatif-textarea').value.trim();
      if (!prompt) { return; }
      setWhatIfBusy(true);
      document.getElementById('whatif-intent').innerHTML = '';
      document.getElementById('whatif-content').innerHTML = '';
      vscode.postMessage({ command: 'whatIf', prompt: prompt });
    });

    function setWhatIfBusy(active) {
      document.getElementById('whatif-submit-btn').disabled = active;
      document.getElementById('whatif-spinner').classList.toggle('active', active);
      if (!active) { document.getElementById('whatif-status').textContent = ''; }
    }

    // ── Incoming messages from extension host ────────────────────────────
    window.addEventListener('message', function(event) {
      var msg = event.data;
      switch (msg.type) {

        case 'analysisStart':
          setStatus('analyzing');
          setText('changed-count', '0');
          setText('direct-count',  '0');
          setText('indirect-count','0');
          setHtml('changed-files-list', '<div class="empty-state">Analyzing\\u2026</div>');
          setHtml('direct-list',        '<div class="empty-state">\\u2014</div>');
          setHtml('indirect-list',      '<div class="empty-state">\\u2014</div>');
          document.querySelectorAll('.skel').forEach(function(el) { el.style.display = ''; });
          document.getElementById('summary-text').textContent = '';
          document.getElementById('summary-text').style.display = 'none';
          break;

        case 'analysisResult': {
          setStatus('done');

          var rootReasonMap = {};
          (msg.roots || []).forEach(function(root) {
            rootReasonMap[root.symbolId] = root.reason;
          });

          // ── Changed files ──────────────────────────────────────────────
          var stagedFiles = msg.stagedFiles || [];
          setText('changed-count', stagedFiles.length);
          if (stagedFiles.length > 0) {
            setHtml('changed-files-list', stagedFiles.map(function(f) {
              var short = (f.absolutePath || '').split('/').slice(-3).join('/');
              return '<div class="file-row" data-path="' + escHtml(f.absolutePath || '') + '">' +
                     '<span class="st-badge st-' + f.status + '">' + f.status + '</span>' +
                     '<span class="file-path" title="' + escHtml(f.absolutePath || '') + '">' + escHtml(short) + '</span>' +
                     '</div>';
            }).join(''));
            document.getElementById('changed-files-list')
              .querySelectorAll('.file-row').forEach(function(row) {
                row.addEventListener('click', function() {
                  vscode.postMessage({ command: 'openFile', path: row.dataset.path });
                });
              });
          } else {
            setHtml('changed-files-list', '<div class="empty-state">No staged changes detected</div>');
          }

          // ── Direct / indirect impact ───────────────────────────────────
          renderImpactList('direct-list',   'direct-count',
            msg.directImpact || [], msg.depthMap || {}, rootReasonMap,
            msg.paths || {}, msg.symbolNameMap || {});

          renderImpactList('indirect-list', 'indirect-count',
            msg.indirectImpact || [], msg.depthMap || {}, rootReasonMap,
            msg.paths || {}, msg.symbolNameMap || {});
          break;
        }

        case 'whatIfIntent': {
          document.getElementById('whatif-status').textContent = 'Predicting blast radius\\u2026';
          document.getElementById('whatif-intent').innerHTML = renderIntent(msg.descriptor);
          break;
        }

        case 'predictedResult': {
          setWhatIfBusy(false);
          if (!msg.isRelevant) {
            document.getElementById('whatif-status').textContent = '';
            document.getElementById('whatif-content').innerHTML =
              '<div class="empty-state">' +
              '\\u26a0\\ufe0f This change doesn\\u2019t appear to involve code in this repository.' +
              '<br><br>No indexed symbols matched the described feature. ' +
              'Try describing which existing function, class, or file you want to modify.' +
              '</div>';
            break;
          }
          var t = msg.directImpact.length + msg.indirectImpact.length;
          var phantoms = (msg.phantomIds || []).length;
          var rooted = msg.resolvedRoots ? msg.resolvedRoots.length : 0;
          document.getElementById('whatif-status').textContent =
            rooted === 0
              ? 'No matching symbols found.'
              : t === 0 && phantoms === 0
              ? rooted + ' symbol(s) in scope \\u2014 none have tracked dependents.'
              : t === 0 && phantoms > 0
              ? 'New symbol(s) to be added \\u2014 no existing dependents affected.'
              : rooted + ' symbol(s) in scope \\u2192 ' + t + ' dependent(s) at risk';
          var content =
            renderRoots(msg.resolvedRoots || [], msg.changeType) +
            renderPredictedLists(msg.directImpact, msg.indirectImpact, msg.depthMap, msg.confidenceMap, msg.phantomIds || [], msg.paths || {});
          document.getElementById('whatif-content').innerHTML = content;
          break;
        }

        case 'llmChunk': {
          var summaryEl = document.getElementById('summary-text');
          summaryEl.textContent += (msg.text || '');
          summaryEl.style.display = 'block';
          document.querySelectorAll('.skel').forEach(function(el) { el.style.display = 'none'; });
          break;
        }

        case 'llmDone':
          document.querySelectorAll('.skel').forEach(function(el) { el.style.display = 'none'; });
          document.getElementById('summary-text').style.display = 'block';
          break;

        case 'error': {
          var errHtml = '<div class="error-state">\\u26a0\\ufe0f ' + escHtml(msg.message) + '</div>';
          if (msg.source === 'whatIf') {
            setWhatIfBusy(false);
            document.getElementById('whatif-content').innerHTML = errHtml;
          } else {
            setStatus('error');
          }
          break;
        }
      }
    });

    // ── Helpers ──────────────────────────────────────────────────────────
    function setStatus(state) {
      var dot = document.getElementById('status-dot');
      dot.className = '';
      if (state !== 'idle') { dot.classList.add(state); }
      dot.title = state.charAt(0).toUpperCase() + state.slice(1);
    }

    function setText(id, val) {
      document.getElementById(id).textContent = val;
    }

    function setHtml(id, html) {
      document.getElementById(id).innerHTML = html;
    }

    function escHtml(s) {
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function renderImpactList(listId, countId, symbols, depthMap, rootReasonMap, paths, nameMap) {
      var listEl  = document.getElementById(listId);
      var countEl = document.getElementById(countId);
      if (!symbols || symbols.length === 0) {
        countEl.textContent = '0';
        listEl.innerHTML    = '<div class="empty-state">\\u2014</div>';
        return;
      }
      countEl.textContent = symbols.length;
      listEl.innerHTML = symbols.map(function(sym) {
        var depth     = depthMap[sym.id] !== undefined ? depthMap[sym.id] : '?';
        var reason    = rootReasonMap[sym.id] || '';
        var shortFile = sym.filePath || '';
        var symPaths  = paths[sym.id] || [];
        var pathHtml  = '';
        if (symPaths.length > 0) {
          pathHtml = '<div class="path-trace">' +
            symPaths.map(function(p) {
              return p.map(function(id) { return escHtml(nameMap[id] || id); }).join(' \\u2192 ');
            }).join('<br>') +
            '</div>';
        }
        return '<div class="impact-row">' +
               '<div class="impact-hdr" role="button">' +
               '<span class="sym-name" title="' + escHtml(sym.name) + '">' + escHtml(sym.name) + '</span>' +
               '<span class="depth-badge">d' + depth + '</span>' +
               (reason ? '<span class="reason-tag">' + escHtml(reason) + '</span>' : '') +
               '</div>' +
               '<div class="sym-file">' + escHtml(shortFile) + (sym.startLine ? ':' + sym.startLine : '') + '</div>' +
               pathHtml +
               '</div>';
      }).join('');

      listEl.querySelectorAll('.impact-row').forEach(function(row) {
        row.querySelector('.impact-hdr').addEventListener('click', function() {
          row.classList.toggle('expanded');
        });
      });
    }

    // ── What If? rendering helpers ───────────────────────────────────────

    function symParts(id) {
      if (id.startsWith('__phantom__#')) {
        return { name: id.slice('__phantom__#'.length), file: '', isPhantom: true };
      }
      var h = id.lastIndexOf('#');
      if (h < 0) { return { name: id, file: '', isPhantom: false }; }
      var filePart = id.slice(0, h);
      var fileName = filePart.split('/').pop() || filePart;
      return { name: id.slice(h + 1), file: fileName, isPhantom: false };
    }

    function renderRoots(resolvedRoots, changeType) {
      if (!resolvedRoots || resolvedRoots.length === 0) { return ''; }
      var label = changeType === 'delete'
        ? 'Being deleted'
        : changeType === 'add'
        ? 'Points of integration'
        : 'In scope';
      var html = '<div class="impact-group"><div class="impact-label">' + escHtml(label) + ' (' + resolvedRoots.length + ')</div>';
      html += '<ul class="sym-list">';
      var shown = Math.min(resolvedRoots.length, 10);
      for (var i = 0; i < shown; i++) {
        var r = resolvedRoots[i];
        var fileName = r.filePath ? (r.filePath.split('/').pop() || r.filePath) : '';
        html += '<li class="sym-item"><div class="sym-info">';
        html += '<div class="sym-name">' + escHtml(r.name) + '</div>';
        if (fileName) { html += '<div class="sym-file">' + escHtml(fileName) + '</div>'; }
        html += '</div><div class="badges">';
        html += '<span class="badge b-' + r.confidence + '">' + confLabel(r.confidence) + '</span>';
        html += '</div></li>';
      }
      html += '</ul>';
      if (resolvedRoots.length > shown) {
        html += '<div class="more-hint">&hellip; and ' + (resolvedRoots.length - shown) + ' more</div>';
      }
      html += '</div>';
      return html;
    }

    function confLabel(c) {
      if (c === 'high')   { return 'high confidence'; }
      if (c === 'medium') { return 'med confidence'; }
      return 'low confidence';
    }

    function renderPath(paths, id) {
      if (!paths || !paths[id] || !paths[id].length) { return ''; }
      var best = paths[id][0];
      if (best.length < 2) { return ''; }
      var parts = best.map(function(pid) { return symParts(pid).name; });
      var chain;
      if (parts.length <= 3) {
        chain = parts.join(' \\u2192 ');
      } else {
        chain = parts[0] + ' \\u2192 \\u2026 \\u2192 ' + parts[parts.length - 2] + ' \\u2192 ' + parts[parts.length - 1];
      }
      return '<div class="path-trace" style="display:block">' + escHtml(chain) + '</div>';
    }

    var MAX_INDIRECT = 8;

    function renderPredictedLists(direct, indirect, depthMap, confMap, phantomIds, paths) {
      var html = '';

      if (phantomIds && phantomIds.length > 0) {
        html += '<div class="impact-group"><div class="impact-label">To be created</div>';
        html += '<ul class="sym-list">';
        for (var i = 0; i < phantomIds.length; i++) {
          var p = symParts(phantomIds[i]);
          html += '<li class="sym-item"><div class="sym-info">';
          html += '<div class="sym-name">' + escHtml(p.name) + '</div>';
          html += '<div class="sym-file">New \\u2014 does not exist yet</div>';
          html += '</div><div class="badges"><span class="badge b-pred">NEW</span></div></li>';
        }
        html += '</ul></div>';
      }

      if (direct.length === 0 && indirect.length === 0) {
        if (!phantomIds || phantomIds.length === 0) {
          html += '<div class="empty-state">No dependents found.</div>';
        }
        return html;
      }

      if (direct.length > 0) {
        html += '<div class="impact-group"><div class="impact-label">Direct (' + direct.length + ')</div>';
        html += '<ul class="sym-list">';
        for (var i = 0; i < direct.length; i++) { html += renderPredSym(direct[i], depthMap, confMap, paths); }
        html += '</ul></div>';
      }

      if (indirect.length > 0) {
        html += '<div class="impact-group"><div class="impact-label">Indirect (' + indirect.length + ')</div>';
        html += '<ul class="sym-list">';
        var shown = Math.min(indirect.length, MAX_INDIRECT);
        for (var i = 0; i < shown; i++) { html += renderPredSym(indirect[i], depthMap, confMap, paths); }
        html += '</ul>';
        if (indirect.length > MAX_INDIRECT) {
          html += '<div class="more-hint">&hellip; and ' + (indirect.length - MAX_INDIRECT) + ' more</div>';
        }
        html += '</div>';
      }

      return html;
    }

    function renderPredSym(id, depthMap, confMap, paths) {
      var p     = symParts(id);
      var depth = depthMap && depthMap[id] !== undefined ? depthMap[id] : '?';
      var conf  = confMap ? confMap[id] : null;
      var html  = '<li class="sym-item"><div class="sym-info">';
      html += '<div class="sym-name">' + escHtml(p.name) + '</div>';
      html += '<div class="sym-file">' + escHtml(p.file) + '</div>';
      html += renderPath(paths, id);
      html += '</div><div class="badges">';
      var depthLabel = depth === 1 ? 'direct' : 'depth\\u00a0' + depth;
      html += '<span class="badge depth-badge">' + depthLabel + '</span>';
      if (conf) { html += '<span class="badge b-' + conf + '">' + confLabel(conf) + '</span>'; }
      html += '</div></li>';
      return html;
    }

    function renderIntent(d) {
      var apiPill = d.affectsPublicApi
        ? '<span class="pill pill-api-yes">Public API</span>'
        : '<span class="pill pill-api-no">Internal only</span>';
      var html = '<div class="intent-box">';
      html += '<div class="intent-row"><span class="intent-label">Summary: </span>' + escHtml(d.summary) + '</div>';
      html += '<div class="intent-row"><span class="intent-label">Change type: </span>' + escHtml(d.changeType) + '</div>';
      html += '<div class="intent-row"><span class="intent-label">Scope: </span>' + apiPill + '</div>';
      if (d.symbolHints && d.symbolHints.length) {
        html += '<div class="intent-row"><span class="intent-label">LLM matched: </span>';
        for (var i = 0; i < d.symbolHints.length; i++) {
          html += '<span class="pill">' + escHtml(d.symbolHints[i]) + '</span>';
        }
        html += '</div>';
      }
      if (d.fileHints && d.fileHints.length) {
        html += '<div class="intent-row"><span class="intent-label">In files: </span>';
        for (var i = 0; i < d.fileHints.length; i++) {
          html += '<span class="pill">' + escHtml(d.fileHints[i]) + '</span>';
        }
        html += '</div>';
      }
      html += '<div class="predict-divider"><span class="badge b-pred">PREDICTED</span>&nbsp;Blast Radius</div>';
      html += '</div>';
      return html;
    }

  }());
  </script>

</body>
</html>`;
    }
}