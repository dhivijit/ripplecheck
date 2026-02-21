/**
 * A → B  (forward):  symbol A directly references symbol B
 * B → A  (reverse):  symbol B is directly referenced by symbol A
 *
 * Both maps are kept in sync at write time so all reads are O(1).
 */
export interface DependencyGraph {
    forward: Map<string, Set<string>>;
    reverse: Map<string, Set<string>>;
}

export interface BlastRadiusEntry {
    symbolId: string;
    /** Distance from the changed symbol. 1 = direct dependent. */
    depth: number;
}
