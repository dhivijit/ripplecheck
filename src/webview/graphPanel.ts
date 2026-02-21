import * as vscode from 'vscode';

/** Async callback that loads the latest graph elements from .blastradius/ files. */
type GraphLoader = () => Promise<{ nodes: object[]; edges: object[] }>;

export class GraphPanel {
    public static readonly viewType = 'ripplecheck.graphView';
    private static _instance:    GraphPanel | undefined;

    // ── File-based data source ───────────────────────────────────────────────
    // Registered once by extension.ts after the workspace is ready.
    // Called every time the panel opens so it always reflects the latest
    // graph.json + symbols.json from .blastradius/.
    private static _graphLoader:  GraphLoader | undefined;
    // Last blast-radius overlay — not persisted to a file, kept in memory.
    private static _lastResult:   unknown | undefined;

    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;

    // ── Public static API ────────────────────────────────────────────────────

    /**
     * Register the async function that reads graph.json + symbols.json and
     * returns Cytoscape elements.  Must be called before any panel is opened.
     */
    public static setGraphLoader(loader: GraphLoader): void {
        GraphPanel._graphLoader = loader;
    }

    /** Open the graph panel beside the current editor, or reveal if already open. */
    public static createOrShow(extensionUri: vscode.Uri): void {
        if (GraphPanel._instance) {
            GraphPanel._instance._panel.reveal(vscode.ViewColumn.Beside);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            GraphPanel.viewType,
            'RippleCheck — Graph',
            vscode.ViewColumn.Beside,
            {
                enableScripts: true,
                localResourceRoots: [extensionUri],
                retainContextWhenHidden: true,
            },
        );

        GraphPanel._instance = new GraphPanel(panel, extensionUri);
    }

    /** Relay a Full Graph / Session toggle from the sidebar to the open panel. */
    public static postToggle(mode: 'full' | 'session'): void {
        GraphPanel._instance?._panel.webview.postMessage({ type: 'toggleMode', mode });
    }

    /**
     * Push fresh graph data to an already-open panel (e.g. after analysis).
     * Also updates the loader cache so the NEXT open gets the same data.
     */
    public static postGraphData(nodes: unknown[], edges: unknown[]): void {
        GraphPanel._instance?._panel.webview.postMessage({ type: 'graphData', nodes, edges });
    }

    /** Push a blast-radius analysis result to the panel for node recolouring. */
    public static postAnalysisResult(result: unknown): void {
        GraphPanel._lastResult = result;
        GraphPanel._instance?._panel.webview.postMessage({ type: 'analysisResult', result });
    }

    // ── Private constructor ──────────────────────────────────────────────────

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this._panel        = panel;
        this._extensionUri = extensionUri;

        this._panel.webview.options = {
            enableScripts: true,
            localResourceRoots: [extensionUri],
        };

        this._panel.webview.html = this.getHtml(this._panel.webview);

        this._panel.onDidDispose(() => {
            GraphPanel._instance = undefined;
        });

        this._panel.webview.onDidReceiveMessage(message => {
            if (message.command === 'graphReady') {
                console.log('[RippleCheck] Graph panel ready signal received');
                if (!GraphPanel._graphLoader) {
                    console.warn('[RippleCheck] graphReady received but no loader is registered — did setGraphLoader get called?');
                    return;
                }
                // Load fresh from .blastradius/graph.json + symbols.json so the
                // panel always reflects the persisted state, not a stale snapshot.
                const panel = this._panel;
                GraphPanel._graphLoader()
                    .then(({ nodes, edges }) => {
                        console.log(`[RippleCheck] Graph panel — posting ${nodes.length} node(s) + ${edges.length} edge(s) to webview`);
                        panel.webview.postMessage({ type: 'graphData', nodes, edges });
                        if (GraphPanel._lastResult !== undefined) {
                            panel.webview.postMessage({
                                type:   'analysisResult',
                                result: GraphPanel._lastResult,
                            });
                        }
                    })
                    .catch(err => console.error('[RippleCheck] GraphPanel loader error:', err));
            }
        });
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    private getNonce(): string {
        let text = '';
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        for (let i = 0; i < 32; i++) {
            text += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return text;
    }

    private getHtml(webview: vscode.Webview): string {
        const nonce        = this.getNonce();
        const cytoscapeUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'media', 'cytoscape.min.js'),
        );

        return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none';
                 script-src 'nonce-${nonce}';
                 style-src  'unsafe-inline';">
  <title>RippleCheck — Graph</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    html, body {
      width:       100%;
      height:      100%;
      overflow:    hidden;
      font-family: var(--vscode-font-family);
      font-size:   var(--vscode-font-size);
      color:       var(--vscode-foreground);
      background:  var(--vscode-editor-background);
    }

