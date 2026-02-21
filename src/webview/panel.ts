import * as vscode from 'vscode';
import { BlastRadiusResult } from '../core/blast/blastRadiusEngine';
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

    /**
     * Called when the user clicks "Analyse" in the sidebar.
     * Extension.ts wires this to computeStagedBlastRadius.
     */
    public onAnalyseRequest?: () => void;

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ): void | Thenable<void> {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = this._buildHtml();

        const messageHandler = webviewView.webview.onDidReceiveMessage(message => {
            if (message.command === 'analyse') {
                this.onAnalyseRequest?.();
            }

            if (message.command === 'whatIf') {
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
            }
        });

        const saveWatcher = vscode.workspace.onDidSaveTextDocument(() => {
            this._view?.webview.postMessage({ type: 'fileChanged' });
        });

        webviewView.onDidDispose(() => {
            messageHandler.dispose();
            saveWatcher.dispose();
        });
    }

    // ── Post methods (called by extension.ts) ────────────────────────────────

    /** Signal that a staged blast radius analysis is in progress. */
    public postAnalysisStart(): void {
        this._view?.webview.postMessage({ type: 'analysisStart' });
    }

    /** Push a real staged blast radius result to the webview. */
    public postResult(result: BlastRadiusResult): void {
        this._view?.webview.postMessage({
            type:           'result',
            roots:          result.roots,
            directImpact:   result.directImpact,
            indirectImpact: result.indirectImpact,
            depthMap:       Object.fromEntries(result.depthMap),
            paths:          Object.fromEntries(
                Array.from(result.paths.entries()).map(([k, v]) => [k, v]),
            ),
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

    /** Push an error from any pipeline stage. */
    public postError(message: string, source: 'analyse' | 'whatIf' = 'analyse'): void {
        this._view?.webview.postMessage({ type: 'error', source, message });
    }

    /** Compatibility shim — converts an IntentParseError to a postError call. */
    public postWhatIfError(error: IntentParseError): void {
        this.postError(error.reason, 'whatIf');
    }

    // ── Private HTML builder ─────────────────────────────────────────────────

    private _buildHtml(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<style>
:root { --gap: 10px; --border: var(--vscode-panel-border, #444); --r: 3px; }
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
    font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
    color: var(--vscode-foreground); padding: var(--gap);
    display: flex; flex-direction: column; gap: var(--gap);
}
.section { border: 1px solid var(--border); border-radius: var(--r); overflow: hidden; }
.section-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 5px 8px;
    background: var(--vscode-sideBarSectionHeader-background, rgba(255,255,255,0.04));
    font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em;
}
.section-body { padding: 8px; }
button.primary {
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; border-radius: var(--r); padding: 4px 10px;
    cursor: pointer; font-size: 12px; font-family: inherit;
}
button.primary:hover { background: var(--vscode-button-hoverBackground); }
button.primary:disabled { opacity: 0.5; cursor: default; }
button.small {
    font-size: 10px; padding: 2px 7px;
    background: var(--vscode-button-secondaryBackground, #3a3d41);
    color: var(--vscode-button-secondaryForeground, #ccc);
    border: none; border-radius: var(--r); cursor: pointer; font-family: inherit;
}
button.small:hover { opacity: 0.85; }
.status-bar {
    font-size: 10px; color: var(--vscode-descriptionForeground);
    min-height: 14px; display: flex; align-items: center; gap: 5px; margin-bottom: 6px;
}
.spinner {
    width: 10px; height: 10px; flex-shrink: 0;
    border: 2px solid var(--vscode-descriptionForeground);
    border-top-color: var(--vscode-button-background);
    border-radius: 50%; animation: spin 0.7s linear infinite; display: none;
}
@keyframes spin { to { transform: rotate(360deg); } }
.spinner.active { display: inline-block; }
.impact-group { margin-bottom: 8px; }
.impact-group:last-child { margin-bottom: 0; }
.impact-label {
    font-size: 10px; font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.04em; color: var(--vscode-descriptionForeground); margin-bottom: 3px;
}
.sym-list { list-style: none; display: flex; flex-direction: column; gap: 2px; }
.sym-item {
    display: flex; align-items: flex-start; justify-content: space-between; gap: 4px;
    padding: 3px 5px; border-radius: 2px;
    background: var(--vscode-list-inactiveSelectionBackground, rgba(255,255,255,0.04));
    font-size: 11px;
}
.sym-info { flex: 1; overflow: hidden; min-width: 0; }
.sym-name { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sym-file {
    font-size: 10px; color: var(--vscode-descriptionForeground);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.sym-path {
    font-size: 10px; color: var(--vscode-descriptionForeground);
    margin-top: 1px; font-style: italic;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.badges { display: flex; align-items: center; gap: 2px; flex-shrink: 0; }
.badge {
    display: inline-flex; align-items: center;
    font-size: 9px; font-weight: 700; border-radius: 3px; padding: 1px 4px;
    white-space: nowrap; text-transform: uppercase; letter-spacing: 0.03em;
}
.b-depth  { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
.b-pred   { background: #5c3d9e; color: #e0d0ff; }
.b-high   { background: #1a5c1a; color: #a8ffb0; }
.b-medium { background: #7a5200; color: #ffe5a0; }
.b-low    { background: #5c1a1a; color: #ffc8c8; }
.empty-state { color: var(--vscode-descriptionForeground); font-size: 11px; font-style: italic; }
.error-state { color: var(--vscode-errorForeground, #f88); font-size: 11px; word-break: break-word; }
.more-hint { font-size: 10px; color: var(--vscode-descriptionForeground); padding: 2px 4px; font-style: italic; }
textarea {
    width: 100%; min-height: 58px; resize: vertical;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, #555); border-radius: var(--r);
    padding: 5px; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
    margin-bottom: 6px;
}
textarea:focus { outline: 1px solid var(--vscode-focusBorder); border-color: transparent; }
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
.predict-divider {
    font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em;
    color: #c0a0ff; display: flex; align-items: center; gap: 5px;
    margin: 8px 0 6px; border-top: 1px solid var(--border); padding-top: 8px;
}
</style>
</head>
<body>
<!-- ══ BLAST RADIUS ════════════════════════════════════════════════════════ -->
<div class="section">
    <div class="section-header">
        <span>&#128293; Blast Radius</span>
        <button class="small" onclick="triggerAnalyse()">Analyse</button>
    </div>
    <div class="section-body">
        <div class="status-bar">
            <div class="spinner" id="blast-spinner"></div>
            <span id="blast-status">Click Analyse to check staged changes.</span>
        </div>
        <div id="blast-content"></div>
    </div>
</div>

<!-- ══ WHAT IF? ════════════════════════════════════════════════════════════ -->
<div class="section">
    <div class="section-header"><span>&#129300; What if&hellip;?</span></div>
    <div class="section-body">
        <textarea id="whatif-prompt"
            placeholder="Describe a planned change&hellip;&#10;e.g. &quot;add rate limiting to all API routes&quot;"
        ></textarea>
        <button class="primary" id="whatif-submit" onclick="submitWhatIf()">Predict Impact</button>
        <div class="status-bar" style="margin-top:6px">
            <div class="spinner" id="whatif-spinner"></div>
            <span id="whatif-status"></span>
        </div>
        <div id="whatif-intent"></div>
        <div id="whatif-content"></div>
    </div>
</div>

<script>
const vscode = acquireVsCodeApi();

function triggerAnalyse() { vscode.postMessage({ command: 'analyse' }); }

function submitWhatIf() {
    var prompt = document.getElementById('whatif-prompt').value.trim();
    if (!prompt) { return; }
    setBusy(true);
    document.getElementById('whatif-intent').innerHTML = '';
    document.getElementById('whatif-content').innerHTML = '';
    vscode.postMessage({ command: 'whatIf', prompt });
}

function setBusy(active) {
    document.getElementById('whatif-submit').disabled = active;
    document.getElementById('whatif-spinner').classList.toggle('active', active);
    if (!active) { document.getElementById('whatif-status').textContent = ''; }
}

window.addEventListener('message', function(ev) {
    var m = ev.data;

    if (m.type === 'analysisStart') {
        document.getElementById('blast-spinner').classList.add('active');
        document.getElementById('blast-status').textContent = 'Computing\u2026';
        document.getElementById('blast-content').innerHTML = '';
    }
    if (m.type === 'result') {
        document.getElementById('blast-spinner').classList.remove('active');
        var t = m.directImpact.length + m.indirectImpact.length;
        document.getElementById('blast-status').textContent = t === 0
            ? 'No impact \u2014 staged changes hit no indexed symbols.'
            : (m.roots.length + ' root(s) \u2192 ' + t + ' symbol(s) impacted');
        document.getElementById('blast-content').innerHTML =
            renderLists(m.directImpact, m.indirectImpact, m.depthMap, null, [], m.paths || {});
    }
    if (m.type === 'whatIfIntent') {
        document.getElementById('whatif-status').textContent = 'Predicting blast radius\u2026';
        document.getElementById('whatif-intent').innerHTML = renderIntent(m.descriptor);
    }
    if (m.type === 'predictedResult') {
        setBusy(false);
        if (!m.isRelevant) {
            document.getElementById('whatif-status').textContent = '';
            document.getElementById('whatif-content').innerHTML =
                '<div class="empty-state">' +
                '\u26a0\ufe0f This change doesn\u2019t appear to involve code in this repository.' +
                '<br><br>No indexed symbols matched the described feature. ' +
                'Try describing which existing function, class, or file you want to modify.' +
                '</div>';
            return;
        }
        var t = m.directImpact.length + m.indirectImpact.length;
        var phantoms = (m.phantomIds || []).length;
        var rooted = m.resolvedRoots ? m.resolvedRoots.length : 0;
        document.getElementById('whatif-status').textContent =
            rooted === 0
                ? 'No matching symbols found.'
                : t === 0 && phantoms === 0
                ? rooted + ' symbol(s) in scope \u2014 none have tracked dependents.'
                : t === 0 && phantoms > 0
                ? 'New symbol(s) to be added \u2014 no existing dependents affected.'
                : rooted + ' symbol(s) in scope \u2192 ' + t + ' dependent(s) at risk';
        var content =
            renderRoots(m.resolvedRoots || [], m.changeType) +
            renderLists(m.directImpact, m.indirectImpact, m.depthMap, m.confidenceMap, m.phantomIds || [], m.paths || {});
        document.getElementById('whatif-content').innerHTML = content;
    }
    if (m.type === 'error') {
        var html = '<div class="error-state">\u26a0\ufe0f ' + esc(m.message) + '</div>';
        if (m.source === 'whatIf') {
            setBusy(false);
            document.getElementById('whatif-content').innerHTML = html;
        } else {
            document.getElementById('blast-spinner').classList.remove('active');
            document.getElementById('blast-status').textContent = '';
            document.getElementById('blast-content').innerHTML = html;
        }
    }
    if (m.type === 'fileChanged') {
        if (!document.getElementById('blast-spinner').classList.contains('active')) {
            document.getElementById('blast-status').textContent =
                'File saved \u2014 click Analyse to refresh.';
        }
    }
});

/* ── Render helpers ──────────────────────────────────────────────────────── */

var MAX_INDIRECT = 8;

/**
 * Render the resolved root symbols (what the resolver identified as the change target).
 * Shows "Being deleted", "Points of integration", or "In scope" depending on changeType.
 */
function renderRoots(resolvedRoots, changeType) {
    if (!resolvedRoots || resolvedRoots.length === 0) { return ''; }
    var label = changeType === 'delete'
        ? 'Being deleted'
        : changeType === 'add'
        ? 'Points of integration'
        : 'In scope';
    var html = '<div class="impact-group"><div class="impact-label">' + esc(label) + ' (' + resolvedRoots.length + ')</div>';
    html += '<ul class="sym-list">';
    var shown = Math.min(resolvedRoots.length, 10);
    for (var i = 0; i < shown; i++) {
        var r = resolvedRoots[i];
        var fileName = r.filePath ? (r.filePath.split('/').pop() || r.filePath) : '';
        html += '<li class="sym-item"><div class="sym-info">';
        html += '<div class="sym-name">' + esc(r.name) + '</div>';
        if (fileName) { html += '<div class="sym-file">' + esc(fileName) + '</div>'; }
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

/**
 * Parse a symbol ID into display parts.
 * Normal IDs:   /abs/path/to/file.ts#symbolName  → name=symbolName, file=file.ts
 * Phantom IDs:  __phantom__#HintName              → name=HintName,   file='' (new)
 */
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

/**
 * Render the best explanation path for a symbol as a compact chain.
 * path = ['rootId', 'intermediateId', ..., 'symbolId']
 * Rendered as: rootName → ... → symbolName
 */
function renderPath(paths, id) {
    if (!paths || !paths[id] || !paths[id].length) { return ''; }
    var best = paths[id][0]; // first path is shortest (BFS)
    if (best.length < 2) { return ''; }
    // Show root name, ellipsis if long, then immediate parent
    var parts = best.map(function(pid) { return symParts(pid).name; });
    var chain;
    if (parts.length <= 3) {
        chain = parts.join(' \u2192 ');
    } else {
        chain = parts[0] + ' \u2192 \u2026 \u2192 ' + parts[parts.length - 2] + ' \u2192 ' + parts[parts.length - 1];
    }
    return '<div class="sym-path">' + esc(chain) + '</div>';
}

function renderLists(direct, indirect, depthMap, confMap, phantomIds, paths) {
    var html = '';
    var isPred = confMap !== null;

    if (phantomIds && phantomIds.length > 0) {
        html += '<div class="impact-group"><div class="impact-label">To be created</div>';
        html += '<ul class="sym-list">';
        for (var i = 0; i < phantomIds.length; i++) {
            var p = symParts(phantomIds[i]);
            html += '<li class="sym-item"><div class="sym-info">';
            html += '<div class="sym-name">' + esc(p.name) + '</div>';
            html += '<div class="sym-file">New \u2014 does not exist yet</div>';
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
        for (var i = 0; i < direct.length; i++) { html += renderSym(direct[i], depthMap, confMap, isPred, paths); }
        html += '</ul></div>';
    }

    if (indirect.length > 0) {
        html += '<div class="impact-group"><div class="impact-label">Indirect (' + indirect.length + ')</div>';
        html += '<ul class="sym-list">';
        var shown = Math.min(indirect.length, MAX_INDIRECT);
        for (var i = 0; i < shown; i++) { html += renderSym(indirect[i], depthMap, confMap, isPred, paths); }
        html += '</ul>';
        if (indirect.length > MAX_INDIRECT) {
            html += '<div class="more-hint">&hellip; and ' + (indirect.length - MAX_INDIRECT) + ' more</div>';
        }
        html += '</div>';
    }

    return html;
}

function renderSym(id, depthMap, confMap, isPred, paths) {
    var p     = symParts(id);
    var depth = depthMap && depthMap[id] !== undefined ? depthMap[id] : '?';
    var conf  = confMap ? confMap[id] : null;
    var html  = '<li class="sym-item"><div class="sym-info">';
    html += '<div class="sym-name">' + esc(p.name) + '</div>';
    html += '<div class="sym-file">' + esc(p.file) + '</div>';
    html += renderPath(paths, id);
    html += '</div><div class="badges">';
    var depthLabel = depth === 1 ? 'direct' : 'depth\u00a0' + depth;
    html += '<span class="badge b-depth">' + depthLabel + '</span>';
    if (conf)   { html += '<span class="badge b-' + conf + '">' + confLabel(conf) + '</span>'; }
    html += '</div></li>';
    return html;
}

function confLabel(c) {
    if (c === 'high')   { return 'high confidence'; }
    if (c === 'medium') { return 'med confidence'; }
    return 'low confidence';
}

function renderIntent(d) {
    var apiPill = d.affectsPublicApi
        ? '<span class="pill pill-api-yes">Public API</span>'
        : '<span class="pill pill-api-no">Internal only</span>';
    var html = '<div class="intent-box">';
    html += '<div class="intent-row"><span class="intent-label">Summary: </span>' + esc(d.summary) + '</div>';
    html += '<div class="intent-row"><span class="intent-label">Change type: </span>' + esc(d.changeType) + '</div>';
    html += '<div class="intent-row"><span class="intent-label">Scope: </span>' + apiPill + '</div>';
    if (d.symbolHints && d.symbolHints.length) {
        html += '<div class="intent-row"><span class="intent-label">LLM matched: </span>';
        for (var i = 0; i < d.symbolHints.length; i++) {
            html += '<span class="pill">' + esc(d.symbolHints[i]) + '</span>';
        }
        html += '</div>';
    }
    if (d.fileHints && d.fileHints.length) {
        html += '<div class="intent-row"><span class="intent-label">In files: </span>';
        for (var i = 0; i < d.fileHints.length; i++) {
            html += '<span class="pill">' + esc(d.fileHints[i]) + '</span>';
        }
        html += '</div>';
    }
    html += '<div class="predict-divider"><span class="badge b-pred">PREDICTED</span>&nbsp;Blast Radius</div>';
    html += '</div>';
    return html;
}

function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
</script>
</body>
</html>`;
    }
}