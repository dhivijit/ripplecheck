"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.GitVisualizerPanel = void 0;
const vscode = __importStar(require("vscode"));
const gitService_1 = require("../git/gitService");
class GitVisualizerPanel {
    static currentPanel;
    panel;
    constructor(extensionUri) {
        this.panel = vscode.window.createWebviewPanel('gitVisualizer', 'Git Visualizer', vscode.ViewColumn.One, { enableScripts: true });
        this.initialize(extensionUri);
    }
    async initialize(extensionUri) {
        const gitService = new gitService_1.GitService();
        const commits = await gitService.getCommitHistory();
        const diff = await gitService.getDiff();
        this.panel.webview.html = this.getHtml(commits, diff);
    }
    getHtml(commits, diff) {
        return `
        <html>
        <body>
            <h2>Commit History</h2>
            <pre>${JSON.stringify(commits.all, null, 2)}</pre>

            <h2>Current Diff</h2>
            <pre>${diff}</pre>
        </body>
        </html>
        `;
    }
}
exports.GitVisualizerPanel = GitVisualizerPanel;
//# sourceMappingURL=panel.js.map