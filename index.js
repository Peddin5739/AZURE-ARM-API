require('dotenv').config({ override: true });
require('isomorphic-fetch');
const express = require('express');
const { ClientSecretCredential } = require('@azure/identity');
const { Client } = require('@microsoft/microsoft-graph-client');
const { TokenCredentialAuthenticationProvider } = require('@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials');
const { onboardApi, deleteApi, listApis } = require('./apicenter');
const apim = require('./apim');

const app = express();

// Middleware to parse JSON bodies
app.use(express.json());

const tenantId = process.env.TENANT_ID;
const clientId = process.env.CLIENT_ID;
const clientSecret = process.env.CLIENT_SECRET;

// Azure API Center (ARM) config
const subscriptionId = process.env.SUBSCRIPTION_ID;
const resourceGroup = process.env.RESOURCE_GROUP;
const apiCenterService = process.env.API_CENTER_SERVICE_NAME;

// Azure API Management (APIM) config
const apimName = process.env.APIM_SERVICE_NAME;

if (!tenantId || !clientId || !clientSecret) {
    console.error("Please configure TENANT_ID, CLIENT_ID, and CLIENT_SECRET in your .env file.");
    process.exit(1);
}

// Authenticate using Client Credentials flow
const credential = new ClientSecretCredential(tenantId, clientId, clientSecret);
const authProvider = new TokenCredentialAuthenticationProvider(credential, {
    scopes: ['https://graph.microsoft.com/.default']
});

const client = Client.initWithMiddleware({
    authProvider: authProvider
});

/**
 * POST /api/user-details
 * Expects a JSON body: { "email": "user@domain.com" }
 */
