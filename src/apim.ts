/**
 * src/apim.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Azure API Management (APIM) ARM REST API helper functions.
 * All operations are typed and use direct ARM REST calls.
 *
 * ARM base pattern:
 *   https://management.azure.com
 *     /subscriptions/{subId}
 *     /resourceGroups/{rg}
 *     /providers/Microsoft.ApiManagement/service/{apimName}
 *     /{resource}
 *     ?api-version=2022-08-01
 */

import type { ApimContext, NamedValueParams, BackendParams, ApiParams, ProductParams, SubscriptionParams } from './types';

const ARM_BASE = 'https://management.azure.com';
const API_VER = '2022-08-01';

// ─── Token helper ─────────────────────────────────────────────────────────────

async function getArmToken(ctx: ApimContext): Promise<string> {
    const t = await ctx.credential.getToken('https://management.azure.com/.default');
    if (!t) throw new Error('Failed to acquire ARM token');
    return t.token;
}

// ─── URL builders ─────────────────────────────────────────────────────────────

function serviceBase({ subscriptionId, resourceGroup, apimName }: ApimContext): string {
    return (
        `${ARM_BASE}/subscriptions/${subscriptionId}` +
        `/resourceGroups/${resourceGroup}` +
        `/providers/Microsoft.ApiManagement/service/${apimName}`
    );
}

function qv(extra = ''): string {
    return `?api-version=${API_VER}${extra}`;
}

// ─── Safe response parser ─────────────────────────────────────────────────────

async function parseResponse(res: Response): Promise<unknown> {
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('json')) return res.json();
    return res.text();
}

function assertOk(data: unknown, res: Response, label: string): void {
    if (!res.ok) {
        let msg = String(data);
        if (typeof data === 'object' && data !== null) {
            const errObj = (data as Record<string, unknown>)?.error as Record<string, unknown> | undefined;
            if (errObj) {
                msg = (errObj.message as string) ?? JSON.stringify(data);
                // Pull in ARM nested detail messages
                const details = errObj.details as Array<Record<string, unknown>> | undefined;
                if (Array.isArray(details) && details.length > 0) {
                    const detailMsgs = details.map(d => d.message).filter(Boolean).join(' | ');
                    if (detailMsgs) msg += ` (Details: ${detailMsgs})`;
                }
            } else {
                msg = JSON.stringify(data);
            }
        }
        throw new Error(`${label} failed [${res.status}]: ${msg}`);
    }
}


// ─── 1. Named Value ───────────────────────────────────────────────────────────

/**
 * Creates or updates a Named Value (aka key-value store entry) in APIM.
 */
