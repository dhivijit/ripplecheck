import { createHash } from 'crypto';
import {
    SourceFile,
    FunctionDeclaration,
    MethodDeclaration,
    ClassDeclaration,
    InterfaceDeclaration,
    TypeAliasDeclaration,
    VariableDeclaration,
    EnumDeclaration,
    PropertyDeclaration,
    ModuleDeclaration,
} from 'ts-morph';

export type SymbolKind =
    | 'function'
    | 'class'
    | 'interface'
    | 'type'
    | 'variable'
    | 'enum'
    | 'method'
    | 'property';

export interface SymbolEntry {
    id: string;         // `${filePath}#${name}`
    name: string;
    kind: SymbolKind;
    filePath: string;
    startLine: number;
    endLine: number;
    startPos: number;   // absolute character offset (Node.getStart()) from start of file
    endPos: number;     // absolute character offset (Node.getEnd()) from start of file
    isExported: boolean;
    parentId: string | null;  // id of the containing class, null for top-level symbols
    signatureHash: string;    // sha256 of the symbol's public API surface
}

function makeId(filePath: string, name: string): string {
    return `${filePath}#${name}`;
}

// ---------------------------------------------------------------------------
// Signature computation — produces a whitespace-independent API fingerprint
// ---------------------------------------------------------------------------

