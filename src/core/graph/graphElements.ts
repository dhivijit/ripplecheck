import { SymbolIndex } from '../indexing/symbolIndex';
import { DependencyGraph } from './types';
import { BlastRadiusResult } from '../blast/blastRadiusEngine';

export interface GraphElements {
    nodes: object[];
    edges: object[];
}

/**
 * Build Cytoscape node/edge objects from the full dependency graph.
 *
 * Every symbol that participates in at least one edge is included so the
 * panel is never blank.  Blast-radius results are overlaid as role classes
 * (root / direct / indirect / other) for colour coding.
 *
 * Pass an empty BlastRadiusResult when calling before analysis has run.
 */
export function buildGraphElements(
    symbolIndex: SymbolIndex,
    graph: DependencyGraph,
    result: Pick<BlastRadiusResult, 'roots' | 'directImpact' | 'indirectImpact'>,
): GraphElements {
    const rootIds     = new Set(result.roots.map(r => r.symbolId));
    const directIds   = new Set(result.directImpact);
    const indirectIds = new Set(result.indirectImpact);

    // Collect every symbol that participates in at least one dependency edge.
    const allIds = new Set<string>();
    for (const [src, targets] of graph.forward) {
        allIds.add(src);
        for (const tgt of targets) { allIds.add(tgt); }
    }

    // Also include blast-radius symbols even if they are isolated (no edges).
    for (const id of rootIds)     { allIds.add(id); }
    for (const id of directIds)   { allIds.add(id); }
    for (const id of indirectIds) { allIds.add(id); }

    const role = (id: string): string => {
        if (rootIds.has(id))     { return 'root'; }
        if (directIds.has(id))   { return 'direct'; }
        if (indirectIds.has(id)) { return 'indirect'; }
        return 'other';
    };

    // Cytoscape uses node IDs as CSS selectors internally.
    // Symbol IDs contain '/', '#', and '.' which are CSS selector special
    // characters and silently break edge source/target matching.
    // Map every symbol ID to a safe numeric string ID instead.
    const idList = [...allIds];
    const safeId = new Map<string, string>(idList.map((id, i) => [id, `n${i}`]));

    const nodes = idList.map(id => {
        const sym   = symbolIndex.get(id);
        // For ghost/deleted symbols not in the index, parse the raw ID (`filePath#name`)
        // and use only the symbol name portion as the label.
        const label = sym ? sym.name : (id.includes('#') ? id.slice(id.indexOf('#') + 1) : id);
        return { data: { id: safeId.get(id)!, symbolId: id, label, role: role(id) } };
    });

    const edges: object[] = [];
    let edgeIndex = 0;
    for (const srcId of idList) {
        for (const tgtId of (graph.forward.get(srcId) ?? [])) {
            if (allIds.has(tgtId)) {
                edges.push({ data: {
                    id:     `e${edgeIndex++}`,
                    source: safeId.get(srcId)!,
                    target: safeId.get(tgtId)!,
                } });
            }
        }
    }

    return { nodes, edges };
}
