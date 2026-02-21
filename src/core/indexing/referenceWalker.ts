import { Project, Node } from 'ts-morph';
import { SymbolIndex } from './symbolIndex';

export type ReferenceGraph = Map<string, Set<string>>; // ownerSymbolId → Set<referencedSymbolId>

// ---------------------------------------------------------------------------
// Owner stack helpers
// ---------------------------------------------------------------------------

/**
 * A node "owns" the identifiers inside it when it represents a callable or
 * property-level declaration. Entering one of these pushes onto the owner stack.
 */
function isOwnerNode(node: Node): boolean {
    return (
        Node.isFunctionDeclaration(node) ||
        Node.isFunctionExpression(node) ||
        Node.isMethodDeclaration(node) ||
        Node.isConstructorDeclaration(node) ||
        Node.isArrowFunction(node) ||
        Node.isGetAccessorDeclaration(node) ||
        Node.isSetAccessorDeclaration(node)
    );
}

/**
 * Map an owner-node to the symbol id it was indexed under.
 * Returns null if the node cannot be mapped (e.g. anonymous function not in index).
 */
function getOwnerSymbolId(node: Node, filePath: string, symbolIndex: SymbolIndex): string | null {
    const has = (id: string) => symbolIndex.has(id) ? id : null;
    const p   = (name: string) => `${filePath}#${name}`;

    if (Node.isFunctionDeclaration(node) || Node.isFunctionExpression(node)) {
        const name = node.getName?.();
        return name ? has(p(name)) : null;
    }

    if (
        Node.isMethodDeclaration(node) ||
        Node.isGetAccessorDeclaration(node) ||
        Node.isSetAccessorDeclaration(node)
    ) {
        const parent = node.getParent();
        if (!Node.isClassDeclaration(parent) && !Node.isClassExpression(parent)) { return null; }
        const className = parent.getName?.();
        return className ? has(p(`${className}.${node.getName()}`)) : null;
    }

    if (Node.isConstructorDeclaration(node)) {
        // Constructor bodies are attributed to the class symbol itself
        const parent = node.getParent();
        if (!Node.isClassDeclaration(parent) && !Node.isClassExpression(parent)) { return null; }
        const className = parent.getName?.();
        return className ? has(p(className)) : null;
    }

    if (Node.isArrowFunction(node)) {
        // Only track arrow functions that are directly assigned to a named variable
        const parent = node.getParent();
        if (Node.isVariableDeclaration(parent)) {
            return has(p(parent.getName()));
        }
        return null;
    }

    return null;
}

// ---------------------------------------------------------------------------
// Declaration → symbol id
// ---------------------------------------------------------------------------

/**
 * Given a ts-morph declaration Node that lives in a workspace file, return the
 * symbol id we stored in the SymbolIndex for it. Returns null when the
 * declaration kind is not indexed (e.g. import specifiers, parameters).
 */
function declarationToSymbolId(decl: Node, declFilePath: string, symbolIndex: SymbolIndex): string | null {
    const has = (id: string) => symbolIndex.has(id) ? id : null;
    const p   = (name: string) => `${declFilePath}#${name}`;

    if (Node.isFunctionDeclaration(decl) || Node.isFunctionExpression(decl)) {
        const name = decl.getName?.();
        return name ? has(p(name)) : null;
    }
    if (Node.isClassDeclaration(decl) || Node.isClassExpression(decl)) {
        const name = decl.getName?.();
        return name ? has(p(name)) : null;
    }
    if (Node.isInterfaceDeclaration(decl))  { return has(p(decl.getName())); }
    if (Node.isTypeAliasDeclaration(decl))  { return has(p(decl.getName())); }
    if (Node.isEnumDeclaration(decl))       { return has(p(decl.getName())); }
    if (Node.isVariableDeclaration(decl))   { return has(p(decl.getName())); }

    if (Node.isPropertyDeclaration(decl)) {
        const cls = decl.getParent();
        if (!Node.isClassDeclaration(cls) && !Node.isClassExpression(cls)) { return null; }
        const className = cls.getName?.();
        return className ? has(p(`${className}.${decl.getName()}`)) : null;
    }
    if (
        Node.isMethodDeclaration(decl) ||
        Node.isGetAccessorDeclaration(decl) ||
        Node.isSetAccessorDeclaration(decl)
    ) {
        const cls = decl.getParent();
        if (!Node.isClassDeclaration(cls) && !Node.isClassExpression(cls)) { return null; }
        const className = cls.getName?.();
        return className ? has(p(`${className}.${decl.getName()}`)) : null;
    }
    if (Node.isConstructorDeclaration(decl)) {
        const cls = decl.getParent();
        if (!Node.isClassDeclaration(cls) && !Node.isClassExpression(cls)) { return null; }
        const className = cls.getName?.();
        return className ? has(p(className)) : null;
    }

    return null;
}

