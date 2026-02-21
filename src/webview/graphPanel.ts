import * as vscode from 'vscode';

export class GraphPanel {
    public static readonly viewType = 'ripplecheck.graphView';
    private static _instance: GraphPanel | undefined;

    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;

    // ── Public static API ────────────────────────────────────────────────────

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

    /** Push serialised graph data (nodes + edges) to the panel. */
    public static postGraphData(nodes: unknown[], edges: unknown[]): void {
        GraphPanel._instance?._panel.webview.postMessage({ type: 'graphData', nodes, edges });
    }

    /** Push a blast‑radius analysis result to the panel for node recolouring. */
    public static postAnalysisResult(result: unknown): void {
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

        this._panel.webview.onDidReceiveMessage(_message => {
            // Reserved for future graph-panel-specific actions
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
      flex:       1;
      width:      100%;
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

  // ── Dummy placeholder data ─────────────────────────────────────────────
  const dummyElements = [
    { data: { id: 'A', label: 'authService'    }, classes: 'root'     },
    { data: { id: 'B', label: 'userController' }, classes: 'direct'   },
    { data: { id: 'C', label: 'sessionManager' }, classes: 'direct'   },
    { data: { id: 'D', label: 'tokenValidator' }, classes: 'indirect' },
    { data: { id: 'E', label: 'httpMiddleware' }, classes: 'indirect' },
    { data: { id: 'F', label: 'dbConnector'   }, classes: 'other'    },
    { data: { id: 'G', label: 'configLoader'  }, classes: 'other'    },
    { data: { id: 'H', label: 'logService'    }, classes: 'other'    },
    { data: { id: 'AB', source: 'A', target: 'B' } },
    { data: { id: 'AC', source: 'A', target: 'C' } },
    { data: { id: 'BD', source: 'B', target: 'D' } },
    { data: { id: 'CE', source: 'C', target: 'E' } },
    { data: { id: 'DF', source: 'D', target: 'F' } },
    { data: { id: 'GA', source: 'G', target: 'A' } },
    { data: { id: 'FH', source: 'F', target: 'H' } },
    { data: { id: 'EH', source: 'E', target: 'H' } },
  ];

  const cyStyle = [
    {
      selector: 'node',
      style: {
        'background-color':  '#555',
        'label':             'data(label)',
        'font-size':         '10px',
        'color':             '#bbb',
        'text-valign':       'bottom',
        'text-halign':       'center',
        'text-margin-y':     '5px',
        'width':             '26px',
        'height':            '26px',
        'border-width':      '0px',
      },
    },
    { selector: 'node.root',     style: { 'background-color': '#e53935', 'border-width': '2px', 'border-color': '#ffcdd2' } },
    { selector: 'node.direct',   style: { 'background-color': '#f0a500' } },
    { selector: 'node.indirect', style: { 'background-color': '#c8a200' } },
    { selector: 'node.other',    style: { 'background-color': '#555'    } },
    {
      selector: 'edge',
      style: {
        'width':               1.5,
        'line-color':          '#666',
        'target-arrow-color':  '#666',
        'target-arrow-shape':  'triangle',
        'curve-style':         'bezier',
        'arrow-scale':         0.8,
      },
    },
    {
      selector: 'node:selected',
      style: { 'border-width': '2px', 'border-color': 'var(--vscode-focusBorder, #007fd4)' },
    },
  ];

  let cy = cytoscape({
    container:          document.getElementById('cy'),
    elements:           dummyElements,
    style:              cyStyle,
    layout:             { name: 'cose', animate: false, padding: 30, nodeRepulsion: 5000 },
    zoomingEnabled:     true,
    userZoomingEnabled: true,
    panningEnabled:     true,
    minZoom:            0.1,
    maxZoom:            5,
  });

  // Hide empty state once graph is loaded
  document.getElementById('empty-state').style.display = 'none';

  // ── Toolbar: toggle ──────────────────────────────────────────────────────
  function setToggle(mode) {
    const isFull    = mode === 'full';
    document.getElementById('btn-full').classList.toggle('active',    isFull);
    document.getElementById('btn-session').classList.toggle('active', !isFull);

    if (isFull) {
      cy.nodes().show();
      cy.edges().show();
      cy.fit();
    } else {
      cy.nodes('.other').hide();
      cy.edges()
        .filter(function(e) { return e.source().hidden() || e.target().hidden(); })
        .hide();
      const visible = cy.nodes(':visible');
      if (visible.length) { cy.fit(visible, 40); }
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
        // TODO: replace dummy elements with real project graph
        // cy.elements().remove();
        // cy.add(msg.nodes.concat(msg.edges));
        // cy.layout({ name: 'cose', animate: false, padding: 30 }).run();
        break;

      case 'analysisResult':
        // TODO: recolour nodes based on result.directImpact / indirectImpact / roots
        break;
    }
  });

}());
</script>
</body>
</html>`;
    }
}