export async function createOrUpdateNamedValue(
    ctx: ApimContext,
    params: NamedValueParams
): Promise<unknown> {
    const token = await getArmToken(ctx);
    const url = `${serviceBase(ctx)}/namedValues/${params.namedValueId}${qv()}`;

    const body = {
        properties: {
            displayName: params.displayName,
            value: params.value,
            secret: params.isSecret ?? false,
            tags: params.tags ?? [],
        },
    };

    const res = await fetch(url, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const data = await parseResponse(res);
    assertOk(data, res, `Named value "${params.namedValueId}"`);
    return data;
}

// ─── 2. Backend ───────────────────────────────────────────────────────────────

/**
 * Creates or updates a Backend service entry in APIM.
 */
export async function createOrUpdateBackend(
    ctx: ApimContext,
    params: BackendParams
): Promise<unknown> {
    const token = await getArmToken(ctx);
    const url = `${serviceBase(ctx)}/backends/${params.backendId}${qv()}`;

    const body = {
        properties: {
            url: params.url,
            protocol: params.protocol ?? 'http',  // ARM accepts 'http' or 'soap' — HTTPS is inferred from the URL
            title: params.title ?? params.backendId,
            description: params.description ?? '',
        },
    };

    const res = await fetch(url, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const data = await parseResponse(res);
    assertOk(data, res, `Backend "${params.backendId}"`);
    return data;
}

// ─── 3a. API (create / swagger import) ───────────────────────────────────────

/**
 * Creates or updates an API in APIM.
 * If `params.swagger` is provided the API is imported from the OpenAPI spec;
 * otherwise a blank API is created with the given properties.
 */
export async function createOrUpdateApi(
    ctx: ApimContext,
    params: ApiParams
): Promise<unknown> {
    const token = await getArmToken(ctx);
    const url = `${serviceBase(ctx)}/apis/${params.apiId}${qv()}`;

    let body: Record<string, unknown>;

    if (params.swagger) {
        // swagger is always a JSON string at this point (fixSwagger serializes to JSON)
        const swaggerStr = typeof params.swagger === 'string'
            ? params.swagger
            : JSON.stringify(params.swagger);
        body = {
            properties: {
                format: 'openapi+json',
                value: swaggerStr,
                path: params.path,
                serviceUrl: params.serviceUrl,
                displayName: params.displayName,
                description: params.description ?? '',
                protocols: params.protocols ?? ['https'],
                subscriptionRequired: params.subscriptionRequired ?? true,
            },
        };
    } else {
        body = {
            properties: {
                displayName: params.displayName,
                description: params.description ?? '',
                path: params.path,
                protocols: params.protocols ?? ['https'],
                subscriptionRequired: params.subscriptionRequired ?? true,
                serviceUrl: params.serviceUrl,
            },
        };
    }

    const res = await fetch(url, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const data = await parseResponse(res);
    assertOk(data, res, `API "${params.apiId}"`);
    return data;
}

// ─── 3b. API Policy ───────────────────────────────────────────────────────────

/**
 * Sets or replaces the XML policy on an APIM API.
 */
export async function setApiPolicy(
    ctx: ApimContext,
    params: { apiId: string; policyXml: string }
): Promise<unknown> {
    const token = await getArmToken(ctx);
    const url = `${serviceBase(ctx)}/apis/${params.apiId}/policies/policy${qv()}`;

    const body = {
        properties: { format: 'xml', value: params.policyXml },
    };

    const res = await fetch(url, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const data = await parseResponse(res);
    assertOk(data, res, `API policy for "${params.apiId}"`);
    return data;
}

// ─── 4. Product ───────────────────────────────────────────────────────────────

/**
 * Creates or updates a Product in APIM.
 */
export async function createOrUpdateProduct(
    ctx: ApimContext,
    params: ProductParams
): Promise<unknown> {
    const token = await getArmToken(ctx);
    const url = `${serviceBase(ctx)}/products/${params.productId}${qv()}`;

    const body = {
        properties: {
            displayName: params.displayName,
            description: params.description ?? '',
            subscriptionRequired: params.subscriptionRequired ?? true,
            state: params.state ?? 'published',
        },
    };

    const res = await fetch(url, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const data = await parseResponse(res);
    assertOk(data, res, `Product "${params.productId}"`);
    return data;
}

// ─── 4a. Product Policy ───────────────────────────────────────────────────────

/**
 * Sets or replaces the XML policy on an APIM Product.
 */
export async function setProductPolicy(
    ctx: ApimContext,
    params: { productId: string; policyXml: string }
): Promise<unknown> {
    const token = await getArmToken(ctx);
    const url = `${serviceBase(ctx)}/products/${params.productId}/policies/policy${qv()}`;

    const body = {
        properties: { format: 'xml', value: params.policyXml },
    };

    const res = await fetch(url, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const data = await parseResponse(res);
    assertOk(data, res, `Product policy for "${params.productId}"`);
    return data;
}

// ─── 5. Product–API Association ───────────────────────────────────────────────

/**
 * Links an API to a Product so it becomes accessible through that product.
 */
export async function associateApiWithProduct(
    ctx: ApimContext,
    params: { productId: string; apiId: string }
): Promise<unknown> {
    const token = await getArmToken(ctx);
    const url = `${serviceBase(ctx)}/products/${params.productId}/apis/${params.apiId}${qv()}`;

    const res = await fetch(url, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
    });
    const data = await parseResponse(res);
    assertOk(data, res, `Association product "${params.productId}" ↔ api "${params.apiId}"`);
    return data;
}

// ─── 6. Subscription ─────────────────────────────────────────────────────────

/**
 * Creates or updates a Subscription in APIM.
 * Defaults scope to /apis/{apiId} when `scope` is not provided.
 */
export async function createSubscription(
    ctx: ApimContext,
    params: SubscriptionParams & { apiId?: string }
): Promise<unknown> {
    const token = await getArmToken(ctx);
    const url = `${serviceBase(ctx)}/subscriptions/${params.subscriptionId}${qv()}`;

    const scope =
        params.scope ??
        `${serviceBase(ctx)}/apis/${params.apiId ?? ''}`;

    const body = {
        properties: {
            displayName: params.displayName,
            scope,
            state: 'active',
        },
    };

    const res = await fetch(url, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const data = await parseResponse(res);
    assertOk(data, res, `Subscription "${params.subscriptionId}"`);
    return data;
}

// ─── List APIs ────────────────────────────────────────────────────────────────

export async function listApis(ctx: ApimContext): Promise<unknown[]> {
    const token = await getArmToken(ctx);
    const url = `${serviceBase(ctx)}/apis${qv()}`;

    const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    const data = await parseResponse(res) as Record<string, unknown>;
    assertOk(data, res, 'List APIs');
    return (data.value as unknown[] | undefined) ?? [];
}

// ─── Delete API ───────────────────────────────────────────────────────────────

export async function deleteApi(ctx: ApimContext, apiId: string): Promise<void> {
    const token = await getArmToken(ctx);
    const url = `${serviceBase(ctx)}/apis/${apiId}${qv()}`;

    const res = await fetch(url, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}`, 'If-Match': '*' },
    });

    if (res.status === 204 || res.status === 200) return;
    if (res.status === 404) return; // already gone — safe for rollback
    const data = await parseResponse(res);
    throw new Error(`Delete API failed [${res.status}]: ${JSON.stringify(data)}`);
}

// ─── Saga Rollback Helpers ────────────────────────────────────────────────────
// Each function is a compensating transaction used when a later step fails.
// All silently ignore 404 (resource already absent) and catch errors to ensure
// the entire rollback stack completes even if one delete fails.

async function safeDelete(url: string, token: string, label: string): Promise<void> {
    try {
        const res = await fetch(url, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${token}`, 'If-Match': '*' },
        });
        if (res.status === 404 || res.status === 204 || res.status === 200) return;
        const data = await parseResponse(res);
        console.warn(`[Rollback] ${label} → [${res.status}]: ${JSON.stringify(data)}`);
    } catch (err) {
        console.warn(`[Rollback] ${label} → ${(err as Error).message}`);
    }
}

export async function rollbackNamedValue(ctx: ApimContext, namedValueId: string): Promise<void> {
    const token = await getArmToken(ctx);
    await safeDelete(
        `${serviceBase(ctx)}/namedValues/${namedValueId}${qv()}`,
        token, `NamedValue "${namedValueId}"`,
    );
}

export async function rollbackBackend(ctx: ApimContext, backendId: string): Promise<void> {
    const token = await getArmToken(ctx);
    await safeDelete(
        `${serviceBase(ctx)}/backends/${backendId}${qv()}`,
        token, `Backend "${backendId}"`,
    );
}

export async function rollbackProduct(ctx: ApimContext, productId: string): Promise<void> {
    const token = await getArmToken(ctx);
    await safeDelete(
        `${serviceBase(ctx)}/products/${productId}${qv('&deleteSubscriptions=true')}`,
        token, `Product "${productId}"`,
    );
}

export async function rollbackSubscription(ctx: ApimContext, subscriptionId: string): Promise<void> {
    const token = await getArmToken(ctx);
    await safeDelete(
        `${serviceBase(ctx)}/subscriptions/${subscriptionId}${qv()}`,
        token, `Subscription "${subscriptionId}"`,
    );
}

export async function rollbackApiProductAssociation(
    ctx: ApimContext, productId: string, apiId: string,
): Promise<void> {
    const token = await getArmToken(ctx);
    await safeDelete(
        `${serviceBase(ctx)}/products/${productId}/apis/${apiId}${qv()}`,
        token, `Association "${productId}↔${apiId}"`,
    );
}

