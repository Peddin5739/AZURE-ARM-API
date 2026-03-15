/**
 * src/validators/policyFixer.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Intercepts incoming APIM policy XML strings, detects common syntax errors,
 * auto-corrects them, and returns the fixed XML.
 *
 * APIM policy XML must follow the structure:
 *   <policies>
 *     <inbound>...</inbound>
 *     <backend>...</backend>
 *     <outbound>...</outbound>
 *     <on-error>...</on-error>
 *   </policies>
 */

import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { PolicyFixResult } from '../types';

// ─── Constants ────────────────────────────────────────────────────────────────

const REQUIRED_SECTIONS = ['inbound', 'backend', 'outbound', 'on-error'] as const;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function stripXmlDeclaration(xml: string): { stripped: string; hadDecl: boolean } {
    const decl = /^\s*<\?xml[^?]*\?>\s*/i;
    const stripped = xml.replace(decl, '');
    return { stripped, hadDecl: stripped.length !== xml.trim().length };
}

function wrapInPoliciesTag(inner: string, corrections: string[]): string {
    const trimmed = inner.trim();
    // Already wrapped
    if (/^<policies[\s>]/i.test(trimmed)) return trimmed;

    // Has one of the known section tags at the top — wrap it
    const hasSectionTag = REQUIRED_SECTIONS.some(s => trimmed.includes(`<${s}`));
    if (hasSectionTag) {
        corrections.push('Wrapped bare policy sections in <policies> root element');
        return `<policies>\n  ${trimmed}\n</policies>`;
    }

    // Assume the entire content is "inbound" body
    corrections.push('Wrapped bare content as <policies><inbound>...</inbound>... structure');
    return `<policies>\n  <inbound>\n    ${trimmed}\n  </inbound>\n  <backend>\n    <forward-request />\n  </backend>\n  <outbound />\n  <on-error />\n</policies>`;
}

function ensureSections(xml: string, corrections: string[]): string {
    let result = xml;
    for (const section of REQUIRED_SECTIONS) {
        if (!result.includes(`<${section}`)) {
            const placeholder = section === 'backend'
                ? `<${section}>\n    <forward-request />\n  </${section}>`
                : `<${section} />`;
            // Insert before closing </policies>
            result = result.replace('</policies>', `  ${placeholder}\n</policies>`);
            corrections.push(`Added missing <${section}> section`);
        }
    }
    return result;
}

function sanitizeXml(xml: string, corrections: string[]): string {
    let result = xml;

    // Remove null bytes
    if (result.includes('\0')) {
        result = result.replace(/\0/g, '');
        corrections.push('Removed null bytes from XML');
    }

    // Remove BOM
    if (result.startsWith('\uFEFF')) {
        result = result.slice(1);
        corrections.push('Removed BOM from XML');
    }

    return result;
}

// ─── Main Export ──────────────────────────────────────────────────────────────

/**
 * Parses and auto-corrects an APIM policy XML string.
 * Returns the fixed XML and a list of corrections applied.
 *
 * @throws Error only if the XML is so broken it cannot be recovered
 */
export function fixPolicyXml(input: string): PolicyFixResult {
    const corrections: string[] = [];
    let xml = sanitizeXml(input.trim(), corrections);

    // ── Strip XML declaration (ARM doesn't want it) ───────────────────────────
    const { stripped, hadDecl } = stripXmlDeclaration(xml);
    if (hadDecl) {
        corrections.push('Removed <?xml ...?> declaration (not accepted by ARM)');
        xml = stripped;
    }

    // ── Ensure <policies> root ────────────────────────────────────────────────
    xml = wrapInPoliciesTag(xml, corrections);

    // ── Validate with fast-xml-parser ─────────────────────────────────────────
    const validationResult = XMLValidator.validate(xml, {
        allowBooleanAttributes: true
    });

    if (validationResult !== true) {
        // Attempt basic recovery: re-escape stray ampersands outside CDATA
        const escaped = xml.replace(/&(?!amp;|lt;|gt;|quot;|apos;|#[0-9]+;|#x[0-9a-fA-F]+;)/g, '&amp;');
        const recheck = XMLValidator.validate(escaped, { allowBooleanAttributes: true });
        if (recheck === true) {
            corrections.push(`Escaped unencoded & characters: "${validationResult.err?.msg}"`);
            xml = escaped;
        } else {
            // Surface the error but still proceed — ARM may accept it
            corrections.push(`⚠ XML validation warning (best-effort): ${validationResult.err?.msg}`);
        }
    }

    // ── Ensure all required sections exist ───────────────────────────────────
    xml = ensureSections(xml, corrections);

    // ── Final parse to pretty-print (optional, best-effort) ───────────────────
    try {
        const parser = new XMLParser({
            ignoreAttributes: false,
            preserveOrder: true,
            trimValues: false,
        });
        parser.parse(xml); // just validate — we keep the string as-is
    } catch {
        // Non-fatal — XML might still work with ARM
    }

    return { fixed: xml.trim(), corrections };
}
