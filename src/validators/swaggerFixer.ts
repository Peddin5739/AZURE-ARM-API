/**
 * src/validators/swaggerFixer.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Intercepts incoming OpenAPI / Swagger payload (YAML or JSON string),
 * detects and auto-corrects common syntax errors, and returns the fixed spec.
 */

import * as yaml from 'js-yaml';
import type { SwaggerFixResult } from '../types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isJson(input: string): boolean {
    const trimmed = input.trim();
    return trimmed.startsWith('{') || trimmed.startsWith('[');
}

function sanitizeOperationIds(spec: Record<string, unknown>): string[] {
    const corrections: string[] = [];
    const paths = spec.paths as Record<string, Record<string, unknown>> | undefined;
    if (!paths) return corrections;

    for (const [pathKey, methods] of Object.entries(paths)) {
        for (const [method, operation] of Object.entries(methods)) {
            if (!operation || typeof operation !== 'object') continue;
            const op = operation as Record<string, unknown>;
            if (typeof op.operationId === 'string') {
                const sanitized = op.operationId
                    .replace(/[^a-zA-Z0-9_-]/g, '_')  // replace invalid chars
                    .replace(/^[0-9]/, '_$&');          // can't start with digit
                if (sanitized !== op.operationId) {
                    corrections.push(
                        `[path ${pathKey} ${method}] operationId "${op.operationId}" → "${sanitized}"`
                    );
                    op.operationId = sanitized;
                }
            }
        }
    }
    return corrections;
}

function fixSpecObject(spec: Record<string, unknown>): string[] {
    const corrections: string[] = [];

    // ── Ensure OpenAPI version field is present ────────────────────────────────
    if (!spec.openapi && !spec.swagger) {
        spec.openapi = '3.0.0';
        corrections.push('Added missing "openapi: 3.0.0" field');
    }

    // ── Ensure info object is present ─────────────────────────────────────────
    if (!spec.info || typeof spec.info !== 'object') {
        spec.info = { title: 'API', version: '1.0.0' };
        corrections.push('Added missing "info" object with defaults');
    } else {
        const info = spec.info as Record<string, unknown>;
        if (!info.title || typeof info.title !== 'string' || !info.title.trim()) {
            info.title = 'API';
            corrections.push('Fixed empty/missing info.title → "API"');
        }
        if (!info.version || typeof info.version !== 'string' || !info.version.trim()) {
            info.version = '1.0.0';
            corrections.push('Fixed empty/missing info.version → "1.0.0"');
        }
    }

    // ── Ensure paths object is present ────────────────────────────────────────
    if (!spec.paths || typeof spec.paths !== 'object') {
        spec.paths = {};
        corrections.push('Added missing "paths" object');
    }

    // ── Sanitize operationIds ──────────────────────────────────────────────────
    corrections.push(...sanitizeOperationIds(spec));

    // ── Fix servers array (OpenAPI 3.x) ───────────────────────────────────────
    if (spec.openapi && !spec.servers) {
        spec.servers = [{ url: '/' }];
        corrections.push('Added default servers: [{ url: "/" }]');
    }

    // ── Strip null/undefined top-level keys that ARM rejects ──────────────────
    for (const [k, v] of Object.entries(spec)) {
        if (v === null || v === undefined) {
            delete spec[k];
            corrections.push(`Removed null top-level key "${k}"`);
        }
    }

    return corrections;
}

// ─── Main Export ──────────────────────────────────────────────────────────────

/**
 * Parses and auto-corrects an OpenAPI/Swagger specification.
 * Accepts: YAML string, JSON string, or an already-parsed object.
 * Returns a corrected JSON string + list of corrections applied.
 *
 * @throws Error if the input cannot be parsed at all (unrecoverable)
 */
export function fixSwagger(input: string | Record<string, unknown>): SwaggerFixResult {
    const corrections: string[] = [];
    let spec: Record<string, unknown>;
    let format: 'yaml' | 'json' = 'json';

    // ── If already a parsed object, use it directly (no string parsing needed) ─
    if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
        spec = input;
        corrections.push('Received swagger as JSON object (no string parsing needed)');
    } else {
        // ── String input: detect format then parse ─────────────────────────────
        const str = input as string;
        format = isJson(str) ? 'json' : 'yaml';

        try {
            spec = (format === 'json'
                ? JSON.parse(str)
                : yaml.load(str)) as Record<string, unknown>;
        } catch (parseErr) {
            // Try to salvage: strip BOM and retry
            const stripped = str.replace(/^\uFEFF/, '').trim();
            try {
                spec = (format === 'json'
                    ? JSON.parse(stripped)
                    : yaml.load(stripped)) as Record<string, unknown>;
                corrections.push('Removed leading BOM character');
            } catch {
                throw new Error(`Cannot parse swagger as ${format.toUpperCase()}: ${(parseErr as Error).message}`);
            }
        }
    }

    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
        throw new Error('Swagger input must be an object (map), not an array or primitive.');
    }

    // ── Fix ────────────────────────────────────────────────────────────────────
    corrections.push(...fixSpecObject(spec));

    // ── Always serialize as JSON for ARM import ─────────────────────────────────
    const fixed = JSON.stringify(spec, null, 2);

    return { fixed, format, corrections };
}
