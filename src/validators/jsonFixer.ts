/**
 * src/validators/jsonFixer.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Fixes common JSON issues when a frontend sends multi-line content
 * (YAML swagger specs, XML policy) inside a JSON body.
 *
 * Two problems solved:
 *  1. Literal newlines/tabs inside JSON strings → escaped (\n, \t)
 *  2. Embedded double quotes inside YAML values (e.g. example: "value")
 *     → detected via look-ahead heuristic and escaped as \"
 *
 * Heuristic for embedded quotes:
 *   A `"` inside a JSON string is a legitimate string-terminator ONLY if
 *   the next non-whitespace character in the RAW source is one of: , } ]
 *   Any other following character means the `"` is embedded and gets escaped.
 */

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns the next non-whitespace character at or after `pos` in `raw`.
 * Returns null if only whitespace/end remains.
 */
function peekNextMeaningful(raw: string, pos: number): string | null {
    for (let i = pos; i < raw.length; i++) {
        const c = raw[i];
        if (c !== ' ' && c !== '\t' && c !== '\n' && c !== '\r') {
            return c;
        }
    }
    return null;
}

/**
 * State-machine walker that:
 *  - Tracks whether we are inside a JSON string
 *  - Replaces literal newlines/tabs/CR with their escaped equivalents
 *  - Applies the look-ahead heuristic to decide whether a `"` inside a string
 *    is a terminator or an embedded quote that should be escaped
 */
export function fixRawJson(raw: string): string {
    const out: string[] = [];
    let inString = false;
    let escaped = false;

    for (let i = 0; i < raw.length; i++) {
        const ch = raw[i];

        // ── Handle escape sequences ────────────────────────────────────────────
        if (escaped) {
            out.push(ch);
            escaped = false;
            continue;
        }

        if (ch === '\\' && inString) {
            out.push(ch);
            escaped = true;
            continue;
        }

        // ── Handle double-quote ────────────────────────────────────────────────
        if (ch === '"') {
            if (!inString) {
                // Opening a string — always accepted
                inString = true;
                out.push(ch);
            } else {
                // Inside a string: is this a terminator or an embedded quote?
                const next = peekNextMeaningful(raw, i + 1);

                // Valid JSON string terminators: , } ] : (key separator) or end of input
                const isTerminator = next === ',' || next === '}' || next === ']' || next === ':' || next === null;

                if (isTerminator) {
                    // Legitimate end of this string value
                    inString = false;
                    out.push(ch);
                } else {
                    // Embedded quote inside YAML/XML — escape it
                    out.push('\\"');
                }
            }
            continue;
        }

        // ── Inside a string: escape literal control chars ──────────────────────
        if (inString) {
            if (ch === '\n') { out.push('\\n'); continue; }
            if (ch === '\r') { out.push('\\r'); continue; }
            if (ch === '\t') { out.push('\\t'); continue; }
            if (ch === '\0') { continue; }          // drop NUL bytes
        }

        out.push(ch);
    }

    return out.join('');
}

// ─── Main Export ──────────────────────────────────────────────────────────────

/**
 * Attempts to parse raw text as JSON.
 * Pass 1: standard JSON.parse
 * Pass 2: apply fixRawJson() (escape embedded newlines + embedded quotes) and retry
 * Throws if still invalid after fixing.
 */
export function parseJsonLenient(raw: string): unknown {
    // Fast path: valid JSON as-is
    try {
        return JSON.parse(raw);
    } catch {
        /* fall through to fix */
    }

    // Slow path: fix and retry
    const fixed = fixRawJson(raw);
    try {
        return JSON.parse(fixed);
    } catch (err2) {
        throw new Error(`Invalid JSON body (even after auto-fix): ${(err2 as Error).message}`);
    }
}
