/**
 * src/index.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Fastify server — Azure APIM / API Center onboarding via ARM REST API.
 *
 * Key endpoint:
 *   POST /api/apim/onboard-full   →  6-step APIM onboarding in one call
 *
 * All other individual endpoints are also preserved.
 */

import 'isomorphic-fetch';
import * as dotenv from 'dotenv';
dotenv.config({ override: true });

import Fastify from 'fastify';
import { DefaultAzureCredential } from '@azure/identity';
import { Client } from '@microsoft/microsoft-graph-client';
import { TokenCredentialAuthenticationProvider } from '@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials/index.js';

import * as apim from './apim';
import * as apicenter from './apicenter';
import { fixSwagger } from './validators/swaggerFixer';
import { fixPolicyXml } from './validators/policyFixer';
import { parseJsonLenient } from './validators/jsonFixer';

import type {
    ApimContext,
    ApiCenterContext,
    OnboardFullRequest,
    OnboardFullResult,
    StepResult,
} from './types';

// ─── Environment ──────────────────────────────────────────────────────────────

// No client secrets needed — uses az login locally, Workload Identity on AKS
const subscriptionId = process.env.SUBSCRIPTION_ID ?? '';
const resourceGroup = process.env.RESOURCE_GROUP ?? '';
const apiCenterService = process.env.API_CENTER_SERVICE_NAME ?? '';
const apimName = process.env.APIM_SERVICE_NAME ?? '';

if (!subscriptionId || !resourceGroup) {
    console.error('❌  Please set SUBSCRIPTION_ID and RESOURCE_GROUP in your .env file.');
    process.exit(1);
}

// ─── Credential & Graph client ────────────────────────────────────────────────

// DefaultAzureCredential auto-detects: az login (local) → Workload Identity (AKS) → Managed Identity → env vars
const credential = new DefaultAzureCredential();

const authProvider = new TokenCredentialAuthenticationProvider(credential, {
    scopes: ['https://graph.microsoft.com/.default'],
});
const graphClient = Client.initWithMiddleware({ authProvider });

// ─── Context builders ─────────────────────────────────────────────────────────

function apimCtx(): ApimContext {
    return { credential, subscriptionId, resourceGroup, apimName };
}

function acpCtx(): ApiCenterContext {
    return { credential, subscriptionId, resourceGroup, serviceName: apiCenterService };
}

function checkApimCfg(): string | null {
    if (!subscriptionId || !resourceGroup || !apimName)
        return 'Missing APIM config. Set SUBSCRIPTION_ID, RESOURCE_GROUP, APIM_SERVICE_NAME in .env';
    return null;
}

function checkAcpCfg(): string | null {
    if (!subscriptionId || !resourceGroup || !apiCenterService)
        return 'Missing ACP config. Set SUBSCRIPTION_ID, RESOURCE_GROUP, API_CENTER_SERVICE_NAME in .env';
    return null;
}

// ─── Fastify setup ────────────────────────────────────────────────────────────

const server = Fastify({ logger: true });

/**
 * Custom lenient JSON body parser.
 * Must remove the built-in parser first (Fastify 4.x requirement).
 * Handles multi-line YAML swagger specs and XML policy strings sent directly
 * from a frontend textarea — literal newlines inside JSON strings are
 * auto-escaped so the body parses correctly without any frontend changes.
 */
server.removeAllContentTypeParsers();
server.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    try {
        const parsed = parseJsonLenient(body as string);
        done(null, parsed);
    } catch (err) {
        const e = err as Error;
        done(Object.assign(new Error(e.message), { statusCode: 400 }), undefined);
    }
});
server.addContentTypeParser('text/plain', { parseAs: 'string' }, (_req, body, done) => {
    done(null, body);
});

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/apim/onboard-full
//  Single call that runs all 6 APIM provisioning steps in sequence.
// ─────────────────────────────────────────────────────────────────────────────

