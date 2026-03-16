/**
 * src/telemetry.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OpenTelemetry initialization — must be imported BEFORE any other module.
 * Exports traces to the console so every ARM call is visible in terminal logs.
 */

import { NodeSDK } from '@opentelemetry/sdk-node';
import { ConsoleSpanExporter } from '@opentelemetry/sdk-trace-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

const sdk = new NodeSDK({
    resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: 'azure-arm-api',
        [ATTR_SERVICE_VERSION]: '2.0.0',
    }),
    traceExporter: new ConsoleSpanExporter(),
    instrumentations: [getNodeAutoInstrumentations()],
});

sdk.start();
console.log('🔭 OpenTelemetry tracing enabled (console exporter)');

process.on('SIGTERM', () => {
    sdk.shutdown()
        .then(() => console.log('Tracing terminated'))
        .catch((error) => console.log('Error terminating tracing', error))
        .finally(() => process.exit(0));
});
