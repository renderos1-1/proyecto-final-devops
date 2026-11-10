import pino from 'pino';
import type { AppName, Config } from './config';
import { traceFields } from './telemetry';

export function createLogger(config: Pick<Config, 'app' | 'env' | 'logLevel'>) {
  return pino({ level: config.logLevel, base: { component: config.app, env: config.env },
    timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
    formatters: { level: (label) => ({ level: label }) }, mixin: traceFields,
    redact: ['apiKey', 'databaseUrl', 'DATABASE_URL', 'INGEST_API_KEYS', 'ADMIN_API_KEY', 'req.headers.x-api-key'],
  });
}
export function startupFailure(app: AppName): void {
  createLogger({ app, env: process.env.APP_ENV === 'prod' ? 'prod' : 'dev', logLevel: 'fatal' })
    .fatal({ outcome: 'startup_failed' }, 'Startup failed; check configuration and connectivity');
  process.exitCode = 1;
}
