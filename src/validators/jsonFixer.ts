/**
 * src/validators/jsonFixer.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Fixes common JSON issues when a frontend sends multi-line content
 * (YAML swagger specs, XML policy with embedded C# / attributes) in a JSON body.
 *
 * Problems solved:
 *  1. Literal newlines/tabs inside JSON strings  → escaped (\n, \t)
 *  2. Embedded double-quotes in YAML/XML string values
 *     (e.g. XML attributes: allow-credentials="false"
 *           YAML examples:  example: "Buy groceries"
 *           C# code:        new JProperty("error", context.LastError.Message))
 *     → detected via two-level look-ahead heuristic and escaped as \"
 *
 * Heuristic — a `"` inside a string is a TERMINATOR only when:
 *   • next non-ws char is }  or ]  → end of JSON object/array
 *   • next non-ws char is :        → end of a JSON key
 *   • next non-ws char is ,  AND the char after that (skipping ws) is " → real JSON separator
 *   • end of input (null)
 *
 * In all other cases the `"` is treated as an embedded quote and escaped.
 *
 * This correctly handles:
 *   "error", context.LastError.Message   → next after , is 'c'  → embedded ✅
 *   "value",                             → next after , is '"'  → terminator ✅
 *   allow-credentials="false">          → next after " is '>'  → embedded ✅
 *   example: "Buy groceries"            → next after " is '\n' then 'c' → embedded ✅
 */

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns [char | null, position] of the next non-whitespace char at or after pos.
 */
function peekNext(raw: string, pos: number): [string | null, number] {
    for (let i = pos; i < raw.length; i++) {
        const c = raw[i];
        if (c !== ' ' && c !== '\t' && c !== '\n' && c !== '\r') {
            return [c, i];
        }
    }
    return [null, raw.length];
}

/**
 * Decides if the `"` at position `i` (inside a string) is a JSON string
 * terminator or an embedded quote that should be escaped.
 */
function isStringTerminator(raw: string, i: number): boolean {
    const [next, nextPos] = peekNext(raw, i + 1);

    // Definitely a terminator: end of JSON value in object/array/key
    if (next === '}' || next === ']' || next === ':' || next === null) {
        return true;
    }

    // Comma — could be JSON separator OR embedded (e.g. in C# method args)
    if (next === ',') {
        const [afterComma] = peekNext(raw, nextPos + 1);
        // It's a JSON separator only if the next token after the comma
        // starts a new JSON value (a `"` for a key or string) or closes structure
        return afterComma === '"' || afterComma === '}' || afterComma === ']' || afterComma === null;
    }

    // Anything else (letters, digits, >, /, etc.) → embedded quote
    return false;
}

// ─── Main fixer ───────────────────────────────────────────────────────────────

/**
 * Single-pass character walker:
 *  - Tracks string-open/close state
 *  - Escapes literal newlines/tabs inside strings
 *  - Uses isStringTerminator() to decide whether a `"` ends the string
 *    or should be escaped as \"
 */
export function fixRawJson(raw: string): string {
    const out: string[] = [];
    let inString = false;
    let escaped = false;

    for (let i = 0; i < raw.length; i++) {
        const ch = raw[i];

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

        if (ch === '"') {
            if (!inString) {
                inString = true;
                out.push(ch);
            } else if (isStringTerminator(raw, i)) {
                inString = false;
                out.push(ch);
            } else {
                // Embedded quote — escape it
                out.push('\\"');
            }
            continue;
        }

        if (inString) {
            if (ch === '\n') { out.push('\\n'); continue; }
            if (ch === '\r') { out.push('\\r'); continue; }
            if (ch === '\t') { out.push('\\t'); continue; }
            if (ch === '\0') { continue; }
        }

        out.push(ch);
    }

    return out.join('');
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Try to parse `raw` as JSON.
 * Pass 1: standard JSON.parse (fast path — valid bodies skip the fixer)
 * Pass 2: apply fixRawJson() and retry
 * Throws descriptive error if still invalid.
 */
export function parseJsonLenient(raw: string): unknown {
    try {
        return JSON.parse(raw);
    } catch { /* fall through */ }

    const fixed = fixRawJson(raw);
    try {
        return JSON.parse(fixed);
    } catch (err) {
        throw new Error(`Invalid JSON body (even after auto-fix): ${(err as Error).message}`);
    }
}
