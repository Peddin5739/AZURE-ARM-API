/**
 * apim.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Helpers to manage APIs in Azure API Management (APIM) via the ARM REST API.
 *
 * ARM base URL pattern:
 *   https://management.azure.com
 *     /subscriptions/{subId}
 *     /resourceGroups/{rg}
 *     /providers/Microsoft.ApiManagement/service/{apimName}
 *     /apis/{apiId}
 *     ?api-version=2022-08-01
 * ─────────────────────────────────────────────────────────────────────────────
 */

const ARM_BASE = 'https://management.azure.com';
const APIM_API_VER = '2022-08-01';

/**
 * Get ARM Bearer token (same credential works for both ACP and APIM).
 */
async function getArmToken(credential) {
    const t = await credential.getToken('https://management.azure.com/.default');
    return t.token;
}

/**
 * Safely parse an ARM response — uses JSON if the Content-Type is JSON,
 * otherwise falls back to text (APIM policy endpoints return XML).
 */
async function safeParseResponse(response) {
    const ct = response.headers.get('content-type') || '';
    if (ct.includes('json')) return response.json();
    return response.text();
}

/**
 * Build the full ARM URL for a single APIM API resource.
 */
function apiUrl({ subscriptionId, resourceGroup, apimName, apiId }) {
    return (
        `${ARM_BASE}/subscriptions/${subscriptionId}` +
        `/resourceGroups/${resourceGroup}` +
        `/providers/Microsoft.ApiManagement/service/${apimName}` +
        `/apis/${apiId}?api-version=${APIM_API_VER}`
    );
}

/**
 * Build the ARM URL to list all APIs in an APIM service.
 */
function listUrl({ subscriptionId, resourceGroup, apimName }) {
    return (
        `${ARM_BASE}/subscriptions/${subscriptionId}` +
        `/resourceGroups/${resourceGroup}` +
        `/providers/Microsoft.ApiManagement/service/${apimName}` +
        `/apis?api-version=${APIM_API_VER}`
    );
}

/**
 * Build the ARM URL for an API's policy resource.
 */
function policyUrl({ subscriptionId, resourceGroup, apimName, apiId }) {
    return (
        `${ARM_BASE}/subscriptions/${subscriptionId}` +
        `/resourceGroups/${resourceGroup}` +
        `/providers/Microsoft.ApiManagement/service/${apimName}` +
        `/apis/${apiId}/policies/policy?api-version=${APIM_API_VER}`
    );
}

// ─── Onboard (create/update) an API in APIM ──────────────────────────────────
/**
 * Creates or updates an API in Azure API Management.
 *
 * @param {object} params
 * @param {import('@azure/identity').ClientSecretCredential} params.credential
 * @param {string} params.subscriptionId
 * @param {string} params.resourceGroup
 * @param {string} params.apimName            APIM service name (e.g. "ARMACPDEMO1")
 * @param {string} params.apiId               Unique API ID — alphanumeric + hyphens
 * @param {string} params.displayName         Human-readable API name
 * @param {string} params.path                URL path suffix (e.g. "payments")
 * @param {string} params.backendUrl          Backend service URL (e.g. "https://api.example.com")
 * @param {string} [params.description]       Optional description
 * @param {string[]} [params.protocols]       ["https"] | ["http","https"]
 * @param {string} [params.apiType]           "http" | "soap" | "graphql" (default: "http")
 * @param {string} [params.subscriptionRequired] true | false (default: true)
 * @returns {Promise<object>} ARM response body
 */
async function onboardApi({
    credential, subscriptionId, resourceGroup, apimName,
    apiId, displayName, path, backendUrl,
    description = '', protocols = ['https'], apiType = 'http', subscriptionRequired = true
}) {
    const token = await getArmToken(credential);
    const url = apiUrl({ subscriptionId, resourceGroup, apimName, apiId });

    const body = {
        properties: {
            displayName,
            description,
            path,
            protocols,
            subscriptionRequired,
            serviceUrl: backendUrl
        }
    };

    const response = await fetch(url, {
        method: 'PUT',
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        },
        body: JSON.stringify(body)
    });

    const data = await safeParseResponse(response);
    if (!response.ok) {
        console.error('[APIM] ARM Error Response:', JSON.stringify(data, null, 2));
        const msg = (typeof data === 'object') ? (data?.error?.message || JSON.stringify(data)) : data;
        throw new Error(`APIM onboard failed [${response.status}]: ${msg}`);
    }
    return data;
}