// ---------------------------------------------------------------------------
// Workspace filter
// ---------------------------------------------------------------------------

function isWorkspaceFile(filePath: string, workspaceRootFsPath: string): boolean {
    return (
        filePath.startsWith(workspaceRootFsPath) &&
        !filePath.includes('/node_modules/') &&
        !/\/typescript\/lib\/lib\..+\.d\.ts$/.test(filePath)
    );
}

// ---------------------------------------------------------------------------
// Recursive AST walk
// ---------------------------------------------------------------------------

function walkNode(
    node: Node,
    ownerStack: string[],
    filePath: string,
    symbolIndex: SymbolIndex,
    workspaceRootFsPath: string,
    graph: ReferenceGraph
): void {
    // --- Step 3: maintain owner stack ---
    const isOwner = isOwnerNode(node);
    let pushedId: string | null = null;

    if (isOwner) {
        const ownerId = getOwnerSymbolId(node, filePath, symbolIndex);
        if (ownerId) {
            ownerStack.push(ownerId);
            pushedId = ownerId;
        }
    }

    // --- Step 4: record references ---
    if (Node.isIdentifier(node) && ownerStack.length > 0) {
        const currentOwner = ownerStack[ownerStack.length - 1];

        // Skip identifiers that are the name of their own declaration.
        // Nearly all named declaration nodes in ts-morph expose getNameNode() —
        // if that returns this exact node, we are looking at a binding, not a reference.
        const parent = node.getParent();
        const isDeclarationName =
            parent !== undefined &&
            typeof (parent as any).getNameNode === 'function' &&
            (parent as any).getNameNode() === node;

        if (!isDeclarationName) {
            try {
                const symbol = node.getSymbol();
                if (symbol) {
                    for (const decl of symbol.getDeclarations()) {
                        const declFilePath = decl.getSourceFile().getFilePath();

                        // Filter: only workspace symbols
                        if (!isWorkspaceFile(declFilePath, workspaceRootFsPath)) { continue; }

                        const referencedId = declarationToSymbolId(decl, declFilePath, symbolIndex);
                        if (referencedId && referencedId !== currentOwner) {
                            if (!graph.has(currentOwner)) {
                                graph.set(currentOwner, new Set());
                            }
                            graph.get(currentOwner)!.add(referencedId);
                        }
                    }
                }
            } catch {
                // Type checker can throw on malformed/ambient nodes — skip safely
            }
        }
    }

    // Recurse into children (preserves pre-order, enter-before-leave semantics)
    for (const child of node.getChildren()) {
        walkNode(child, ownerStack, filePath, symbolIndex, workspaceRootFsPath, graph);
    }

    // --- pop owner on the way out ---
    if (pushedId !== null) {
        ownerStack.pop();
    }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function buildReferenceGraph(
    project: Project,
    symbolIndex: SymbolIndex,
    workspaceRootFsPath: string
): ReferenceGraph {
    const graph: ReferenceGraph = new Map();

    for (const sourceFile of project.getSourceFiles()) {
        const filePath = sourceFile.getFilePath();
        if (!isWorkspaceFile(filePath, workspaceRootFsPath)) { continue; }
        walkNode(sourceFile, [], filePath, symbolIndex, workspaceRootFsPath, graph);
    }

    let edgeCount = 0;
    for (const edges of graph.values()) { edgeCount += edges.size; }
    console.log(`[RippleCheck] Reference graph complete — ${graph.size} owner(s), ${edgeCount} edge(s)`);

    return graph;
}
