/**
 * apicenter.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Helpers to manage APIs in Azure API Center (ACP) via the ARM REST API.
 *
 * ARM base URL pattern for an API resource:
 *   https://management.azure.com
 *     /subscriptions/{subId}
 *     /resourceGroups/{rg}
 *     /providers/Microsoft.ApiCenter/services/{serviceName}
 *     /workspaces/default/apis/{apiId}
 *     ?api-version=2024-03-01
 * ─────────────────────────────────────────────────────────────────────────────
 */

const ARM_BASE = 'https://management.azure.com';
const ARM_API_VERSION = '2024-03-01';

/**
 * Obtains a Bearer token scoped to Azure Resource Manager.
 * The same ClientSecretCredential you already use for Graph API works here too —
 * just with a different scope.
 *
 * @param {import('@azure/identity').ClientSecretCredential} credential
 * @returns {Promise<string>} raw Bearer token
 */
async function getArmToken(credential) {
    const tokenResponse = await credential.getToken('https://management.azure.com/.default');
    return tokenResponse.token;
}

/**
 * Builds the full ARM URL for a single API resource.
 */
function apiUrl({ subscriptionId, resourceGroup, serviceName, apiId }) {
    return (
        `${ARM_BASE}/subscriptions/${subscriptionId}` +
        `/resourceGroups/${resourceGroup}` +
        `/providers/Microsoft.ApiCenter/services/${serviceName}` +
        `/workspaces/default/apis/${apiId}` +
        `?api-version=${ARM_API_VERSION}`
    );
}

/**
 * Builds the ARM URL for listing all APIs in a service.
 */
function listUrl({ subscriptionId, resourceGroup, serviceName }) {
    return (
        `${ARM_BASE}/subscriptions/${subscriptionId}` +
        `/resourceGroups/${resourceGroup}` +
        `/providers/Microsoft.ApiCenter/services/${serviceName}` +
        `/workspaces/default/apis` +
        `?api-version=${ARM_API_VERSION}`
    );
}

// ─── Onboard (register) a new API ────────────────────────────────────────────
/**
 * Creates or updates an API entry in Azure API Center.
 *
 * @param {object} params
 * @param {import('@azure/identity').ClientSecretCredential} params.credential
 * @param {string} params.subscriptionId
 * @param {string} params.resourceGroup
 * @param {string} params.serviceName          API Center service name (e.g. "ARM-ACP-POC")
 * @param {string} params.apiId                Unique ID — alphanumeric + hyphens only
 * @param {string} params.title                Human-readable display name
 * @param {string} [params.description]        Optional description
 * @param {string} [params.kind]               "rest" | "graphql" | "grpc" | "soap" | "webhook" | "websocket"
 * @param {string} [params.lifecycleStage]     "design" | "development" | "testing" | "preview" | "production"
 * @returns {Promise<object>}                  ARM response body with the created resource
 */
async function onboardApi({
    credential, subscriptionId, resourceGroup, serviceName,
    apiId, title, description = '', kind = 'rest', lifecycleStage = 'development'
}) {
    const token = await getArmToken(credential);
    const url = apiUrl({ subscriptionId, resourceGroup, serviceName, apiId });

    const body = {
        properties: {
            title,
            description,
            kind,
            lifecycleStage,
            externalDocumentation: [],
            contacts: []
        }
    };

    const response = await fetch(url, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });

    const data = await response.json();
    if (!response.ok) {
        throw new Error(`ARM onboard failed [${response.status}]: ${data?.error?.message || JSON.stringify(data)}`);
    }
    return data;
}

// ─── Delete an API ────────────────────────────────────────────────────────────
/**
 * Removes an API from Azure API Center.
 *
 * @param {object} params
 * @param {import('@azure/identity').ClientSecretCredential} params.credential
 * @param {string} params.subscriptionId
 * @param {string} params.resourceGroup
 * @param {string} params.serviceName
 * @param {string} params.apiId   ID of the API to delete
 * @returns {Promise<void>}
 */
async function deleteApi({ credential, subscriptionId, resourceGroup, serviceName, apiId }) {
    const token = await getArmToken(credential);
    const url = apiUrl({ subscriptionId, resourceGroup, serviceName, apiId });
    const response = await fetch(url, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
    });

    if (response.status === 204 || response.status === 200) return; // success
    if (response.status === 404) throw new Error(`API '${apiId}' not found in Azure API Center.`);

    let errBody = {};
    try { errBody = await response.json(); } catch (_) { }
    throw new Error(`ARM delete failed [${response.status}]: ${errBody?.error?.message || response.statusText}`);
}

// ─── List all APIs ────────────────────────────────────────────────────────────
/**
 * Returns all API entries registered in Azure API Center.
 *
 * @param {object} params
 * @param {import('@azure/identity').ClientSecretCredential} params.credential
 * @param {string} params.subscriptionId
 * @param {string} params.resourceGroup
 * @param {string} params.serviceName
 * @returns {Promise<Array>}  Array of simplified API objects
 */
async function listApis({ credential, subscriptionId, resourceGroup, serviceName }) {
    const token = await getArmToken(credential);
    const url = listUrl({ subscriptionId, resourceGroup, serviceName });
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await response.json();

    if (!response.ok) {
        throw new Error(`ARM list failed [${response.status}]: ${data?.error?.message || JSON.stringify(data)}`);
    }

    return (data.value || []).map(api => ({
        id: api.name,
        title: api.properties?.title,
        kind: api.properties?.kind,
        lifecycleStage: api.properties?.lifecycleStage,
        description: api.properties?.description || null
    }));
}

module.exports = { onboardApi, deleteApi, listApis };
