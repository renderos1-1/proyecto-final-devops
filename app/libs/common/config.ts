export type AppName = 'ingest-api' | 'processor';
export interface Config {
  app: AppName; databaseUrl: string; port: number; logLevel: string; env: 'dev' | 'prod';
  gitSha: string; version: string; ingestKeys: string[]; adminKey: string;
  futureSkew: number; batchSize: number; pollMs: number; leaseSeconds: number; delayMs: number;
}

export function configuration(app: AppName, env = process.env): Config {
  const integer = (name: string, fallback: number, min = 0, max = 2147483647): number => {
    const raw = env[name] ?? String(fallback);
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) {
      throw new Error(`Invalid ${name}`);
    }
    return value;
  };
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  if (!['dev', 'prod'].includes(env.APP_ENV ?? 'dev')) throw new Error('Invalid APP_ENV');
  if (!['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'].includes(env.LOG_LEVEL ?? 'info')) {
    throw new Error('Invalid LOG_LEVEL');
  }
  const ingestKeys = (env.INGEST_API_KEYS ?? '').split(',').map((key) => key.trim()).filter(Boolean);
  const adminKey = env.ADMIN_API_KEY?.trim() ?? '';
  if (app === 'ingest-api' && (!ingestKeys.length || !adminKey)) throw new Error('INGEST_API_KEYS and ADMIN_API_KEY are required');
  return {
    app, databaseUrl: env.DATABASE_URL, port: integer('PORT', app === 'ingest-api' ? 3000 : 3001, 1, 65535),
    logLevel: env.LOG_LEVEL ?? 'info', env: (env.APP_ENV ?? 'dev') as 'dev' | 'prod',
    gitSha: env.GIT_SHA ?? 'unknown', version: env.APP_VERSION ?? '0.0.0', ingestKeys, adminKey,
    futureSkew: integer('MAX_FUTURE_SKEW_SECONDS', 300), batchSize: integer('PROCESSOR_BATCH_SIZE', 100, 1, 10000),
    pollMs: integer('PROCESSOR_POLL_INTERVAL_MS', 500, 1), leaseSeconds: integer('PROCESSOR_LEASE_SECONDS', 60, 1),
    delayMs: integer('PROCESSOR_ARTIFICIAL_DELAY_MS', 0),
  };
}