// ─── Set / Update Policy XML on an API ───────────────────────────────────────
/**
 * Applies an XML policy document to an APIM API.
 *
 * @param {object} params
 * @param {import('@azure/identity').ClientSecretCredential} params.credential
 * @param {string} params.subscriptionId
 * @param {string} params.resourceGroup
 * @param {string} params.apimName
 * @param {string} params.apiId
 * @param {string} params.policyXml   Raw XML policy string
 * @returns {Promise<object>} ARM response body
 */
async function setApiPolicy({ credential, subscriptionId, resourceGroup, apimName, apiId, policyXml }) {
    const token = await getArmToken(credential);
    const url = policyUrl({ subscriptionId, resourceGroup, apimName, apiId });

    const body = {
        properties: {
            format: 'xml',
            value: policyXml
        }
    };

    const response = await fetch(url, {
        method: 'PUT',
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        },
        body: JSON.stringify(body)
    });

    const data = await safeParseResponse(response);
    if (!response.ok) {
        const msg = (typeof data === 'object') ? (data?.error?.message || JSON.stringify(data)) : data;
        throw new Error(`APIM set policy failed [${response.status}]: ${msg}`);
    }
    return data;
}

// ─── Delete an API from APIM ─────────────────────────────────────────────────
/**
 * Removes an API from Azure API Management.
 *
 * @param {object} params
 * @param {import('@azure/identity').ClientSecretCredential} params.credential
 * @param {string} params.subscriptionId
 * @param {string} params.resourceGroup
 * @param {string} params.apimName
 * @param {string} params.apiId
 * @returns {Promise<void>}
 */
async function deleteApi({ credential, subscriptionId, resourceGroup, apimName, apiId }) {
    const token = await getArmToken(credential);

    // APIM delete requires an ETag — use * to force delete without checking version
    const url = apiUrl({ subscriptionId, resourceGroup, apimName, apiId });
    const response = await fetch(url, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}`, 'If-Match': '*' }
    });

    if (response.status === 204 || response.status === 200) return; // success
    if (response.status === 404) throw new Error(`API '${apiId}' not found in APIM '${apimName}'.`);

    let errBody = {};
    try { errBody = await response.json(); } catch (_) { }
    throw new Error(`APIM delete failed [${response.status}]: ${errBody?.error?.message || response.statusText}`);
}

// ─── List all APIs in APIM ───────────────────────────────────────────────────
/**
 * Returns all APIs from Azure API Management.
 *
 * @param {object} params
 * @param {import('@azure/identity').ClientSecretCredential} params.credential
 * @param {string} params.subscriptionId
 * @param {string} params.resourceGroup
 * @param {string} params.apimName
 * @returns {Promise<Array>}
 */
async function listApis({ credential, subscriptionId, resourceGroup, apimName }) {
    const token = await getArmToken(credential);
    const url = listUrl({ subscriptionId, resourceGroup, apimName });
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, 'Accept': 'application/json' } });
    const data = await safeParseResponse(response);

    if (!response.ok) {
        const msg = (typeof data === 'object') ? (data?.error?.message || JSON.stringify(data)) : data;
        throw new Error(`APIM list failed [${response.status}]: ${msg}`);
    }

    return (data.value || []).map(api => ({
        id: api.name,
        displayName: api.properties?.displayName,
        path: api.properties?.path,
        protocols: api.properties?.protocols,
        serviceUrl: api.properties?.serviceUrl || null,
        description: api.properties?.description || null,
        isCurrent: api.properties?.isCurrent
    }));
}

module.exports = { onboardApi, deleteApi, listApis, setApiPolicy };