server.post<{ Body: OnboardFullRequest }>('/api/apim/onboard-full', async (req, reply) => {
    const cfgErr = checkApimCfg();
    if (cfgErr) return reply.status(500).send({ error: cfgErr });

    const ctx = apimCtx();
    const body = req.body;

    if (!body.apiId || !body.displayName || !body.path || !body.backendUrl) {
        return reply.status(400).send({
            error: '"apiId", "displayName", "path", and "backendUrl" are required.'
        });
    }
    if (!/^[a-zA-Z0-9-]+$/.test(body.apiId)) {
        return reply.status(400).send({ error: '"apiId" must contain only alphanumeric characters and hyphens.' });
    }

    const result: OnboardFullResult = {
        success: true,
        apiId: body.apiId,
        steps: {
            namedValues: [],
            backend: { success: false },
            api: { success: false },
            apiPolicy: { success: false, skipped: true },
            product: { success: false, skipped: true },
            productPolicy: { success: false, skipped: true },
            association: { success: false, skipped: true },
            subscription: { success: false, skipped: true },
        },
    };

    // ── Step 1: Named Values ────────────────────────────────────────────────────
    if (body.namedValues && body.namedValues.length > 0) {
        for (const nv of body.namedValues) {
            const step: StepResult = { success: false };
            try {
                req.log.info(`[1] Creating named value: ${nv.name}`);
                step.data = await apim.createOrUpdateNamedValue(ctx, {
                    namedValueId: nv.name,
                    displayName: nv.name,
                    value: nv.value,
                    isSecret: nv.isSecret ?? false,
                    tags: nv.tags ?? [],
                });
                step.success = true;
            } catch (err) {
                step.error = (err as Error).message;
                result.success = false;
            }
            result.steps.namedValues.push(step);
        }
    }

    // ── Step 2: Backend ─────────────────────────────────────────────────────────
    {
        const step: StepResult = { success: false };
        try {
            req.log.info(`[2] Creating backend: ${body.apiId}-backend`);
            step.data = await apim.createOrUpdateBackend(ctx, {
                backendId: `${body.apiId}-backend`,
                url: body.backendUrl,
                title: `${body.displayName} Backend`,
                protocol: 'https',
                description: body.description ?? '',
            });
            step.success = true;
        } catch (err) {
            step.error = (err as Error).message;
            result.success = false;
        }
        result.steps.backend = step;
    }

    // ── Step 3a: API (plain or swagger import) ──────────────────────────────────
    {
        const step: StepResult = { success: false };
        let swaggerToUse: string | undefined;

        if (body.swagger) {
            try {
                const fixed = fixSwagger(body.swagger);
                swaggerToUse = fixed.fixed;
                if (fixed.corrections.length > 0) {
                    step.corrections = fixed.corrections;
                    req.log.info(`[3a] Swagger auto-corrections: ${fixed.corrections.join('; ')}`);
                }
            } catch (fixErr) {
                step.error = `Swagger parse error: ${(fixErr as Error).message}`;
                result.steps.api = { ...step, success: false };
                result.success = false;
                // Skip subsequent steps that depend on the API
                return reply.status(207).send(result);
            }
        }

        try {
            req.log.info(`[3a] Creating API: ${body.apiId}`);
            step.data = await apim.createOrUpdateApi(ctx, {
                apiId: body.apiId,
                displayName: body.displayName,
                path: body.path,
                serviceUrl: body.backendUrl,
                description: body.description ?? '',
                protocols: body.protocols ?? ['https'],
                subscriptionRequired: body.subscriptionRequired ?? true,
                swagger: swaggerToUse,
            });
            step.success = true;
        } catch (err) {
            step.error = (err as Error).message;
            result.success = false;
        }
        result.steps.api = step;
    }

    // ── Step 3b: API Policy ──────────────────────────────────────────────────────
    if (body.apiPolicy) {
        const step: StepResult = { success: false, skipped: false };
        try {
            const fixed = fixPolicyXml(body.apiPolicy);
            if (fixed.corrections.length > 0) {
                step.corrections = fixed.corrections;
                req.log.info(`[3b] Policy XML auto-corrections: ${fixed.corrections.join('; ')}`);
            }
            req.log.info(`[3b] Setting API policy on: ${body.apiId}`);
            step.data = await apim.setApiPolicy(ctx, { apiId: body.apiId, policyXml: fixed.fixed });
            step.success = true;
        } catch (err) {
            step.error = (err as Error).message;
            result.success = false;
        }
        result.steps.apiPolicy = step;
    }

    // ── Step 4: Product ──────────────────────────────────────────────────────────
    if (body.product) {
        const prod = body.product;

        // 4. Create product
        {
            const step: StepResult = { success: false, skipped: false };
            try {
                req.log.info(`[4] Creating product: ${prod.productId}`);
                step.data = await apim.createOrUpdateProduct(ctx, {
                    productId: prod.productId,
                    displayName: prod.displayName,
                    description: prod.description ?? '',
                    subscriptionRequired: prod.subscriptionRequired ?? true,
                    state: prod.state ?? 'published',
                });
                step.success = true;
            } catch (err) {
                step.error = (err as Error).message;
                result.success = false;
            }
            result.steps.product = step;
        }

        // 4a. Product policy
        if (prod.policy) {
            const step: StepResult = { success: false, skipped: false };
            try {
                const fixed = fixPolicyXml(prod.policy);
                if (fixed.corrections.length > 0) {
                    step.corrections = fixed.corrections;
                    req.log.info(`[4a] Product policy auto-corrections: ${fixed.corrections.join('; ')}`);
                }
                req.log.info(`[4a] Setting product policy on: ${prod.productId}`);
                step.data = await apim.setProductPolicy(ctx, { productId: prod.productId, policyXml: fixed.fixed });
                step.success = true;
            } catch (err) {
                step.error = (err as Error).message;
                result.success = false;
            }
            result.steps.productPolicy = step;
        }

        // 5. Associate API with Product
        {
            const step: StepResult = { success: false, skipped: false };
            try {
                req.log.info(`[5] Associating API "${body.apiId}" with product "${prod.productId}"`);
                step.data = await apim.associateApiWithProduct(ctx, {
                    productId: prod.productId,
                    apiId: body.apiId,
                });
                step.success = true;
            } catch (err) {
                step.error = (err as Error).message;
                result.success = false;
            }
            result.steps.association = step;
        }
    }

    // ── Step 6: Default Subscription ─────────────────────────────────────────────
    if (body.subscription) {
        const sub = body.subscription;
        const step: StepResult = { success: false, skipped: false };
        try {
            req.log.info(`[6] Creating subscription: ${sub.subscriptionId}`);
            step.data = await apim.createSubscription(ctx, {
                subscriptionId: sub.subscriptionId,
                displayName: sub.displayName,
                apiId: body.apiId,
            });
            step.success = true;
        } catch (err) {
            step.error = (err as Error).message;
            result.success = false;
        }
        result.steps.subscription = step;
    }

    const status = result.success ? 200 : 207; // 207 = multi-status (partial success)
    return reply.status(status).send(result);
});

