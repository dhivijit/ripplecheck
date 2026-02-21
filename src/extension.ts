// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { ensureCacheDirectory, isCacheReady } from './core/cache/cacheManager';
import { loadProject } from './core/indexing/projectLoader';
import { buildSymbolIndex } from './core/indexing/symbolIndex';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "ripplecheck" is now active!');

	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (workspaceFolders && workspaceFolders.length > 0) {
		const workspaceRoot = workspaceFolders[0].uri;

		// Step 1 — ensure .blastradius/ and its files exist
		const ready = await isCacheReady(workspaceRoot);
		if (!ready) {
			await ensureCacheDirectory(workspaceRoot);
		}

		// Step 2 — load all source files via ts-morph
		const project = loadProject(workspaceRoot.fsPath);

		// Step 3 — build the symbol index and persist it to cache
		await buildSymbolIndex(project, workspaceRoot);
	}

	// The command has been defined in the package.json file
	// Now provide the implementation of the command with registerCommand
	// The commandId parameter must match the command field in package.json
	const disposable = vscode.commands.registerCommand('ripplecheck.helloWorld', () => {
		// The code you place here will be executed every time your command is executed
		// Display a message box to the user
		vscode.window.showInformationMessage('Hello World from RippleCheck!');
	});

	context.subscriptions.push(disposable);
}

// This method is called when your extension is deactivated
export function deactivate() {}
