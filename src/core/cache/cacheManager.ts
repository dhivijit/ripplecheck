import * as vscode from 'vscode';

const CACHE_DIR = '.blastradius';

const INITIAL_FILES: Record<string, unknown> = {
    'graph.json': {},
    'symbols.json': {},
    'metadata.json': {
        projectHash: '',
        createdAt: '',
        version: '1.0.0',
    },
};

function getCacheUri(workspaceRoot: vscode.Uri): vscode.Uri {
    return vscode.Uri.joinPath(workspaceRoot, CACHE_DIR);
}

async function directoryExists(uri: vscode.Uri): Promise<boolean> {
    try {
        const stat = await vscode.workspace.fs.stat(uri);
        return stat.type === vscode.FileType.Directory;
    } catch {
        return false;
    }
}

async function fileExists(uri: vscode.Uri): Promise<boolean> {
    try {
        const stat = await vscode.workspace.fs.stat(uri);
        return stat.type === vscode.FileType.File;
    } catch {
        return false;
    }
}

async function writeJsonFile(uri: vscode.Uri, content: unknown): Promise<void> {
    const encoded = new TextEncoder().encode(JSON.stringify(content, null, 2));
    await vscode.workspace.fs.writeFile(uri, encoded);
}

export async function ensureCacheDirectory(workspaceRoot: vscode.Uri): Promise<void> {
    const cacheUri = getCacheUri(workspaceRoot);
    const exists = await directoryExists(cacheUri);

    if (!exists) {
        await vscode.workspace.fs.createDirectory(cacheUri);
        console.log(`[RippleCheck] Created cache directory: ${cacheUri.fsPath}`);
    } else {
        console.log(`[RippleCheck] Cache directory already exists: ${cacheUri.fsPath}`);
    }

    for (const [filename, initialContent] of Object.entries(INITIAL_FILES)) {
        const fileUri = vscode.Uri.joinPath(cacheUri, filename);
        const alreadyExists = await fileExists(fileUri);

        if (!alreadyExists) {
            await writeJsonFile(fileUri, initialContent);
            console.log(`[RippleCheck] Created cache file: ${filename}`);
        }
    }
}

export async function isCacheReady(workspaceRoot: vscode.Uri): Promise<boolean> {
    const cacheUri = getCacheUri(workspaceRoot);

    if (!(await directoryExists(cacheUri))) {
        return false;
    }

    for (const filename of Object.keys(INITIAL_FILES)) {
        const fileUri = vscode.Uri.joinPath(cacheUri, filename);
        if (!(await fileExists(fileUri))) {
            return false;
        }
    }

    return true;
}