    /* ─── Layout ─────────────────────────────────────────────── */
    #root {
      display:        flex;
      flex-direction: column;
      height:         100%;
    }

    /* ─── Toolbar ────────────────────────────────────────────── */
    #toolbar {
      display:       flex;
      align-items:   center;
      gap:           6px;
      flex-wrap:     wrap;
      padding:       6px 12px;
      border-bottom: 1px solid var(--vscode-panel-border, #444);
      flex-shrink:   0;
      background:    var(--vscode-editor-background);
    }

    #toolbar-title {
      font-weight:    600;
      font-size:      12px;
      margin-right:   6px;
    }

    .spacer { flex: 1; }

    /* ─── Buttons ────────────────────────────────────────────── */
    .rc-btn-sm {
      background:    transparent;
      color:         var(--vscode-foreground);
      border:        1px solid var(--vscode-button-border, var(--vscode-panel-border, #666));
      border-radius: 2px;
      padding:       2px 9px;
      font-size:     11px;
      cursor:        pointer;
      white-space:   nowrap;
    }
    .rc-btn-sm:hover  { background: var(--vscode-toolbar-hoverBackground); }
    .rc-btn-sm.active {
      background:   var(--vscode-button-background);
      color:        var(--vscode-button-foreground);
      border-color: var(--vscode-button-background);
    }

    .icon-btn {
      background:    transparent;
      border:        none;
      color:         var(--vscode-foreground);
      cursor:        pointer;
      padding:       2px 6px;
      border-radius: 2px;
      font-size:     14px;
      line-height:   1;
    }
    .icon-btn:hover { background: var(--vscode-toolbar-hoverBackground); }

    /* ─── Canvas ─────────────────────────────────────────────── */
    #cy {
      position:   absolute;
      top:        0;
      left:       0;
      right:      0;
      bottom:     0;
      background: var(--vscode-editor-background);
    }

    /* ─── Legend ─────────────────────────────────────────────── */
    #legend {
      display:       flex;
      gap:           14px;
      flex-wrap:     wrap;
      align-items:   center;
      padding:       5px 12px;
      border-top:    1px solid var(--vscode-panel-border, #444);
      font-size:     10px;
      color:         var(--vscode-descriptionForeground);
      flex-shrink:   0;
      background:    var(--vscode-editor-background);
    }

    .leg-item { display: flex; align-items: center; gap: 4px; }
    .leg-dot  {
      width:         8px;
      height:        8px;
      border-radius: 50%;
      flex-shrink:   0;
    }
    .leg-dot.root     { background: #e53935; }
    .leg-dot.direct   { background: #f0a500; }
    .leg-dot.indirect { background: #c8a200; }
    .leg-dot.other    {
      background:  var(--vscode-editor-inactiveSelectionBackground, #555);
      border: 1px solid var(--vscode-descriptionForeground);
    }

    /* ─── Empty state ────────────────────────────────────────── */
    #empty-state {
      position:   absolute;
      top:        50%;
      left:       50%;
      transform:  translate(-50%, -50%);
      font-size:  12px;
      color:      var(--vscode-descriptionForeground);
      text-align: center;
      pointer-events: none;
    }
  </style>
</head>
<body>
<div id="root">

  <!-- ── Toolbar ─────────────────────────────────────── -->
  <div id="toolbar">
    <span id="toolbar-title">Dependency Graph</span>

    <button class="rc-btn-sm active" id="btn-full">Full Graph</button>
    <button class="rc-btn-sm"        id="btn-session">Session</button>

    <span class="spacer"></span>

    <button class="icon-btn" id="btn-zoom-in"  title="Zoom In">+</button>
    <button class="icon-btn" id="btn-zoom-out" title="Zoom Out">&#8722;</button>
    <button class="icon-btn" id="btn-fit"      title="Fit to view">&#8862;</button>
  </div>

  <!-- ── Canvas ──────────────────────────────────────── -->
  <div style="position:relative; flex:1; overflow:hidden;">
    <div id="cy"></div>
    <div id="empty-state">Run analysis in the sidebar to load the graph.</div>
  </div>

  <!-- ── Legend ──────────────────────────────────────── -->
  <div id="legend">
    <span class="leg-item"><span class="leg-dot root"></span>Changed (root)</span>
    <span class="leg-item"><span class="leg-dot direct"></span>Direct impact</span>
    <span class="leg-item"><span class="leg-dot indirect"></span>Indirect impact</span>
    <span class="leg-item"><span class="leg-dot other"></span>Unaffected</span>
  </div>

</div>

<script nonce="${nonce}" src="${cytoscapeUri}"></script>
<script nonce="${nonce}">
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();

  // No placeholder data — real elements arrive via the 'graphData' postMessage.
  const initialElements = [];

  // ── Shared layout config (used in init, graphData, and toggle) ──────────
  const layoutOpts = {
    name:            'cose',
    animate:         false,
    padding:         40,
    nodeRepulsion:   12000,
    idealEdgeLength: 80,
    nodeOverlap:     20,
    gravity:         0.4,
    edgeElasticity:  100,
  };

  const cyStyle = [
    {
      selector: 'node',
      style: {
        'background-color':           '#555',
        'label':                      'data(label)',
        'font-size':                  '10px',
        'color':                      '#ccc',
        'text-valign':                'bottom',
        'text-halign':                'center',
        'text-margin-y':              6,
        // Label readability — truncate long names and add contrast
        'text-wrap':                  'ellipsis',
        'text-max-width':             '90px',
        'text-outline-width':         2,
        'text-outline-color':         '#1e1e1e',
        'text-background-color':      '#1e1e1e',
        'text-background-opacity':    0.7,
        'text-background-padding':    '2px',
        'text-background-shape':      'roundrectangle',
        // Scale node size by connectivity
        'width':                      'mapData(degree, 0, 20, 24, 50)',
        'height':                     'mapData(degree, 0, 20, 24, 50)',
        'border-width':               '0px',
      },
    },
    { selector: 'node.root',     style: { 'background-color': '#e53935', 'border-width': '2px', 'border-color': '#ffcdd2' } },
    { selector: 'node.direct',   style: { 'background-color': '#f0a500' } },
    { selector: 'node.indirect', style: { 'background-color': '#c8a200' } },
    { selector: 'node.other',    style: { 'background-color': '#555'    } },
    {
      selector: 'edge',
      style: {
        'width':               1.2,
        'line-color':          '#555',
        'target-arrow-color':  '#555',
        'target-arrow-shape':  'triangle',
        'curve-style':         'bezier',
        'arrow-scale':         0.8,
        'opacity':             0.6,
      },
    },
    {
      selector: 'node:selected',
      style: { 'border-width': '3px', 'border-color': '#007fd4' },
    },
  ];

  let cy = cytoscape({
    container:          document.getElementById('cy'),
    elements:           initialElements,
    style:              cyStyle,
    layout:             layoutOpts,
    zoomingEnabled:     true,
    userZoomingEnabled: true,
    panningEnabled:     true,
    minZoom:            0.1,
    maxZoom:            5,
  });

  // Signal readiness — extension host will replay last analysis result if available.
  console.log('[RippleCheck] Webview ready — sending graphReady signal');
  vscode.postMessage({ command: 'graphReady' });

  // ── Toolbar: toggle ──────────────────────────────────────────────────────
  function setToggle(mode) {
    const isFull    = mode === 'full';
    document.getElementById('btn-full').classList.toggle('active',    isFull);
    document.getElementById('btn-session').classList.toggle('active', !isFull);

    if (isFull) {
      cy.nodes().show();
      cy.edges().show();
      cy.layout(layoutOpts).run();
    } else {
      cy.nodes('.other').hide();
      cy.edges()
        .filter(function(e) { return e.source().hidden() || e.target().hidden(); })
        .hide();
      var visible = cy.elements(':visible');
      if (visible.length) {
        visible.layout(Object.assign({}, layoutOpts, { fit: true })).run();
      }
    }
  }

  document.getElementById('btn-full').addEventListener('click',    function() { setToggle('full'); });
  document.getElementById('btn-session').addEventListener('click', function() { setToggle('session'); });

  // ── Toolbar: zoom / fit ──────────────────────────────────────────────────
  document.getElementById('btn-zoom-in').addEventListener('click', function() {
    cy.zoom({ level: cy.zoom() * 1.25, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
  });
  document.getElementById('btn-zoom-out').addEventListener('click', function() {
    cy.zoom({ level: cy.zoom() * 0.8,  renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
  });
  document.getElementById('btn-fit').addEventListener('click', function() { cy.fit(); });

  // ── Messages from extension host ────────────────────────────────────────
  window.addEventListener('message', function(event) {
    const msg = event.data;
    switch (msg.type) {

      case 'toggleMode':
        // Relayed from sidebar toggle
        setToggle(msg.mode);
        break;

      case 'graphData':
        console.log('[RippleCheck] graphData received — nodes:', (msg.nodes || []).length, 'edges:', (msg.edges || []).length);
        // Replace all elements with real project graph
        cy.elements().remove();
        cy.add((msg.nodes || []).concat(msg.edges || []));
        // Apply role classes immediately from node data so colours render
        // even when no separate analysisResult message follows.
        cy.nodes().forEach(function(node) {
          var r = node.data('role');
          if (r) { node.addClass(r); }
        });
        cy.layout(layoutOpts).run();
        document.getElementById('empty-state').style.display = 'none';
        console.log('[RippleCheck] Graph rendered — ' + cy.nodes().length + ' node(s) visible');
        break;

      case 'analysisResult': {
        // Recolour nodes based on blast radius classification.
        // Nodes use safe numeric IDs (n0, n1, …) so match on data('symbolId').
        var rootSet     = new Set((msg.result.roots    || []));
        var directSet   = new Set((msg.result.direct   || []));
        var indirectSet = new Set((msg.result.indirect || []));

        cy.nodes().forEach(function(node) {
          node.removeClass('root direct indirect other');
          var sid = node.data('symbolId') || node.id();
          if      (rootSet.has(sid))     { node.addClass('root'); }
          else if (directSet.has(sid))   { node.addClass('direct'); }
          else if (indirectSet.has(sid)) { node.addClass('indirect'); }
          else                           { node.addClass('other'); }
        });
        break;
      }
    }
  });

}());
</script>
</body>
</html>`;
    }
}