function hashText(text: string): string {
    return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/**
 * Normalise a TypeScript type string so that semantically identical types
 * always produce the same string regardless of:
 *   - union/intersection member ordering  (string|number  ≡  number|string)
 *   - object property ordering
 *   - incidental whitespace
 */
function splitTopLevel(text: string, sep: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let i = 0;
    let start = 0;
    while (i < text.length) {
        const ch = text[i];
        if (ch === '<' || ch === '{' || ch === '(' || ch === '[') { depth++; i++; continue; }
        if (ch === '>' || ch === '}' || ch === ')' || ch === ']') { depth--; i++; continue; }
        if (depth === 0 && text.startsWith(sep, i)) {
            parts.push(text.slice(start, i));
            i += sep.length;
            start = i;
            continue;
        }
        i++;
    }
    if (start < text.length) { parts.push(text.slice(start)); }
    return parts;
}

function canonicalizeType(raw: string): string {
    let s = raw.replace(/\s+/g, ' ').trim();

    // Sort union members
    if (s.includes(' | ')) {
        const parts = splitTopLevel(s, ' | ');
        if (parts.length > 1) { s = parts.map(p => p.trim()).sort().join(' | '); }
    }
    // Sort intersection members
    if (s.includes(' & ')) {
        const parts = splitTopLevel(s, ' & ');
        if (parts.length > 1) { s = parts.map(p => p.trim()).sort().join(' & '); }
    }
    // Sort object literal property signatures
    if (s.startsWith('{') && s.endsWith('}')) {
        const inner = s.slice(1, -1).trim();
        const props = splitTopLevel(inner, '; ').map(p => p.trim()).filter(Boolean).sort();
        s = `{ ${props.join('; ')} }`;
    }
    return s;
}

function signCallable(node: FunctionDeclaration | MethodDeclaration): string {
    try {
        const params = node.getParameters().map(p => {
            const typeText = p.getTypeNode()?.getText() ?? p.getType().getText();
            return `${p.getName()}:${canonicalizeType(typeText)}`;
        }).join(',');
        const ret = node.getReturnTypeNode()?.getText() ?? node.getReturnType().getText();
        return `(${params}):${canonicalizeType(ret)}`;
    } catch { return ''; }
}

function signProperty(node: PropertyDeclaration): string {
    try { return canonicalizeType(node.getTypeNode()?.getText() ?? node.getType().getText()); } catch { return ''; }
}

function signClass(node: ClassDeclaration): string {
    try {
        const base = node.getBaseClass()?.getName() ?? '';
        const impls = node.getImplements().map(i => i.getExpression().getText()).sort().join(',');
        return `class:${base}:[${impls}]`;
    } catch { return 'class'; }
}

function signInterface(node: InterfaceDeclaration): string {
    try { return node.getMembers().map(m => canonicalizeType(m.getText())).sort().join(';'); } catch { return ''; }
}

function signTypeAlias(node: TypeAliasDeclaration): string {
    try { return canonicalizeType(node.getTypeNode()?.getText() ?? node.getType().getText()); } catch { return ''; }
}

function signVariable(node: VariableDeclaration): string {
    try { return canonicalizeType(node.getTypeNode()?.getText() ?? node.getType().getText()); } catch { return ''; }
}

function signEnum(node: EnumDeclaration): string {
    try {
        return node.getMembers().map(m => `${m.getName()}=${m.getValue() ?? ''}`).sort().join(',');
    } catch { return ''; }
}

export function extractSymbols(sourceFile: SourceFile): SymbolEntry[] {
    const filePath = sourceFile.getFilePath();
    const symbols: SymbolEntry[] = [];

    // Functions — skip overload signatures, keep only the implementation
    for (const fn of sourceFile.getFunctions()) {
        if (fn.isOverload()) { continue; }
        const name = fn.getName();
        if (!name) { continue; }
        symbols.push({
            id: makeId(filePath, name),
            name,
            kind: 'function',
            filePath,
            startLine: fn.getStartLineNumber(),
            endLine: fn.getEndLineNumber(),
            startPos: fn.getStart(),
            endPos: fn.getEnd(),
            isExported: fn.isExported(),
            parentId: null,
            signatureHash: hashText(signCallable(fn)),
        });
    }

    // Classes — include their methods and properties
    for (const cls of sourceFile.getClasses()) {
        const className = cls.getName();
        if (!className) { continue; }

        const classId = makeId(filePath, className);
        symbols.push({
            id: classId,
            name: className,
            kind: 'class',
            filePath,
            startLine: cls.getStartLineNumber(),
            endLine: cls.getEndLineNumber(),
            startPos: cls.getStart(),
            endPos: cls.getEnd(),
            isExported: cls.isExported(),
            parentId: null,
            signatureHash: hashText(signClass(cls)),
        });

        for (const method of cls.getMethods()) {
            if (method.isOverload()) { continue; }
            const qualifiedName = `${className}.${method.getName()}`;
            symbols.push({
                id: makeId(filePath, qualifiedName),
                name: qualifiedName,
                kind: 'method',
                filePath,
                startLine: method.getStartLineNumber(),
                endLine: method.getEndLineNumber(),
                startPos: method.getStart(),
                endPos: method.getEnd(),
                isExported: cls.isExported(),
                parentId: classId,
                signatureHash: hashText(signCallable(method)),
            });
        }

        for (const prop of cls.getProperties()) {
            const qualifiedName = `${className}.${prop.getName()}`;
            symbols.push({
                id: makeId(filePath, qualifiedName),
                name: qualifiedName,
                kind: 'property',
                filePath,
                startLine: prop.getStartLineNumber(),
                endLine: prop.getEndLineNumber(),
                startPos: prop.getStart(),
                endPos: prop.getEnd(),
                isExported: cls.isExported(),
                parentId: classId,
                signatureHash: hashText(signProperty(prop)),
            });
        }
    }

    // Interfaces
    for (const iface of sourceFile.getInterfaces()) {
        const name = iface.getName();
        symbols.push({
            id: makeId(filePath, name),
            name,
            kind: 'interface',
            filePath,
            startLine: iface.getStartLineNumber(),
            endLine: iface.getEndLineNumber(),
            startPos: iface.getStart(),
            endPos: iface.getEnd(),
            isExported: iface.isExported(),
            parentId: null,
            signatureHash: hashText(signInterface(iface)),
        });
    }

    // Type aliases
    for (const typeAlias of sourceFile.getTypeAliases()) {
        const name = typeAlias.getName();
        symbols.push({
            id: makeId(filePath, name),
            name,
            kind: 'type',
            filePath,
            startLine: typeAlias.getStartLineNumber(),
            endLine: typeAlias.getEndLineNumber(),
            startPos: typeAlias.getStart(),
            endPos: typeAlias.getEnd(),
            isExported: typeAlias.isExported(),
            parentId: null,
            signatureHash: hashText(signTypeAlias(typeAlias)),
        });
    }

    // Enums
    for (const enm of sourceFile.getEnums()) {
        const name = enm.getName();
        symbols.push({
            id: makeId(filePath, name),
            name,
            kind: 'enum',
            filePath,
            startLine: enm.getStartLineNumber(),
            endLine: enm.getEndLineNumber(),
            startPos: enm.getStart(),
            endPos: enm.getEnd(),
            isExported: enm.isExported(),
            parentId: null,
            signatureHash: hashText(signEnum(enm)),
        });
    }

    // Top-level variable declarations
    for (const varStatement of sourceFile.getVariableStatements()) {
        const isExported = varStatement.isExported();
        for (const decl of varStatement.getDeclarations()) {
            const name = decl.getName();
            symbols.push({
                id: makeId(filePath, name),
                name,
                kind: 'variable',
                filePath,
                startLine: varStatement.getStartLineNumber(),
                endLine: varStatement.getEndLineNumber(),
                startPos: decl.getStart(),
                endPos: decl.getEnd(),
                isExported,
                parentId: null,
                signatureHash: hashText(signVariable(decl)),
            });
        }
    }

    // Namespaces — recurse into modules to extract qualified symbols
    for (const ns of sourceFile.getModules()) {
        extractNamespaceSymbols(ns, '', filePath, symbols);
    }

    return symbols;
}

/**
 * Recursively extract symbols from a namespace/module declaration.
 * Qualified names are built as `Outer.Inner.symbolName` so IDs remain unique
 * even when sibling namespaces define symbols with the same local name.
 */
function extractNamespaceSymbols(
    ns: ModuleDeclaration,
    parentPrefix: string,
    filePath: string,
    symbols: SymbolEntry[]
): void {
    const nsPrefix = parentPrefix ? `${parentPrefix}.${ns.getName()}` : ns.getName();

    for (const fn of ns.getFunctions()) {
        if (fn.isOverload()) { continue; }
        const name = fn.getName();
        if (!name) { continue; }
        const qualifiedName = `${nsPrefix}.${name}`;
        symbols.push({
            id: makeId(filePath, qualifiedName),
            name: qualifiedName,
            kind: 'function',
            filePath,
            startLine: fn.getStartLineNumber(),
            endLine: fn.getEndLineNumber(),
            startPos: fn.getStart(),
            endPos: fn.getEnd(),
            isExported: fn.isExported(),
            parentId: null,
            signatureHash: hashText(signCallable(fn)),
        });
    }

    for (const cls of ns.getClasses()) {
        const className = cls.getName();
        if (!className) { continue; }
        const qualifiedClassName = `${nsPrefix}.${className}`;
        const classId = makeId(filePath, qualifiedClassName);
        symbols.push({
            id: classId,
            name: qualifiedClassName,
            kind: 'class',
            filePath,
            startLine: cls.getStartLineNumber(),
            endLine: cls.getEndLineNumber(),
            startPos: cls.getStart(),
            endPos: cls.getEnd(),
            isExported: cls.isExported(),
            parentId: null,
            signatureHash: hashText(signClass(cls)),
        });
        for (const method of cls.getMethods()) {
            if (method.isOverload()) { continue; }
            const mName = `${qualifiedClassName}.${method.getName()}`;
            symbols.push({
                id: makeId(filePath, mName),
                name: mName,
                kind: 'method',
                filePath,
                startLine: method.getStartLineNumber(),
                endLine: method.getEndLineNumber(),
                startPos: method.getStart(),
                endPos: method.getEnd(),
                isExported: cls.isExported(),
                parentId: classId,
                signatureHash: hashText(signCallable(method)),
            });
        }
    }

    for (const iface of ns.getInterfaces()) {
        const name = `${nsPrefix}.${iface.getName()}`;
        symbols.push({
            id: makeId(filePath, name),
            name,
            kind: 'interface',
            filePath,
            startLine: iface.getStartLineNumber(),
            endLine: iface.getEndLineNumber(),
            startPos: iface.getStart(),
            endPos: iface.getEnd(),
            isExported: iface.isExported(),
            parentId: null,
            signatureHash: hashText(signInterface(iface)),
        });
    }

    for (const nested of ns.getModules()) {
        extractNamespaceSymbols(nested, nsPrefix, filePath, symbols);
    }
}
