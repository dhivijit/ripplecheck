import * as vscode from 'vscode';
import {
    IntentDescriptor,
    IntentChangeType,
    IntentParseResult,
} from './types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOG_PREFIX = '[RippleCheck][Intent]';

/**
 * System instructions embedded in the user message (VS Code LM API has no
 * dedicated system-message role, so we prefix the instructions inline).
 */
const SYSTEM_INSTRUCTIONS = `\
You are a code-change intent analyzer for a TypeScript codebase.

Given a developer's description of a planned code change, extract structured
information and return ONLY a valid JSON object — no markdown, no explanation,
no code fences.  The object must match this exact shape:

{
  "changeType": "add" | "modify" | "delete" | "refactor" | "unknown",
  "symbolHints": ["function or class names mentioned or strongly implied"],
  "fileHints": ["file paths, directories, or filename patterns mentioned"],
  "affectsPublicApi": true | false,
  "summary": "one sentence plain-English description of the change"
}

Rules:
- changeType must be one of the five string literals shown.
- symbolHints and fileHints may be empty arrays if nothing is mentioned.
- affectsPublicApi is true when the change is likely to alter exported
  function signatures, add/remove exported symbols, or change module shape.
- summary must be a single sentence, no longer than 20 words.
- Return nothing except the JSON object.

Developer prompt:
`;

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
 * @param prompt  The user's "What if I…" text.
 * @param token   Cancellation token — pass the one from the UI interaction.
 *
 * @returns `{ ok: true, value }` on success, `{ ok: false, error }` if the
 *          LLM is unavailable or the response cannot be parsed.
 *
 * @example
 * ```ts
 * const result = await parseIntent('add auth middleware to all API routes', token);
 * if (result.ok) {
 *     console.log(result.value.symbolHints); // ['authenticate', 'AuthMiddleware', ...]
 * }
 * ```
 */
export async function parseIntent(
    prompt: string,
    token: vscode.CancellationToken,
): Promise<IntentParseResult> {
    const trimmed = prompt.trim();
    if (!trimmed) {
        return { ok: false, error: { prompt, reason: 'Prompt is empty' } };
    }

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

    console.log(`${LOG_PREFIX} Sending prompt to model "${model.name}"…`);

    // ── Send request ────────────────────────────────────────────────────────
    const messages = [
        vscode.LanguageModelChatMessage.User(SYSTEM_INSTRUCTIONS + trimmed),
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
