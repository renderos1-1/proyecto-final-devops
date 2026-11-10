import 'dotenv/config';
import { context, trace } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import type { AppName } from './config';

let activeSdk: NodeSDK | undefined;
export function startTelemetry(app: AppName): NodeSDK | undefined {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) return undefined;
  const sdk = new NodeSDK({
    logRecordProcessors: [],
    resource: resourceFromAttributes({
      'service.name': process.env.OTEL_SERVICE_NAME ?? app,
      'service.version': process.env.APP_VERSION ?? '0.0.0',
      'deployment.environment.name': process.env.APP_ENV ?? 'dev',
      'app.env': process.env.APP_ENV ?? 'dev',
    }),
    traceExporter: new OTLPTraceExporter({ url: `${endpoint.replace(/\/$/, '')}/v1/traces` }),
    instrumentations: [new HttpInstrumentation(), new ExpressInstrumentation(),
      new PgInstrumentation({ enhancedDatabaseReporting: false })],
  });
  sdk.start();
  activeSdk = sdk;
  return sdk;
}
export async function stopTelemetry(): Promise<void> {
  await activeSdk?.shutdown();
  activeSdk = undefined;
}
export function traceFields(): Record<string, string> {
  const span = trace.getSpan(context.active())?.spanContext();
  return span ? { trace_id: span.traceId, span_id: span.spanId } : {};
}
