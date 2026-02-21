import * as vscode from 'vscode';
import { GraphPanel } from './graphPanel';
import { BlastRadiusResult } from '../core/blast/blastRadiusEngine';
import { StagedFileEntry } from '../core/git/stagedSnapshot';
import { SymbolIndex } from '../core/indexing/symbolIndex';

export class GitVisualizerPanel implements vscode.WebviewViewProvider {
    public static readonly viewType = 'ripplecheck.gitVisualizer';
    private _view?: vscode.WebviewView;

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
            }
        });
    }

    /** Called from extension.ts to signal that analysis is starting. */
    public postAnalysisStart(): void {
        this._view?.webview.postMessage({ type: 'analysisStart' });
    }

    /** Called from extension.ts to push a fatal analysis error to the webview. */
    public postError(message: string): void {
        this._view?.webview.postMessage({ type: 'error', message });
    }

    /**
     * Called from extension.ts after computeStagedBlastRadius completes.
     * Serialises Maps to plain objects before posting (JSON cannot handle Map).
     */
    public postResult(
        result: BlastRadiusResult,
        stagedFiles: StagedFileEntry[],
        symbolIndex: SymbolIndex,
    ): void {
        if (!this._view) { return; }

        // Serialise a symbol ID to a plain object the webview can render.
        const serialiseSymbol = (id: string) => {
            const e = symbolIndex.get(id);
            return e
                ? { id, name: e.name, filePath: e.filePath, kind: e.kind, startLine: e.startLine }
                : { id, name: id, filePath: '', kind: 'unknown', startLine: 0 };
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
      content:    '▶';
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
  </style>
</head>
<body>

  <!-- ══ HEADER ════════════════════════════════════════ -->
  <div id="rc-header">
    <span id="status-dot" title="Idle"></span>
    <span id="rc-title">RippleCheck</span>
    <button class="rc-btn" id="analyze-btn">&#9654; Analyze</button>
  </div>

  <!-- ══ LLM SUMMARY ═══════════════════════════════════ -->
  <details class="rc-coll rc-section" id="summary-section" open>
    <summary>AI Summary</summary>
    <div id="summary-card">
      <div class="skel w-full"></div>
      <div class="skel w-3q"></div>
      <div class="skel w-half"></div>
      <div id="summary-text"></div>
    </div>
  </details>

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

  <!-- ══ GRAPH ═════════════════════════════════════════ -->
  <div id="graph-section" class="rc-section">
    <div class="sec-inner graph-open-area">
      <button class="rc-btn wide-btn" id="open-graph-btn">&#9741; Open Graph View</button>
    </div>
  </div>

  <script nonce="${nonce}">
  (function () {
    'use strict';

    const vscode = acquireVsCodeApi();

    // ── Analyze button ───────────────────────────────────────────────────
    document.getElementById('analyze-btn').addEventListener('click', () => {
      vscode.postMessage({ command: 'analyze' });
    });

    // ── Open Graph button ────────────────────────────────────────────────
    document.getElementById('open-graph-btn').addEventListener('click', () => {
      vscode.postMessage({ command: 'openGraph' });
    });

    // ── Incoming messages from extension host ────────────────────────────
    window.addEventListener('message', event => {
      const msg = event.data;
      switch (msg.type) {

        case 'analysisStart':
          setStatus('analyzing');
          // Reset all lists to "loading" state
          setText('changed-count', '0');
          setText('direct-count',  '0');
          setText('indirect-count','0');
          setHtml('changed-files-list', '<div class="empty-state">Analyzing\u2026</div>');
          setHtml('direct-list',        '<div class="empty-state">\u2014</div>');
          setHtml('indirect-list',      '<div class="empty-state">\u2014</div>');
          // Reset LLM summary skeleton
          document.querySelectorAll('.skel').forEach(function(el) { el.style.display = ''; });
          document.getElementById('summary-text').textContent = '';
          document.getElementById('summary-text').style.display = 'none';
          break;

        case 'analysisResult': {
          setStatus('done');

          // Build root-reason lookup
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

        case 'error':
          setStatus('error');
          break;
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

    /**
     * Render an impact symbol list into listId / countId elements.
     *
     * @param {string}   listId       - ID of the container element
     * @param {string}   countId      - ID of the badge element
     * @param {Array}    symbols      - serialised SymbolEntry objects
     * @param {Object}   depthMap     - { [symbolId]: number }
     * @param {Object}   rootReasonMap - { [symbolId]: RootReason }
     * @param {Object}   paths        - { [symbolId]: string[][] }
     * @param {Object}   nameMap      - { [symbolId]: string }
     */
    function renderImpactList(listId, countId, symbols, depthMap, rootReasonMap, paths, nameMap) {
      var listEl  = document.getElementById(listId);
      var countEl = document.getElementById(countId);
      if (!symbols || symbols.length === 0) {
        countEl.textContent = '0';
        listEl.innerHTML    = '<div class="empty-state">\u2014</div>';
        return;
      }
      countEl.textContent = symbols.length;
      listEl.innerHTML = symbols.map(function(sym) {
        var depth     = depthMap[sym.id] !== undefined ? depthMap[sym.id] : '?';
        var reason    = rootReasonMap[sym.id] || '';
        var shortFile = sym.filePath
          ? sym.filePath.replace(/^.*\\/([^\\/]+\\/[^\\/]+)$/, '$1').replace(/^.*\\/([^\\/]+)$/, '$1')
          : '';
        var symPaths  = paths[sym.id] || [];
        var pathHtml  = '';
        if (symPaths.length > 0) {
          pathHtml = '<div class="path-trace">' +
            symPaths.map(function(p) {
              return p.map(function(id) { return escHtml(nameMap[id] || id); }).join(' \u2192 ');
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

      // Toggle path-trace on click
      listEl.querySelectorAll('.impact-row').forEach(function(row) {
        row.querySelector('.impact-hdr').addEventListener('click', function() {
          row.classList.toggle('expanded');
        });
      });
    }

  }());
  </script>

</body>
</html>`;
    }
}