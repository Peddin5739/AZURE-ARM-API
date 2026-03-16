/**
 * src/types.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Shared TypeScript interfaces for the APIM ARM onboarding service.
 */

import type { TokenCredential } from '@azure/identity';

// ─── ARM Context ──────────────────────────────────────────────────────────────

export interface ApimContext {
    credential: TokenCredential;
    subscriptionId: string;
    resourceGroup: string;
    apimName: string;
}

export interface ApiCenterContext {
    credential: TokenCredential;
    subscriptionId: string;
    resourceGroup: string;
    serviceName: string;
}

// ─── Individual Operation Params ──────────────────────────────────────────────

export interface NamedValueParams {
    /** Unique ID (alphanumeric + hyphens) */
    namedValueId: string;
    /** Display name shown in APIM Portal */
    displayName: string;
    /** The value to store */
    value: string;
    /** Whether to treat as a secret (masked in portal) */
    isSecret?: boolean;
    /** Optional tags */
    tags?: string[];
}

export interface BackendParams {
    /** Unique backend ID */
    backendId: string;
    /** Human-readable title */
    title?: string;
    /** Backend service URL */
    url: string;
    /** Protocol: http | https */
    protocol?: 'http' | 'https';
    description?: string;
}

export interface ApiParams {
    /** Unique API ID */
    apiId: string;
    displayName: string;
    /** URL path suffix, e.g. "payments" */
    path: string;
    /** Backend service URL */
    serviceUrl: string;
    description?: string;
    protocols?: ('http' | 'https')[];
    subscriptionRequired?: boolean;
    /**
     * Raw OpenAPI/Swagger specification — YAML or JSON.
     * If provided, the API will be imported from swagger instead of being created blank.
     */
    swagger?: string | Record<string, unknown>;
    /** API-level policy XML */
    apiPolicy?: string;
}

export interface ProductParams {
    productId: string;
    displayName: string;
    description?: string;
    subscriptionRequired?: boolean;
    /** Product-level policy XML */
    policy?: string;
    state?: 'published' | 'notPublished';
}

export interface SubscriptionParams {
    /** Unique subscription ID */
    subscriptionId: string;
    displayName: string;
    /** Scope — defaults to /apis/{apiId} if not provided */
    scope?: string;
}

// ─── Full Onboard Request ─────────────────────────────────────────────────────

export interface OnboardFullRequest {
    /** Unique API ID (required) */
    apiId: string;
    displayName: string;
    /** URL path suffix (required) */
    path: string;
    /** Backend service URL (required) */
    backendUrl: string;
    description?: string;
    protocols?: ('http' | 'https')[];
    subscriptionRequired?: boolean;

    /** Named values to create/update before the API */
    namedValues?: NamedValueInput[];

    /**
     * OpenAPI/Swagger specification — YAML string or JSON string.
     * Auto-corrected before sending to ARM.
     */
    swagger?: string | Record<string, unknown>;

    /**
     * API-level APIM policy XML.
     * Auto-corrected before sending to ARM.
     */
    apiPolicy?: string;

    /** Product to create/associate */
    product?: ProductInput;

    /** Default subscription to create */
    subscription?: SubscriptionInput;
}

export interface NamedValueInput {
    name: string;
    value: string;
    isSecret?: boolean;
    tags?: string[];
}

export interface ProductInput {
    productId: string;
    displayName: string;
    description?: string;
    subscriptionRequired?: boolean;
    state?: 'published' | 'notPublished';
    /** Product-level policy XML — auto-corrected before sending */
    policy?: string;
}

export interface SubscriptionInput {
    subscriptionId: string;
    displayName: string;
}

// ─── Onboard Response ─────────────────────────────────────────────────────────

export interface StepResult<T = unknown> {
    success: boolean;
    skipped?: boolean;
    data?: T;
    error?: string;
    corrections?: string[];
}

export interface OnboardFullResult {
    success: boolean;
    /** True when a step failed and all completed steps were rolled back */
    rolledBack?: boolean;
    apiId: string;
    steps: {
        namedValues: StepResult[];
        backend: StepResult;
        api: StepResult;
        apiPolicy: StepResult;
        product: StepResult;
        productPolicy: StepResult;
        association: StepResult;
        subscription: StepResult;
    };
}

// ─── Validator Results ────────────────────────────────────────────────────────

export interface SwaggerFixResult {
    /** The corrected/reformatted spec string */
    fixed: string;
    /** Original format detected */
    format: 'yaml' | 'json';
    /** Human-readable list of corrections applied */
    corrections: string[];
}

export interface PolicyFixResult {
    /** The corrected XML string */
    fixed: string;
    /** Human-readable list of corrections applied */
    corrections: string[];
}