// ─────────────────────────────────────────────────────────────────────────────
//  Individual APIM endpoints
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/apim/list
server.get('/api/apim/list', async (_req, reply) => {
    const cfgErr = checkApimCfg();
    if (cfgErr) return reply.status(500).send({ error: cfgErr });
    try {
        const apis = await apim.listApis(apimCtx());
        return reply.send({ count: (apis as unknown[]).length, apis });
    } catch (err) {
        return reply.status(500).send({ error: 'Failed to list APIs.', details: (err as Error).message });
    }
});

// DELETE /api/apim/:apiId
server.delete<{ Params: { apiId: string } }>('/api/apim/:apiId', async (req, reply) => {
    const cfgErr = checkApimCfg();
    if (cfgErr) return reply.status(500).send({ error: cfgErr });
    try {
        await apim.deleteApi(apimCtx(), req.params.apiId);
        return reply.send({ message: `API '${req.params.apiId}' deleted from APIM.` });
    } catch (err) {
        const msg = (err as Error).message;
        return reply.status(msg.includes('not found') ? 404 : 500).send({ error: msg });
    }
});

// PUT /api/apim/:apiId/policy
server.put<{ Params: { apiId: string }; Body: { policyXml: string } }>(
    '/api/apim/:apiId/policy',
    async (req, reply) => {
        const cfgErr = checkApimCfg();
        if (cfgErr) return reply.status(500).send({ error: cfgErr });
        if (!req.body?.policyXml) return reply.status(400).send({ error: '"policyXml" is required.' });

        const fixed = fixPolicyXml(req.body.policyXml);
        try {
            const data = await apim.setApiPolicy(apimCtx(), { apiId: req.params.apiId, policyXml: fixed.fixed });
            return reply.send({ message: `Policy applied to '${req.params.apiId}'.`, corrections: fixed.corrections, policy: data });
        } catch (err) {
            const msg = (err as Error).message;
            return reply.status(msg.includes('not found') ? 404 : 500).send({ error: msg });
        }
    }
);

// ─────────────────────────────────────────────────────────────────────────────
//  Azure API Center endpoints
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/apicenter/list
server.get('/api/apicenter/list', async (_req, reply) => {
    const cfgErr = checkAcpCfg();
    if (cfgErr) return reply.status(500).send({ error: cfgErr });
    try {
        const apis = await apicenter.listApis(acpCtx());
        return reply.send({ count: (apis as unknown[]).length, apis });
    } catch (err) {
        return reply.status(500).send({ error: 'Failed to list ACP APIs.', details: (err as Error).message });
    }
});

