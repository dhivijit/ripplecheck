import * as vscode from 'vscode';
import { SymbolIndex } from '../indexing/symbolIndex';
import { SymbolEntry } from '../indexing/symbolExtractor';
import { DependencyGraph } from '../graph/types';
import { BlastRadiusResult, ImpactRoot, RootReason } from '../blast/blastRadiusEngine';
import { PredictiveBlastRadiusResult } from '../intent/predictiveEngine';
import { ResolvedConfidence } from '../intent/types';

// ---------------------------------------------------------------------------
// impact.json schema
// ---------------------------------------------------------------------------

interface ImpactSymbolRef {
    id:        string;
    name:      string;
    kind:      string;
    filePath:  string;   // workspace-relative
    startLine: number;
    exported:  boolean;
}

interface ImpactedApi {
    symbol:     ImpactSymbolRef;
    role:       'root' | 'direct' | 'indirect';
    reason?:    RootReason;        // only set for roots
    depth:      number;
}

interface ImpactedModule {
    /** Workspace-relative file path. */
    filePath:      string;
    /** Every impacted symbol inside this file. */
    symbols:       ImpactSymbolRef[];
    /** Number of root/direct/indirect symbols in this file. */
    rootCount:     number;
    directCount:   number;
    indirectCount: number;
}

interface DownstreamDep {
    /** The root symbol that was changed. */
    root:         ImpactSymbolRef;
    /** Symbols that directly depend on this root (forward edges from root). */
    dependents:   ImpactSymbolRef[];
}

interface RiskArea {
    symbol:     ImpactSymbolRef;
    riskLevel:  'high' | 'medium' | 'low';
    reasons:    string[];
}

interface ImpactZones {
    /** Symbols present in the index — impact is well-understood. */
    known:   ImpactSymbolRef[];
    /** Symbols deleted / ghost / low-confidence — impact is uncertain. */
    unknown: ImpactSymbolRef[];
}

export interface ImpactReport {
    generatedAt:           string;
    source:                'staged' | 'in-editor' | 'what-if';

    impactedApis:          ImpactedApi[];
    impactedModules:       ImpactedModule[];
    downstreamDependencies: DownstreamDep[];
    highRiskAreas:         RiskArea[];
    impactZones:           ImpactZones;

