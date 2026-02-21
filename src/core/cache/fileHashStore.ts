import * as vscode from 'vscode';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';

const FILE_HASHES_PATH = '.blastradius/fileHashes.json';

/**
 * Fast, non-cryptographic-strength content hash for a file on disk.
 * sha1 is used for speed; we only need change detection, not security.
 * Returns '' if the file cannot be read.
 */
export function computeFileHash(fsPath: string): string {
    try {
        return createHash('sha1').update(readFileSync(fsPath)).digest('hex');
    } catch {
        return '';
    }
}

export async function saveFileHashes(
    hashes: Map<string, string>,
    workspaceRoot: vscode.Uri
): Promise<void> {
    const uri = vscode.Uri.joinPath(workspaceRoot, FILE_HASHES_PATH);
    // Use compact JSON — this file can be large
    const encoded = new TextEncoder().encode(JSON.stringify(Object.fromEntries(hashes)));
    await vscode.workspace.fs.writeFile(uri, encoded);
}

export async function loadFileHashes(workspaceRoot: vscode.Uri): Promise<Map<string, string>> {
    try {
        const uri = vscode.Uri.joinPath(workspaceRoot, FILE_HASHES_PATH);
        const bytes = await vscode.workspace.fs.readFile(uri);
        const raw = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, string>;
        return new Map(Object.entries(raw));
    } catch {
        return new Map();
    }
}
