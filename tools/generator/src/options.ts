import { parseArgs } from 'node:util';
import type { Options } from './model';

export const help = `Usage: npm start -- <seed|burst|sustained|dupes-ooo> [options]
  --base-url URL        API origin (default http://localhost:3000)
  --api-key KEY         Ingestion/read key (or INGEST_API_KEY)
  --admin-key KEY       Admin key for seed (or ADMIN_API_KEY)
  --seed STRING        Deterministic seed (default 1)
  --installations N    Default 2
  --devices N          Devices per installation (default 5)
  --count N            Valid initial events (default 1000)
  --concurrency N      Concurrent HTTP requests (default 20)
  --rate N             Sustained valid events/second (default 20)
  --duration N         Sustained seconds (default 120)
  --duplicates N       Retransmissions (default 50)
  --out-of-order N     Older unique events (default 50)
  --invalid-ratio N    Add round(valid events * ratio) invalid events, 0..1
  --batch-size N       Events per HTTP request, 1..500 (default 1)
  --out FILE           Summary JSON (dupes-ooo defaults to report.json)
  --dry-run            No network; output deterministic plan and summary
  --help`;
export function options(args: string[], env = process.env): Options {
  const names = ['base-url', 'api-key', 'admin-key', 'seed', 'installations', 'devices', 'count', 'concurrency', 'rate', 'duration', 'duplicates', 'out-of-order', 'invalid-ratio', 'batch-size', 'out'];
  const parsed = parseArgs({ args, allowPositionals: true, options: {
    ...Object.fromEntries(names.map((name) => [name, { type: 'string' as const }])),
    'dry-run': { type: 'boolean' }, help: { type: 'boolean' },
  } });
  const command = parsed.positionals[0];
  if (parsed.positionals.length !== 1 || !['seed', 'burst', 'sustained', 'dupes-ooo'].includes(command ?? '')) throw new Error('Choose seed, burst, sustained, or dupes-ooo');
  const values: Record<string, string | boolean | undefined> = parsed.values;
  const value = (name: string, fallback: string): string => String(values[name] ?? fallback);
  const number = (name: string, fallback: number, min = 1, max = 10000000, integer = true): number => {
    const n = Number(value(name, String(fallback)));
    if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) throw new Error(`Invalid --${name}`);
    return n;
  };
  const baseUrl = value('base-url', 'http://localhost:3000').replace(/\/$/, '');
  const url = new URL(baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid --base-url');
  const result: Options = {
    command: command as Options['command'], baseUrl, apiKey: value('api-key', env.INGEST_API_KEY ?? ''), adminKey: value('admin-key', env.ADMIN_API_KEY ?? ''), seed: value('seed', '1'),
    installations: number('installations', 2), devices: number('devices', 5), count: number('count', 1000),
    concurrency: number('concurrency', 20, 1, 1000), rate: number('rate', 20), duration: number('duration', 120),
    duplicates: number('duplicates', 50, 0), outOfOrder: number('out-of-order', 50, 0), invalidRatio: number('invalid-ratio', 0, 0, 1, false),
    batchSize: number('batch-size', 1, 1, 500), out: values.out as string | undefined, dryRun: values['dry-run'] === true,
  };
  if (!result.dryRun && !(result.command === 'seed' ? result.adminKey : result.apiKey)) throw new Error(result.command === 'seed' ? '--admin-key is required' : '--api-key is required');
  if (result.command === 'dupes-ooo' && !result.out) result.out = 'report.json';
  return result;
}
