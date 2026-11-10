import { startTelemetry } from '../../libs/common/telemetry';
import { startupFailure } from '../../libs/common/logging';

startTelemetry('processor');
void import('./app').then(async ({ createProcessorApp }) => {
  const { app, runtime } = await createProcessorApp();
  try { await app.listen(runtime.config.port, '0.0.0.0'); }
  catch (error) { await app.close(); throw error; }
  runtime.log.info({ port: runtime.config.port }, 'Processor listening');
}).catch(() => startupFailure('processor'));
