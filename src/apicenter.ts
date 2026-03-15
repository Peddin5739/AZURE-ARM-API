/**
 * src/apicenter.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Azure API Center (ACP) ARM REST API helpers — TypeScript port of apicenter.js
 */

import type { ApiCenterContext } from './types';

const ARM_BASE = 'https://management.azure.com';
const ARM_API_VERSION = '2024-03-01';

async function getArmToken(ctx: ApiCenterContext): Promise<string> {
    const t = await ctx.credential.getToken('https://management.azure.com/.default');
    if (!t) throw new Error('Failed to acquire ARM token for API Center');
    return t.token;
}

function apiUrl(ctx: ApiCenterContext, apiId: string): string {
    return (
        `${ARM_BASE}/subscriptions/${ctx.subscriptionId}` +
        `/resourceGroups/${ctx.resourceGroup}` +
        `/providers/Microsoft.ApiCenter/services/${ctx.serviceName}` +
        `/workspaces/default/apis/${apiId}?api-version=${ARM_API_VERSION}`
    );
}

function listUrl(ctx: ApiCenterContext): string {
    return (
        `${ARM_BASE}/subscriptions/${ctx.subscriptionId}` +
        `/resourceGroups/${ctx.resourceGroup}` +
        `/providers/Microsoft.ApiCenter/services/${ctx.serviceName}` +
        `/workspaces/default/apis?api-version=${ARM_API_VERSION}`
    );
}

export interface AcpOnboardParams {
    apiId: string;
    title: string;
    description?: string;
    kind?: 'rest' | 'graphql' | 'grpc' | 'soap' | 'webhook' | 'websocket';
    lifecycleStage?: 'design' | 'development' | 'testing' | 'preview' | 'production';
}

export async function onboardApi(ctx: ApiCenterContext, params: AcpOnboardParams): Promise<unknown> {
    const token = await getArmToken(ctx);
    const url = apiUrl(ctx, params.apiId);

    const body = {
        properties: {
            title: params.title,
            description: params.description ?? '',
            kind: params.kind ?? 'rest',
            lifecycleStage: params.lifecycleStage ?? 'development',
            externalDocumentation: [],
            contacts: [],
        },
    };

    const res = await fetch(url, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const data = await res.json() as Record<string, unknown>;
    if (!res.ok) {
        throw new Error(
            `ACP onboard failed [${res.status}]: ${(data?.error as Record<string, unknown>)?.message ?? JSON.stringify(data)}`
        );
    }
    return data;
}

export async function deleteApi(ctx: ApiCenterContext, apiId: string): Promise<void> {
    const token = await getArmToken(ctx);
    const url = apiUrl(ctx, apiId);

    const res = await fetch(url, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
    });

    if (res.status === 204 || res.status === 200) return;
    if (res.status === 404) throw new Error(`API '${apiId}' not found in Azure API Center.`);

    let errBody: Record<string, unknown> = {};
    try { errBody = await res.json() as Record<string, unknown>; } catch { /* noop */ }
    throw new Error(
        `ACP delete failed [${res.status}]: ${(errBody?.error as Record<string, unknown>)?.message ?? res.statusText}`
    );
}

export async function listApis(ctx: ApiCenterContext): Promise<unknown[]> {
    const token = await getArmToken(ctx);
    const url = listUrl(ctx);

    const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json() as Record<string, unknown>;
    if (!res.ok) {
        throw new Error(
            `ACP list failed [${res.status}]: ${(data?.error as Record<string, unknown>)?.message ?? JSON.stringify(data)}`
        );
    }
    return (data.value as unknown[] | undefined) ?? [];
}
