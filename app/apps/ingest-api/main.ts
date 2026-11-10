import { startTelemetry } from '../../libs/common/telemetry';
import { startupFailure } from '../../libs/common/logging';

startTelemetry('ingest-api');
// Load HTTP, Express and pg only after auto-instrumentation is registered.
void import('./app').then(async ({ createIngestApp }) => {
  const { app, runtime } = await createIngestApp();
  try { await app.listen(runtime.config.port, '0.0.0.0'); }
  catch (error) { await app.close(); throw error; }
  runtime.log.info({ port: runtime.config.port }, 'Ingest API listening');
}).catch(() => startupFailure('ingest-api'));
