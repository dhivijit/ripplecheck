import { SourceFile } from 'ts-morph';

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
    isExported: boolean;
    parentId: string | null;  // id of the containing class, null for top-level symbols
}

function makeId(filePath: string, name: string): string {
    return `${filePath}#${name}`;
}

export function extractSymbols(sourceFile: SourceFile): SymbolEntry[] {
    const filePath = sourceFile.getFilePath();
    const symbols: SymbolEntry[] = [];

    // Functions
    for (const fn of sourceFile.getFunctions()) {
        const name = fn.getName();
        if (!name) { continue; }
        symbols.push({
            id: makeId(filePath, name),
            name,
            kind: 'function',
            filePath,
            startLine: fn.getStartLineNumber(),
            endLine: fn.getEndLineNumber(),
            isExported: fn.isExported(),
            parentId: null,
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
            isExported: cls.isExported(),
            parentId: null,
        });

        for (const method of cls.getMethods()) {
            const qualifiedName = `${className}.${method.getName()}`;
            symbols.push({
                id: makeId(filePath, qualifiedName),
                name: qualifiedName,
                kind: 'method',
                filePath,
                startLine: method.getStartLineNumber(),
                endLine: method.getEndLineNumber(),
                isExported: cls.isExported(),
                parentId: classId,
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
                isExported: cls.isExported(),
                parentId: classId,
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
            isExported: iface.isExported(),
            parentId: null,
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
            isExported: typeAlias.isExported(),
            parentId: null,
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
            isExported: enm.isExported(),
            parentId: null,
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
                isExported,
                parentId: null,
            });
        }
    }

    return symbols;
}
