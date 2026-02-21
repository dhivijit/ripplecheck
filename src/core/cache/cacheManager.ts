import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { createHash } from 'crypto';

const CACHE_DIR = '.blastradius';

const INITIAL_FILES: Record<string, unknown> = {
    'graph.json': {
        present: { forward: {}, reverse: {} },
        future:  { forward: {}, reverse: {} },
    },
    'symbols.json': {},
    'signatures.json': {},
    'fileHashes.json': {},
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

async function ensureGitignoreEntry(workspaceRoot: vscode.Uri): Promise<void> {
    const gitignoreUri = vscode.Uri.joinPath(workspaceRoot, '.gitignore');
    const entry = CACHE_DIR;

    let content = '';
    const block = `# BlastRadius files\n${entry}\n`;
    try {
        const bytes = await vscode.workspace.fs.readFile(gitignoreUri);
        content = new TextDecoder().decode(bytes);
    } catch {
        // if .gitignore doesn't exist yet, create it
        await vscode.workspace.fs.writeFile(gitignoreUri, new TextEncoder().encode(block));
        console.log(`[RippleCheck] Created .gitignore with entry: ${entry}`);
        return;
    }

    const lines = content.split('\n').map(l => l.trim());
    if (lines.includes(entry)) {
        return;
    }

    const newContent = content.endsWith('\n') || content === ''
        ? content + block
        : content + '\n' + block;

    await vscode.workspace.fs.writeFile(gitignoreUri, new TextEncoder().encode(newContent));
    console.log(`[RippleCheck] Added ${entry} to .gitignore`);
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

    // Always ensure .gitignore is up to date, regardless of whether the
    // cache directory was just created or already existed.
    await ensureGitignoreEntry(workspaceRoot);

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

/**
 * Hash the content of tsconfig.json to detect project structure changes.
 * If tsconfig changes, the cache must be invalidated and rebuilt.
 */
export function computeProjectHash(workspaceRootFsPath: string): string {
    try {
        const tsconfig = fs.readFileSync(path.join(workspaceRootFsPath, 'tsconfig.json'), 'utf8');
        return createHash('sha256').update(tsconfig).digest('hex');
    } catch {
        return 'unknown';
    }
}

/**
 * Write metadata.json with the current project hash and timestamp.
 * Called after every full rebuild so the next startup can use the cache.
 */
export async function writeCacheMetadata(
    workspaceRoot: vscode.Uri,
    projectHash: string
): Promise<void> {
    const metaUri = vscode.Uri.joinPath(workspaceRoot, '.blastradius/metadata.json');
    await writeJsonFile(metaUri, {
        projectHash,
        createdAt: new Date().toISOString(),
        version: '1.0.0',
    });
    console.log('[RippleCheck] Cache metadata written');
}
