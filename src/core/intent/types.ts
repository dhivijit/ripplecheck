// ---------------------------------------------------------------------------
// Intent types
//
// All predictive-analysis types live here.  Every other intent module imports
// from this file so there is a single source of truth for the data shapes.
// ---------------------------------------------------------------------------

/**
 * The kind of change the user intends to make.
 *
 * - `add`       : introducing new code (new function, class, route, …)
 * - `modify`    : changing existing code (update signature, body, config, …)
 * - `delete`    : removing existing code
 * - `refactor`  : restructuring without changing observable behaviour
 * - `unknown`   : LLM could not determine the change type
 */
export type IntentChangeType = 'add' | 'modify' | 'delete' | 'refactor' | 'unknown';

/**
 * Structured description of a developer's intended change, extracted from a
 * natural-language prompt by the LLM parser.
 *
 * Produced by `intentParser.parseIntent()`.
 * Consumed by `intentResolver.resolveIntent()` (Step 2).
 */
export interface IntentDescriptor {
    /** Original natural-language prompt the user typed. */
    prompt: string;

    /** Categorised intent type. */
    changeType: IntentChangeType;

    /**
     * Function / class / interface names mentioned or strongly implied.
     * Used by the resolver to fuzzy-match against the live symbol index.
     * e.g. ["authenticate", "AuthMiddleware", "verifyToken"]
     */
    symbolHints: string[];

    /**
     * File path fragments or patterns mentioned or implied.
     * e.g. ["routes/auth", "middleware", "auth.ts"]
     */
    fileHints: string[];

    /**
     * Whether the described change is likely to affect the public API surface
     * (exported symbols, function signatures, etc.).
     *
     * true  → downstream callers are at risk (deep blast radius)
     * false → implementation-only change (shallow blast radius)
     */
    affectsPublicApi: boolean;

    /** One-sentence plain-English summary produced by the LLM. */
    summary: string;
}

/**
 * Returned when the LLM is unavailable or the prompt cannot be parsed into a
 * valid IntentDescriptor.
 */
export interface IntentParseError {
    prompt: string;
    reason: string;
}

/** Union of possible outcomes from `parseIntent`. */
export type IntentParseResult =
    | { ok: true;  value: IntentDescriptor }
    | { ok: false; error: IntentParseError };