app.post('/api/user-details', async (req, res) => {
    const { email } = req.body;

    if (!email || typeof email !== 'string' || !email.trim()) {
        return res.status(400).json({ error: "Email is required in the request body as a string." });
    }

    try {
        const targetEmail = email.trim();
        console.log(`\n[API] Received request for user: ${targetEmail}`);

        // Handle external guests (e.g., #EXT#) by encoding the hashtag
        const encodedEmailForFilter = targetEmail.replace(/#/g, '%23');

        // Fetch user basic info
        const usersResponse = await client.api(`/users`)
            .filter(`userPrincipalName eq '${encodedEmailForFilter}'`)
            .select('id,displayName,userPrincipalName,jobTitle,department')
            .get();

        if (!usersResponse.value || usersResponse.value.length === 0) {
            console.log(`[API] User '${targetEmail}' not found.`);
            return res.status(404).json({ error: `User '${targetEmail}' not found in Azure AD.` });
        }

        const user = usersResponse.value[0];

        let groupsData = [];
        let appsData = [];

        // Fetch AD Groups
        try {
            const groupsResponse = await client.api(`/users/${user.id}/memberOf?$select=id,displayName,description`).get();
            groupsData = groupsResponse.value
                .filter(g => g['@odata.type'] === '#microsoft.graph.group')
                .map(group => ({
                    id: group.id,
                    name: group.displayName,
                    description: group.description || null
                }));
        } catch (err) {
            console.error(`[API] Error fetching groups:`, err.message);
            // Optionally, we could throw here, but usually it's better to return partial data and log the error
        }

        // Fetch App Role Assignments
        try {
            const appRolesResponse = await client.api(`/users/${user.id}/appRoleAssignments`).get();
            appsData = appRolesResponse.value.map(app => ({
                id: app.id,
                appName: app.resourceDisplayName,
                roleId: app.appRoleId
            }));
        } catch (err) {
            console.error(`[API] Error fetching apps:`, err.message);
        }

        console.log(`[API] Successfully retrieved data for ${targetEmail}.`);

        // Return structured JSON
        return res.json({
            user: {
                id: user.id,
                displayName: user.displayName,
                userPrincipalName: user.userPrincipalName,
                jobTitle: user.jobTitle || null,
                department: user.department || null
            },
            groups: groupsData,
            applications: appsData
        });

    } catch (error) {
        console.error("[API] Graph API Error:", error.message);
        return res.status(500).json({
            error: "Failed to fetch user details from Azure Graph API.",
            details: error.message
        });
    }
});

// ─── Helper: guard missing ARM config ────────────────────────────────────────
function checkArmConfig(res) {
    if (!subscriptionId || !resourceGroup || !apiCenterService) {
        res.status(500).json({
            error: 'Missing ARM config. Set SUBSCRIPTION_ID, RESOURCE_GROUP, API_CENTER_SERVICE_NAME in .env'
        });
        return false;
    }
    return true;
}

const armCtx = () => ({ credential, subscriptionId, resourceGroup, serviceName: apiCenterService });

// ─── POST /api/apicenter/onboard ─────────────────────────────────────────────
/**
 * Registers a new API in Azure API Center.
 *
 * Body (JSON):
 *   apiId         – unique identifier, alphanumeric + hyphens  (required)
 *   title         – human-readable name                        (required)
 *   description   – optional string
 *   kind          – rest | graphql | grpc | soap | webhook | websocket  (default: rest)
 *   lifecycleStage– design | development | testing | preview | production (default: development)
 */
app.post('/api/apicenter/onboard', async (req, res) => {
    if (!checkArmConfig(res)) return;

    const { apiId, title, description, kind, lifecycleStage } = req.body;

    if (!apiId || !title) {
        return res.status(400).json({ error: '"apiId" and "title" are required.' });
    }
    if (!/^[a-zA-Z0-9-]+$/.test(apiId)) {
        return res.status(400).json({ error: '"apiId" must be alphanumeric with hyphens only.' });
    }

    try {
        console.log(`\n[ACP] Onboarding API: ${apiId} (${title})`);
        const result = await onboardApi({ ...armCtx(), apiId, title, description, kind, lifecycleStage });
        console.log(`[ACP] ✅ Onboarded: ${apiId}`);
        return res.status(200).json({
            message: `API '${apiId}' onboarded successfully.`,
            resource: result
        });
    } catch (error) {
        console.error('[ACP] Onboard error:', error.message);
        return res.status(500).json({ error: 'Failed to onboard API.', details: error.message });
    }
});

// ─── DELETE /api/apicenter/:apiId ────────────────────────────────────────────
/**
 * Removes an API from Azure API Center.
 * Path param: apiId — the ID of the API to delete.
 */
app.delete('/api/apicenter/:apiId', async (req, res) => {
    if (!checkArmConfig(res)) return;

    const { apiId } = req.params;
    try {
        console.log(`\n[ACP] Deleting API: ${apiId}`);
        await deleteApi({ ...armCtx(), apiId });
        console.log(`[ACP] ✅ Deleted: ${apiId}`);
        return res.status(200).json({ message: `API '${apiId}' deleted successfully.`, apiId });
    } catch (error) {
        console.error('[ACP] Delete error:', error.message);
        const status = error.message.includes('not found') ? 404 : 500;
        return res.status(status).json({ error: error.message });
    }
});

// ─── GET /api/apicenter/list ─────────────────────────────────────────────────
/**
 * Returns all APIs registered in Azure API Center.
 */
app.get('/api/apicenter/list', async (req, res) => {
    if (!checkArmConfig(res)) return;

    try {
        console.log('\n[ACP] Listing all APIs...');
        const apis = await listApis(armCtx());
        return res.json({ count: apis.length, apis });
    } catch (error) {
        console.error('[ACP] List error:', error.message);
        return res.status(500).json({ error: 'Failed to list APIs.', details: error.message });
    }
});

// ─── Helper: guard missing APIM config ───────────────────────────────────────
function checkApimConfig(res) {
    if (!subscriptionId || !resourceGroup || !apimName) {
        res.status(500).json({
            error: 'Missing APIM config. Set SUBSCRIPTION_ID, RESOURCE_GROUP, APIM_SERVICE_NAME in .env'
        });
        return false;
    }
    return true;
}

const apimCtx = () => ({ credential, subscriptionId, resourceGroup, apimName });

// ─── GET /api/apim/list ───────────────────────────────────────────────────────
/**
 * Lists all APIs registered in Azure API Management.
 */
app.get('/api/apim/list', async (req, res) => {
    if (!checkApimConfig(res)) return;
    try {
        console.log('\n[APIM] Listing all APIs...');
        const apis = await apim.listApis(apimCtx());
        return res.json({ count: apis.length, apis });
    } catch (error) {
        console.error('[APIM] List error:', error.message);
        return res.status(500).json({ error: 'Failed to list APIM APIs.', details: error.message });
    }
});

// ─── POST /api/apim/onboard ───────────────────────────────────────────────────
/**
 * Creates (or updates) an API in Azure API Management.
 *
 * Body:
 *   apiId           – unique ID, alphanumeric + hyphens     (required)
 *   displayName     – human-readable name                   (required)
 *   path            – URL path suffix, e.g. "payments"      (required)
 *   backendUrl      – backend service URL                   (required)
 *   description     – optional
 *   protocols       – ["https"] | ["http","https"]           (default: ["https"])
 *   policyXml       – optional XML policy to apply immediately
 */
app.post('/api/apim/onboard', async (req, res) => {
    if (!checkApimConfig(res)) return;

    const { apiId, displayName, path, backendUrl, description, protocols, policyXml } = req.body;

    if (!apiId || !displayName || !path || !backendUrl) {
        return res.status(400).json({ error: '"apiId", "displayName", "path", and "backendUrl" are required.' });
    }
    if (!/^[a-zA-Z0-9-]+$/.test(apiId)) {
        return res.status(400).json({ error: '"apiId" must be alphanumeric with hyphens only.' });
    }

    try {
        console.log(`\n[APIM] Onboarding API: ${apiId} (${displayName})`);
        const result = await apim.onboardApi({ ...apimCtx(), apiId, displayName, path, backendUrl, description, protocols });
        console.log(`[APIM] ✅ Onboarded: ${apiId}`);

        let policyResult = null;
        if (policyXml) {
            console.log(`[APIM] Applying policy XML to: ${apiId}`);
            policyResult = await apim.setApiPolicy({ ...apimCtx(), apiId, policyXml });
            console.log(`[APIM] ✅ Policy set on: ${apiId}`);
        }

        return res.status(200).json({
            message: `API '${apiId}' onboarded successfully to APIM${policyXml ? ' with policy.' : '.'}`,
            resource: result,
            policy: policyResult
        });
    } catch (error) {
        console.error('[APIM] Onboard error:', error.message);

        // Try to safely extract the raw JSON error string if we appended it in apim.js
        let innerDetails = error.message;
        try {
            const jsonPart = error.message.substring(error.message.indexOf('{'));
            if (jsonPart) innerDetails = JSON.parse(jsonPart);
        } catch (_) { }

        return res.status(500).json({ error: 'Failed to onboard API to APIM.', details: innerDetails });
    }
});

// ─── PUT /api/apim/:apiId/policy ─────────────────────────────────────────────
/**
 * Sets or updates the XML policy on an existing APIM API.
 * Body: { "policyXml": "<policies>...</policies>" }
 */
app.put('/api/apim/:apiId/policy', async (req, res) => {
    if (!checkApimConfig(res)) return;

    const { apiId } = req.params;
    const { policyXml } = req.body;

    if (!policyXml) {
        return res.status(400).json({ error: '"policyXml" is required in the request body.' });
    }

    try {
        console.log(`\n[APIM] Setting policy on: ${apiId}`);
        const result = await apim.setApiPolicy({ ...apimCtx(), apiId, policyXml });
        console.log(`[APIM] ✅ Policy applied: ${apiId}`);
        return res.json({ message: `Policy applied to API '${apiId}'.`, policy: result });
    } catch (error) {
        console.error('[APIM] Policy error:', error.message);
        const status = error.message.includes('not found') ? 404 : 500;
        return res.status(status).json({ error: 'Failed to set policy.', details: error.message });
    }
});

// ─── DELETE /api/apim/:apiId ──────────────────────────────────────────────────
/**
 * Deletes an API from Azure API Management.
 * Path param: apiId — the API identifier.
 */
app.delete('/api/apim/:apiId', async (req, res) => {
    if (!checkApimConfig(res)) return;

    const { apiId } = req.params;
    try {
        console.log(`\n[APIM] Deleting API: ${apiId}`);
        await apim.deleteApi({ ...apimCtx(), apiId });
        console.log(`[APIM] ✅ Deleted: ${apiId}`);
        return res.json({ message: `API '${apiId}' deleted from APIM.`, apiId });
    } catch (error) {
        console.error('[APIM] Delete error:', error.message);
        const status = error.message.includes('not found') ? 404 : 500;
        return res.status(status).json({ error: error.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\n🚀 Server running on http://localhost:${PORT}`);
    console.log('\n📋 Azure API Center endpoints:');
    console.log(`   GET    /api/apicenter/list        → List all APIs`);
    console.log(`   POST   /api/apicenter/onboard     → Onboard API`);
    console.log(`   DELETE /api/apicenter/:apiId      → Delete API`);
    console.log('\n📋 Azure API Management endpoints:');
    console.log(`   GET    /api/apim/list             → List all APIs`);
    console.log(`   POST   /api/apim/onboard          → Onboard API (+ optional policy XML)`);
    console.log(`   PUT    /api/apim/:apiId/policy    → Set/update policy XML`);
    console.log(`   DELETE /api/apim/:apiId           → Delete API`);
    console.log('\n📋 Azure AD:');
    console.log(`   POST   /api/user-details          → Get user details`);
    console.log('');
});