// POST /api/apicenter/onboard
server.post<{
    Body: {
        apiId: string; title: string; description?: string;
        kind?: 'rest' | 'graphql' | 'grpc' | 'soap' | 'webhook' | 'websocket';
        lifecycleStage?: 'design' | 'development' | 'testing' | 'preview' | 'production';
    };
}>('/api/apicenter/onboard', async (req, reply) => {
    const cfgErr = checkAcpCfg();
    if (cfgErr) return reply.status(500).send({ error: cfgErr });
    const { apiId, title } = req.body;
    if (!apiId || !title) return reply.status(400).send({ error: '"apiId" and "title" are required.' });
    try {
        const result = await apicenter.onboardApi(acpCtx(), req.body);
        return reply.send({ message: `API '${apiId}' onboarded in ACP.`, resource: result });
    } catch (err) {
        return reply.status(500).send({ error: 'Failed to onboard ACP API.', details: (err as Error).message });
    }
});

// DELETE /api/apicenter/:apiId
server.delete<{ Params: { apiId: string } }>('/api/apicenter/:apiId', async (req, reply) => {
    const cfgErr = checkAcpCfg();
    if (cfgErr) return reply.status(500).send({ error: cfgErr });
    try {
        await apicenter.deleteApi(acpCtx(), req.params.apiId);
        return reply.send({ message: `API '${req.params.apiId}' deleted from ACP.` });
    } catch (err) {
        const msg = (err as Error).message;
        return reply.status(msg.includes('not found') ? 404 : 500).send({ error: msg });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  Microsoft Graph — User details
// ─────────────────────────────────────────────────────────────────────────────

server.post<{ Body: { email: string } }>('/api/user-details', async (req, reply) => {
    const { email } = req.body;
    if (!email?.trim()) return reply.status(400).send({ error: 'Email is required.' });

    const targetEmail = email.trim();
    const encodedEmail = targetEmail.replace(/#/g, '%23');

    try {
        const usersResponse = await graphClient
            .api('/users')
            .filter(`userPrincipalName eq '${encodedEmail}'`)
            .select('id,displayName,userPrincipalName,jobTitle,department')
            .get() as { value: Record<string, unknown>[] };

        if (!usersResponse.value?.length) {
            return reply.status(404).send({ error: `User '${targetEmail}' not found.` });
        }

        const user = usersResponse.value[0];
        let groupsData: unknown[] = [];
        let appsData: unknown[] = [];

        try {
            const gr = await graphClient
                .api(`/users/${user.id}/memberOf?$select=id,displayName,description`)
                .get() as { value: Record<string, unknown>[] };
            groupsData = gr.value
                .filter(g => g['@odata.type'] === '#microsoft.graph.group')
                .map(g => ({ id: g.id, name: g.displayName, description: g.description ?? null }));
        } catch { /* non-fatal */ }

        try {
            const ar = await graphClient
                .api(`/users/${user.id}/appRoleAssignments`)
                .get() as { value: Record<string, unknown>[] };
            appsData = ar.value.map(a => ({
                id: a.id,
                appName: a.resourceDisplayName,
                roleId: a.appRoleId,
            }));
        } catch { /* non-fatal */ }

        return reply.send({
            user: {
                id: user.id,
                displayName: user.displayName,
                userPrincipalName: user.userPrincipalName,
                jobTitle: user.jobTitle ?? null,
                department: user.department ?? null,
            },
            groups: groupsData,
            applications: appsData,
        });
    } catch (err) {
        return reply.status(500).send({ error: 'Graph API error.', details: (err as Error).message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  Start
// ─────────────────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? '3000', 10);

server.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
    if (err) {
        server.log.error(err);
        process.exit(1);
    }
    console.log('\n📋 Azure API Management endpoints:');
    console.log(`   POST   /api/apim/onboard-full      → Full 6-step onboard (named value + backend + API + policy + product + subscription)`);
    console.log(`   GET    /api/apim/list               → List all APIs`);
    console.log(`   PUT    /api/apim/:apiId/policy      → Set/update policy XML`);
    console.log(`   DELETE /api/apim/:apiId             → Delete API`);
    console.log('\n📋 Azure API Center endpoints:');
    console.log(`   GET    /api/apicenter/list          → List all APIs`);
    console.log(`   POST   /api/apicenter/onboard       → Onboard API`);
    console.log(`   DELETE /api/apicenter/:apiId        → Delete API`);
    console.log('\n📋 Azure AD:');
    console.log(`   POST   /api/user-details            → Get user details`);
    console.log('');
});
