import * as vscode from 'vscode';
import {
    IntentDescriptor,
    IntentChangeType,
    IntentParseResult,
} from './types';
import { SymbolIndex } from '../indexing/symbolIndex';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOG_PREFIX = '[RippleCheck][Intent]';

/** Caps that keep the injected repo context inside a reasonable token budget. */
const MAX_CONTEXT_FILES   = 150;
const MAX_CONTEXT_SYMBOLS = 400;

// ---------------------------------------------------------------------------
// Repo context builder
// ---------------------------------------------------------------------------

/**
 * Build a compact plain-text summary of the repo that can be embedded in the
 * LLM prompt.  This grounds the model in real symbol names and file paths so
 * it cannot invent names that don't exist.
 *
 * - Exported symbols are listed first (they are the most likely targets of
 *   intentional changes and the most useful hints for the resolver).
 * - Absolute paths are converted to workspace-relative paths.
 * - Both lists are capped so the injected text stays well within the model's
 *   context window even for large projects.
 */
function buildRepoContext(symbolIndex: SymbolIndex, workspaceRootFsPath: string): string {
    const normalRoot = workspaceRootFsPath.replace(/\\/g, '/').replace(/\/$/, '');

    const toRelative = (abs: string): string => {
        const norm = abs.replace(/\\/g, '/');
        return norm.startsWith(normalRoot + '/') ? norm.slice(normalRoot.length + 1) : norm;
    };

    // ── Unique source files ───────────────────────────────────────────────
    const filesSet = new Set<string>();
    for (const entry of symbolIndex.values()) {
        filesSet.add(toRelative(entry.filePath));
    }
    const filesList    = Array.from(filesSet).slice(0, MAX_CONTEXT_FILES);
    const fileOverflow = filesSet.size > MAX_CONTEXT_FILES ? ` (${filesSet.size - MAX_CONTEXT_FILES} more not shown)` : '';

    // ── Symbols: exported first, then alphabetical within file ───────────
    const allEntries = Array.from(symbolIndex.values());
    allEntries.sort(
        (a, b) =>
            (b.isExported ? 1 : 0) - (a.isExported ? 1 : 0) ||
            a.filePath.localeCompare(b.filePath)              ||
            a.name.localeCompare(b.name),
    );
    const topEntries    = allEntries.slice(0, MAX_CONTEXT_SYMBOLS);
    const symOverflow   = allEntries.length > MAX_CONTEXT_SYMBOLS
        ? ` (${allEntries.length - MAX_CONTEXT_SYMBOLS} more not shown)`
        : '';

    const symbolLines = topEntries
        .map(e =>
            `  ${e.name} [${e.kind}${e.isExported ? ', exported' : ''}]` +
            ` — ${toRelative(e.filePath)}:${e.startLine}`,
        )
        .join('\n');

    return (
        `## Repository context\n\n` +
        `Source files (${filesList.length}${fileOverflow}):\n` +
        filesList.map(f => `  ${f}`).join('\n') +
        `\n\nIndexed symbols (${topEntries.length}${symOverflow}, exported first):\n` +
        symbolLines
    );
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

/**
 * Build the full LLM prompt from a developer prompt and optional repo context.
 *
 * When `repoContext` is provided the model is instructed to use only existing
 * names; without it the model must guess (less accurate but still works).
 */
function buildPrompt(developerPrompt: string, repoContext: string | null): string {
    const repoSection = repoContext
        ? `\nCRITICAL CONSTRAINT: symbolHints MUST contain ONLY names that appear ` +
          `verbatim in the "Indexed symbols" list below. fileHints MUST contain ONLY ` +
          `paths from the "Source files" list. If the described change does not match ` +
          `any real symbol or file in the list, return empty arrays [] — do NOT invent ` +
          `names, do NOT use names from outside this codebase.\n\n` +
          repoContext + '\n'
        : '';

    return (
        `You are a code-change intent analyzer for a TypeScript codebase.\n` +
        `\n` +
        `Given a developer's description of a planned code change, extract structured\n` +
        `information and return ONLY a valid JSON object — no markdown, no explanation,\n` +
        `no code fences. The object must match this exact shape:\n` +
        `\n` +
        `{\n` +
        `  "changeType": "add" | "modify" | "delete" | "refactor" | "unknown",\n` +
        `  "symbolHints": ["exact symbol names from the Indexed symbols list"],\n` +
        `  "fileHints": ["exact relative file paths from the Source files list"],\n` +
        `  "affectsPublicApi": true | false,\n` +
        `  "summary": "one sentence plain-English description of the change"\n` +
        `}\n` +
        `\n` +
        `Rules:\n` +
        `- changeType must be one of the five string literals shown.\n` +
        `- symbolHints: ONLY use names that exist verbatim in the "Indexed symbols" list.\n` +
        `  If no real symbol matches the intent, return [].\n` +
        `  Include symbols whose implementation would need to change.\n` +
        `- fileHints: ONLY use paths that exist verbatim in the "Source files" list.\n` +
        `  If no file matches, return [].\n` +
        `- affectsPublicApi is true when exported function signatures, parameter types,\n` +
        `  return types, or exported symbol names would change.\n` +
        `- summary must be a single sentence, no longer than 20 words.\n` +
        `- Return ONLY the JSON object, nothing else.\n` +
        repoSection +
        `\nDeveloper prompt: ${developerPrompt}`
    );
}

// ---------------------------------------------------------------------------
// LLM model selector
// ---------------------------------------------------------------------------

/**
 * Attempt to acquire a Copilot chat model in preference order.
 * Falls back progressively so the parser works on any Copilot tier.
 */
async function selectModel(
    token: vscode.CancellationToken,
): Promise<vscode.LanguageModelChat | undefined> {
    const selectors: vscode.LanguageModelChatSelector[] = [
        { vendor: 'copilot', family: 'gpt-4o' },
        { vendor: 'copilot', family: 'gpt-4' },
        { vendor: 'copilot', family: 'gpt-3.5-turbo' },
        { vendor: 'copilot' },
    ];

    for (const selector of selectors) {
        if (token.isCancellationRequested) { return undefined; }
        const models = await vscode.lm.selectChatModels(selector);
        if (models.length > 0) { return models[0]; }
    }
    return undefined;
}

// ---------------------------------------------------------------------------
// Response parser
// ---------------------------------------------------------------------------

/**
 * Extract and validate JSON from the raw LLM response text.
 * Tolerates a small amount of surrounding prose by scanning for the first
 * `{` … `}` block.
 */
function parseResponse(raw: string, prompt: string): IntentParseResult {
    // Strip markdown code fences if the model wrapped the JSON anyway
    const stripped = raw.replace(/```(?:json)?/gi, '').trim();

    // Find the outermost JSON object
    const start = stripped.indexOf('{');
    const end   = stripped.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
        return {
            ok:    false,
            error: { prompt, reason: `LLM response contained no JSON object. Raw: ${raw.slice(0, 200)}` },
        };
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(stripped.slice(start, end + 1));
    } catch (e) {
        return {
            ok:    false,
            error: { prompt, reason: `JSON parse failed: ${String(e)}. Raw: ${raw.slice(0, 200)}` },
        };
    }

    if (typeof parsed !== 'object' || parsed === null) {
        return { ok: false, error: { prompt, reason: 'Parsed value is not an object' } };
    }

    const obj = parsed as Record<string, unknown>;

    const validChangeTypes: IntentChangeType[] = ['add', 'modify', 'delete', 'refactor', 'unknown'];
    const changeType: IntentChangeType =
        validChangeTypes.includes(obj.changeType as IntentChangeType)
            ? (obj.changeType as IntentChangeType)
            : 'unknown';

    const descriptor: IntentDescriptor = {
        prompt,
        changeType,
        symbolHints:      Array.isArray(obj.symbolHints) ? obj.symbolHints.filter(s => typeof s === 'string') : [],
        fileHints:        Array.isArray(obj.fileHints)   ? obj.fileHints.filter(s => typeof s === 'string')   : [],
        affectsPublicApi: typeof obj.affectsPublicApi === 'boolean' ? obj.affectsPublicApi : false,
        summary:          typeof obj.summary === 'string' ? obj.summary : '',
    };

    return { ok: true, value: descriptor };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a natural-language developer prompt into a structured
 * {@link IntentDescriptor} using the Copilot LLM via the VS Code LM API.
 *
 * @param prompt               The user's "What if I…" text.
 * @param token                Cancellation token — pass the one from the UI interaction.
 * @param symbolIndex          Live symbol index from the workspace (used to ground the LLM
 *                             in real symbol/file names).  Optional — if omitted the model
 *                             still works but may invent names.
 * @param workspaceRootFsPath  Absolute workspace path used to compute relative file paths
 *                             inside the repo context.  Required when symbolIndex is given.
 *
 * @returns `{ ok: true, value }` on success, `{ ok: false, error }` if the
 *          LLM is unavailable or the response cannot be parsed.
 */
export async function parseIntent(
    prompt: string,
    token: vscode.CancellationToken,
    symbolIndex?: SymbolIndex,
    workspaceRootFsPath?: string,
): Promise<IntentParseResult> {
    const trimmed = prompt.trim();
    if (!trimmed) {
        return { ok: false, error: { prompt, reason: 'Prompt is empty' } };
    }

    // ── Build repo context ──────────────────────────────────────────────────
    let repoContext: string | null = null;
    if (symbolIndex && symbolIndex.size > 0 && workspaceRootFsPath) {
        repoContext = buildRepoContext(symbolIndex, workspaceRootFsPath);
        console.log(
            `${LOG_PREFIX} Repo context built: ${symbolIndex.size} symbol(s), ` +
            `context length ${repoContext.length} chars`,
        );
    } else {
        console.warn(
            `${LOG_PREFIX} No symbol index provided — LLM will guess symbol names. ` +
            `Pass symbolIndex + workspaceRootFsPath for grounded hints.`,
        );
    }

    const fullPrompt = buildPrompt(trimmed, repoContext);

    // ── Acquire model ───────────────────────────────────────────────────────
    let model: vscode.LanguageModelChat | undefined;
    try {
        model = await selectModel(token);
    } catch (err) {
        return {
            ok:    false,
            error: { prompt, reason: `Failed to acquire LLM model: ${String(err)}` },
        };
    }

    if (!model) {
        return {
            ok:    false,
            error: { prompt, reason: 'No Copilot language model available. Ensure GitHub Copilot is installed and signed in.' },
        };
    }

    console.log(`${LOG_PREFIX} Sending prompt to model "${model.name}" (total prompt: ${fullPrompt.length} chars)…`);

    // ── Send request ────────────────────────────────────────────────────────
    const messages = [
        vscode.LanguageModelChatMessage.User(fullPrompt),
    ];

    let rawResponse = '';
    try {
        const response = await model.sendRequest(messages, {}, token);
        for await (const chunk of response.text) {
            if (token.isCancellationRequested) {
                return { ok: false, error: { prompt, reason: 'Cancelled' } };
            }
            rawResponse += chunk;
        }
    } catch (err) {
        return {
            ok:    false,
            error: { prompt, reason: `LLM request failed: ${String(err)}` },
        };
    }

    console.log(`${LOG_PREFIX} Raw response: ${rawResponse.slice(0, 300)}`);

    // ── Parse response ──────────────────────────────────────────────────────
    const result = parseResponse(rawResponse, trimmed);

    if (result.ok) {
        console.log(
            `${LOG_PREFIX} Parsed intent — changeType: ${result.value.changeType}, ` +
            `symbolHints: [${result.value.symbolHints.join(', ')}], ` +
            `affectsPublicApi: ${result.value.affectsPublicApi}`,
        );
    } else {
        console.warn(`${LOG_PREFIX} Parse failed — ${result.error.reason}`);
    }

    return result;
}