    summary: {
        totalRoots:     number;
        totalDirect:    number;
        totalIndirect:  number;
        totalFiles:     number;
        highRiskCount:  number;
        unknownCount:   number;
    };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toRelPath(absPath: string, rootFsPath: string): string {
    const normalRoot = rootFsPath.replace(/\\/g, '/').replace(/\/?$/, '/');
    const p = absPath.replace(/\\/g, '/');
    return p.startsWith(normalRoot) ? p.slice(normalRoot.length) : p;
}

function makeRef(
    id: string,
    symbolIndex: SymbolIndex,
    rootFsPath: string,
): ImpactSymbolRef {
    const entry = symbolIndex.get(id);
    if (entry) {
        return {
            id,
            name:      entry.name,
            kind:      entry.kind,
            filePath:  toRelPath(entry.filePath, rootFsPath),
            startLine: entry.startLine,
            exported:  entry.isExported,
        };
    }
    // Ghost / deleted symbol — parse the raw ID  (absPath#name)
    const hash = id.indexOf('#');
    return {
        id,
        name:      hash >= 0 ? id.slice(hash + 1) : id,
        kind:      'unknown',
        filePath:  hash >= 0 ? toRelPath(id.slice(0, hash), rootFsPath) : '',
        startLine: 0,
        exported:  false,
    };
}

// ---------------------------------------------------------------------------
// High-risk classification
// ---------------------------------------------------------------------------

const HIGH_RISK_REASONS: Set<RootReason> = new Set(['deleted', 'signature-ripple']);

function classifyRisk(
    id: string,
    rootMap: Map<string, ImpactRoot>,
    depthMap: Map<string, number>,
    confidenceMap: Map<string, ResolvedConfidence> | undefined,
): { level: 'high' | 'medium' | 'low'; reasons: string[] } | null {
    const reasons: string[] = [];

    // Root with a destructive reason → high
    const root = rootMap.get(id);
    if (root && HIGH_RISK_REASONS.has(root.reason)) {
        reasons.push(`root: ${root.reason}`);
    }

    // Deep transitive nodes (depth ≥ 3) are harder to verify
    const depth = depthMap.get(id);
    if (depth !== undefined && depth >= 3) {
        reasons.push(`deep transitive (depth ${depth})`);
    }

    // What-If: low confidence
    if (confidenceMap) {
        const conf = confidenceMap.get(id);
        if (conf === 'low') {
            reasons.push('low prediction confidence');
        }
    }

    if (reasons.length === 0) { return null; }

    // Determine level
    const level =
        (root && HIGH_RISK_REASONS.has(root.reason)) ? 'high' :
        (depth !== undefined && depth >= 3)           ? 'medium' :
        'low';

    return { level, reasons };
}

// ---------------------------------------------------------------------------
// Public builder
// ---------------------------------------------------------------------------

export function buildImpactReport(
    result: BlastRadiusResult,
    symbolIndex: SymbolIndex,
    graph: DependencyGraph,
    rootFsPath: string,
    source: ImpactReport['source'],
    confidenceMap?: Map<string, ResolvedConfidence>,
): ImpactReport {
    const rootMap = new Map<string, ImpactRoot>();
    for (const r of result.roots) { rootMap.set(r.symbolId, r); }

    const rootIds     = new Set(result.roots.map(r => r.symbolId));
    const directIds   = new Set(result.directImpact);
    const indirectIds = new Set(result.indirectImpact);

    // ── 1. Impacted APIs ─────────────────────────────────────────────────────
    // Every exported symbol OR every root (changed symbols are always relevant).
    const impactedApis: ImpactedApi[] = [];

    const addApi = (id: string, role: 'root' | 'direct' | 'indirect') => {
        const ref = makeRef(id, symbolIndex, rootFsPath);
        // Include if: exported (public API), or is a root (always relevant)
        if (!ref.exported && role !== 'root') { return; }
        impactedApis.push({
            symbol: ref,
            role,
            reason: rootMap.get(id)?.reason,
            depth:  result.depthMap.get(id) ?? 0,
        });
    };

    for (const id of rootIds)     { addApi(id, 'root');     }
    for (const id of directIds)   { addApi(id, 'direct');   }
    for (const id of indirectIds) { addApi(id, 'indirect'); }

    // ── 2. Impacted modules (grouped by file) ────────────────────────────────
    const fileMap = new Map<string, { symbols: ImpactSymbolRef[]; roots: number; direct: number; indirect: number }>();

    const addToFile = (id: string, role: 'root' | 'direct' | 'indirect') => {
        const ref = makeRef(id, symbolIndex, rootFsPath);
        let entry = fileMap.get(ref.filePath);
        if (!entry) { entry = { symbols: [], roots: 0, direct: 0, indirect: 0 }; fileMap.set(ref.filePath, entry); }
        entry.symbols.push(ref);
        if (role === 'root')          { entry.roots++;    }
        else if (role === 'direct')   { entry.direct++;   }
        else                          { entry.indirect++; }
    };

    for (const id of rootIds)     { addToFile(id, 'root');     }
    for (const id of directIds)   { addToFile(id, 'direct');   }
    for (const id of indirectIds) { addToFile(id, 'indirect'); }

    const impactedModules: ImpactedModule[] = [];
    for (const [filePath, data] of fileMap) {
        impactedModules.push({
            filePath,
            symbols:       data.symbols,
            rootCount:     data.roots,
            directCount:   data.direct,
            indirectCount: data.indirect,
        });
    }
    // Sort: files with roots first, then by total impact count descending
    impactedModules.sort((a, b) => {
        if (a.rootCount !== b.rootCount) { return b.rootCount - a.rootCount; }
        const aTotal = a.rootCount + a.directCount + a.indirectCount;
        const bTotal = b.rootCount + b.directCount + b.indirectCount;
        return bTotal - aTotal;
    });

    // ── 3. Downstream dependencies ───────────────────────────────────────────
    // For each root, list all symbols that directly depend on it (reverse edges).
    const downstreamDependencies: DownstreamDep[] = [];
    for (const root of result.roots) {
        const dependents = graph.reverse.get(root.symbolId);
        if (!dependents || dependents.size === 0) { continue; }
        downstreamDependencies.push({
            root:       makeRef(root.symbolId, symbolIndex, rootFsPath),
            dependents: Array.from(dependents).map(id => makeRef(id, symbolIndex, rootFsPath)),
        });
    }

    // ── 4. High risk areas ───────────────────────────────────────────────────
    const highRiskAreas: RiskArea[] = [];
    const allImpacted = [...rootIds, ...directIds, ...indirectIds];
    for (const id of allImpacted) {
        const risk = classifyRisk(id, rootMap, result.depthMap, confidenceMap);
        if (risk) {
            highRiskAreas.push({
                symbol:    makeRef(id, symbolIndex, rootFsPath),
                riskLevel: risk.level,
                reasons:   risk.reasons,
            });
        }
    }
    // Sort: high → medium → low
    const riskOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
    highRiskAreas.sort((a, b) => riskOrder[a.riskLevel] - riskOrder[b.riskLevel]);

    // ── 5. Known vs unknown impact zones ─────────────────────────────────────
    const known:   ImpactSymbolRef[] = [];
    const unknown: ImpactSymbolRef[] = [];

    for (const id of allImpacted) {
        const ref  = makeRef(id, symbolIndex, rootFsPath);
        const entry = symbolIndex.get(id);

        // Unknown if: not in index (ghost/deleted), or low confidence in What-If
        const isGhost         = !entry;
        const isLowConfidence = confidenceMap?.get(id) === 'low';

        if (isGhost || isLowConfidence) {
            unknown.push(ref);
        } else {
            known.push(ref);
        }
    }

    // ── Summary ──────────────────────────────────────────────────────────────
    return {
        generatedAt: new Date().toISOString(),
        source,
        impactedApis,
        impactedModules,
        downstreamDependencies,
        highRiskAreas,
        impactZones: { known, unknown },
        summary: {
            totalRoots:    result.roots.length,
            totalDirect:   result.directImpact.length,
            totalIndirect: result.indirectImpact.length,
            totalFiles:    impactedModules.length,
            highRiskCount: highRiskAreas.filter(r => r.riskLevel === 'high').length,
            unknownCount:  unknown.length,
        },
    };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const IMPACT_CACHE_PATH = '.blastradius/impact.json';

export async function persistImpactReport(
    report: ImpactReport,
    workspaceRoot: vscode.Uri,
): Promise<void> {
    const uri     = vscode.Uri.joinPath(workspaceRoot, IMPACT_CACHE_PATH);
    const encoded = new TextEncoder().encode(JSON.stringify(report, null, 2));
    await vscode.workspace.fs.writeFile(uri, encoded);
    console.log(`[RippleCheck] Impact report persisted → ${uri.fsPath}`);
}
