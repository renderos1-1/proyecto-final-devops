import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile, spawn, ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { createIngestApp } from '../apps/ingest-api/app';
import { createProcessorApp } from '../apps/processor/app';
import { configuration } from '../libs/common/config';
import { Stats, statsConsistent } from '../libs/common/domain';
import { migrate } from '../migrate';

const execute = promisify(execFile);
const database = `events_test_${randomUUID().replaceAll('-', '')}`;
const adminKey = randomUUID();
const ingestKey = randomUUID();
let admin: Pool;
let api: Awaited<ReturnType<typeof createIngestApp>>;
let processor: Awaited<ReturnType<typeof createProcessorApp>>;
let second: Awaited<ReturnType<typeof createProcessorApp>>;
let base: string;
let processorBase: string;
let databaseUrl: string;
let outputDirectory: string;
const event = (eventId: string, extra: Record<string, unknown> = {}) => ({
  eventId, deviceId: 'device', generatedAt: '2024-01-01T00:00:00Z', temperature: 20, humidity: 50, status: 'ok', ...extra,
});
interface TestBody extends Stats {
  result: string; eventPk: string; reason: string; requestId: string; error: { code: string };
  results: { result: string }[]; events: { eventId: string }[]; nextCursor: string;
  temperature: { min: number | null; max: number | null; avg: number | null }; count: number;
}
async function request<T = TestBody>(path: string, method = 'GET', body?: unknown, key: string | null = ingestKey, headers: Record<string, string> = {}) {
  const response = await fetch(`${base}${path}`, { method, headers: { ...(key ? { 'X-API-Key': key } : {}), 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json() as T;
  return { status: response.status, data, headers: response.headers };
}
async function reset(): Promise<void> {
  await api.runtime.pool.query('TRUNCATE business_alerts,duplicate_receipts,rejections,events RESTART IDENTITY CASCADE');
}
async function drain(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const counts = await Promise.all([processor.worker.runBatch(), second.worker.runBatch()]);
    if (!counts.some(Boolean)) return;
  }
  assert.fail('Backlog did not drain');
}

before(async () => {
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL is required for real PostgreSQL tests');
  admin = new Pool({ connectionString: process.env.DATABASE_URL });
  await admin.query(`CREATE DATABASE "${database}"`);
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = `/${database}`;
  databaseUrl = url.toString();
  const config = configuration('ingest-api', { DATABASE_URL: databaseUrl, INGEST_API_KEYS: `${ingestKey},rotation-key`, ADMIN_API_KEY: adminKey, LOG_LEVEL: 'silent' });
  api = await createIngestApp(config);
  await migrate(api.runtime.pool);
  await api.app.listen(0, '127.0.0.1');
  base = await api.app.getUrl();
  const workerConfig = configuration('processor', { DATABASE_URL: databaseUrl, LOG_LEVEL: 'silent', PROCESSOR_BATCH_SIZE: '3', PROCESSOR_POLL_INTERVAL_MS: '10', PROCESSOR_LEASE_SECONDS: '1', PROCESSOR_ARTIFICIAL_DELAY_MS: '5' });
  processor = await createProcessorApp(workerConfig, false);
  second = await createProcessorApp(workerConfig, false);
  await processor.app.listen(0, '127.0.0.1');
  processorBase = await processor.app.getUrl();
  assert.equal((await request('/v1/installations', 'POST', { id: 'installation', name: 'Test' }, adminKey)).status, 201);
  assert.equal((await request('/v1/devices', 'POST', { id: 'device', installationId: 'installation', name: 'Test' }, adminKey)).status, 201);
  outputDirectory = await mkdtemp(join(tmpdir(), 'event-generator-'));
});
after(async () => {
  await Promise.all([processor?.app.close(), second?.app.close()]);
  await api?.app.close();
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await admin.end();
  }
  if (outputDirectory) await rm(outputDirectory, { recursive: true, force: true });
});

test('migrations are repeatable and serialize simultaneous runners', async () => {
  await Promise.all([migrate(api.runtime.pool), migrate(api.runtime.pool)]);
  assert.equal((await api.runtime.pool.query('SELECT * FROM thresholds')).rowCount, 2);
  assert.equal((await api.runtime.pool.query('SELECT * FROM schema_migrations')).rowCount, 1);
});
test('auth accepts both configured ingestion keys, rejects missing/invalid and restricts admin routes', async () => {
  for (const key of [null, 'invalid']) {
    const response = await request('/v1/stats', 'GET', undefined, key);
    assert.equal(response.status, 401);
    assert.equal(response.data.error.code, 'UNAUTHORIZED');
    assert.equal(response.data.requestId, response.headers.get('x-request-id'));
  }
  assert.equal((await request('/v1/stats', 'GET', undefined, 'rotation-key')).status, 200);
  for (const path of ['/v1/installations', '/V1/INSTALLATIONS', '/v1/thresholds', '/v1/devices/device']) {
    assert.equal((await request(path)).status, 403);
    assert.equal((await request(path, 'GET', undefined, adminKey)).status, 200);
  }
  assert.equal((await request('/V1/events', 'POST', event('no-auth'), null)).status, 401);
});
test('both apps expose public health, version and metrics; stale worker heartbeat fails liveness', async () => {
  for (const origin of [base, processorBase]) {
    for (const path of ['/healthz/live', '/healthz/ready', '/version', '/metrics']) {
      const response = await fetch(`${origin}${path}`);
      assert.equal(response.status, 200);
      if (path === '/metrics') assert.match(await response.text(), /nodejs_version_info/);
      if (path === '/version') assert.deepEqual(Object.keys(await response.json() as object).sort(), ['app', 'gitSha', 'version']);
    }
  }
  processor.runtime.loopHeartbeat = Date.now() - 61000;
  assert.equal((await fetch(`${processorBase}/healthz/live`)).status, 503);
  processor.runtime.loopHeartbeat = Date.now();
});
test('accepted is committed, duplicates are audited, rejections persist, batch is independent and ordered', async () => {
  await reset();
  const traceparent = '00-12345678901234567890123456789012-1234567890123456-01';
  const accepted = await request('/v1/events', 'POST', event('one'), ingestKey, { traceparent });
  assert.equal(accepted.status, 202);
  assert.equal(accepted.data.result, 'accepted');
  const stored = await api.runtime.pool.query('SELECT * FROM events WHERE pk=$1', [accepted.data.eventPk]);
  assert.equal(stored.rows[0].processing_status, 'pending');
  assert.equal(stored.rows[0].traceparent, traceparent);
  const duplicate = await request('/v1/events', 'POST', event('one', { temperature: 80 }));
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.data.eventPk, accepted.data.eventPk);
  const rejected = await request('/v1/events', 'POST', event('unknown', { deviceId: 'missing' }));
  assert.equal(rejected.status, 422);
  assert.equal(rejected.data.reason, 'unknown_device');
  const batch = await request('/v1/events/batch', 'POST', { events: [event('two'), event('one'), event('bad', { humidity: -1 }), null, event('three')] });
  assert.equal(batch.status, 200);
  assert.deepEqual(batch.data.results.map((r: { result: string }) => r.result), ['accepted', 'duplicate', 'rejected', 'rejected', 'accepted']);
  assert.equal((await request('/v1/events/batch', 'POST', { events: Array(501).fill(event('x')) })).status, 400);
  const stats = (await request('/v1/stats')).data as Stats;
  assert.deepEqual(stats, { received: 8, accepted: 3, duplicates: 2, rejected: 3, pending: 3, processing: 0, processed: 0, failed: 0 });
  assert.ok(statsConsistent(stats));
  await request('/v1/events', 'POST', { bad: '😀"\\'.repeat(5000) });
  assert.equal((await request('/v1/events', 'POST', { bad: '\u0000\uD800' })).status, 422);
  assert.ok(Number((await api.runtime.pool.query('SELECT max(octet_length(payload::text)) AS size FROM rejections')).rows[0].size) <= 4096);
});
test('simultaneous identical submissions create one accepted event and one receipt per retransmission', async () => {
  await reset();
  const results = await Promise.all(Array.from({ length: 20 }, () => request('/v1/events', 'POST', event('race'))));
  assert.equal(results.filter((r) => r.status === 202).length, 1);
  assert.equal(results.filter((r) => r.data.result === 'duplicate').length, 19);
  assert.equal((await api.runtime.pool.query('SELECT * FROM events')).rowCount, 1);
  assert.equal((await api.runtime.pool.query('SELECT * FROM duplicate_receipts')).rowCount, 19);
});
test('event queries sort by generated time then event id, paginate without loss and use [from,to)', async () => {
  await reset();
  const items = [event('late', { generatedAt: '2024-01-01T00:00:02Z', temperature: 80 }),
    event('b', { generatedAt: '2024-01-01T00:00:00.123456Z', temperature: 30 }),
    event('a', { generatedAt: '2024-01-01T00:00:00.123456Z', temperature: 10 }),
    event('start', { temperature: -10 })];
  for (const item of items) assert.equal((await request('/v1/events', 'POST', item)).status, 202);
  const query = new URLSearchParams({ from: '2024-01-01T00:00:00Z', to: '2024-01-01T00:00:02Z', limit: '2' });
  const first = (await request(`/v1/devices/device/events?${query}`)).data;
  assert.deepEqual(first.events.map((e: { eventId: string }) => e.eventId), ['start', 'a']);
  query.set('cursor', first.nextCursor);
  const secondPage = (await request(`/v1/devices/device/events?${query}`)).data;
  assert.deepEqual(secondPage.events.map((e: { eventId: string }) => e.eventId), ['b']);
  assert.equal(secondPage.nextCursor, null);
  const aggregates = (await request(`/v1/devices/device/aggregates?${query}`)).data;
  assert.deepEqual(aggregates.temperature, { min: -10, max: 30, avg: 10 });
  assert.equal(aggregates.count, 3);
  assert.equal((await request('/v1/devices/device/events?cursor=not-a-cursor')).status, 400);
  assert.equal((await request('/v1/devices/device/events?limit=501')).status, 400);
  assert.equal((await request('/v1/devices/device/aggregates?from=bad')).status, 400);
  assert.deepEqual((await request('/v1/devices/unknown/aggregates')).data.temperature, { min: null, max: null, avg: null });
  const microWindow = await request('/v1/devices/device/aggregates?from=2024-01-01T00:00:00.123455Z&to=2024-01-01T00:00:00.123457Z');
  assert.equal(microWindow.status, 200);
  assert.equal(microWindow.data.count, 2);
});
test('stats windows use receipt time and preserve both invariants', async () => {
  await reset();
  await request('/v1/events', 'POST', event('stats'));
  await request('/v1/events', 'POST', event('stats'));
  await request('/v1/events', 'POST', {});
  for (const table of ['events', 'duplicate_receipts', 'rejections']) await api.runtime.pool.query(`UPDATE ${table} SET received_at='2024-02-01T00:00:00Z'`);
  const inside = (await request('/v1/stats?from=2024-02-01T00:00:00Z&to=2024-02-02T00:00:00Z')).data;
  assert.ok(statsConsistent(inside));
  assert.equal(inside.received, 3);
  const outside = (await request('/v1/stats?to=2024-02-01T00:00:00Z')).data;
  assert.equal(outside.received, 0);
});
test('concurrent workers drain backlog and create each threshold alert exactly once', async () => {
  await reset();
  for (let i = 0; i < 24; i++) await request('/v1/events', 'POST', event(`work-${i}`, { temperature: 75, humidity: 95 }));
  assert.equal((await request('/v1/stats')).data.pending, 24);
  await drain();
  const stats = (await request('/v1/stats')).data;
  assert.equal(stats.processed, 24);
  assert.equal(stats.pending + stats.processing, 0);
  assert.ok(statsConsistent(stats));
  assert.equal((await api.runtime.pool.query('SELECT * FROM business_alerts')).rowCount, 48);
  assert.equal((await api.runtime.pool.query('SELECT * FROM events WHERE attempts != 0 OR processed_at IS NULL')).rowCount, 0);
  await drain();
  assert.equal((await api.runtime.pool.query('SELECT * FROM business_alerts')).rowCount, 48);
  await processor.worker.refreshBacklog(true);
  const metrics = await (await fetch(`${processorBase}/metrics`)).text();
  assert.match(metrics, /events_backlog\{status="pending"\} 0/);
  assert.match(metrics, /events_processed_total\{result="processed"\} [1-9]/);
});
test('expired processing leases are reclaimed while fresh leases are left alone', async () => {
  await reset();
  await request('/v1/events', 'POST', event('expired', { temperature: 75 }));
  await request('/v1/events', 'POST', event('fresh'));
  await api.runtime.pool.query("UPDATE events SET processing_status='processing',locked_at=now()-interval '2 minutes' WHERE event_id='expired'");
  await api.runtime.pool.query("UPDATE events SET processing_status='processing',locked_at=now() WHERE event_id='fresh'");
  await drain();
  const rows = (await api.runtime.pool.query('SELECT event_id,processing_status FROM events ORDER BY event_id')).rows;
  assert.deepEqual(rows, [{ event_id: 'expired', processing_status: 'processed' }, { event_id: 'fresh', processing_status: 'processing' }]);
});
test('installation thresholds override globals per metric, including null bounds', async () => {
  await reset();
  assert.equal((await request('/v1/thresholds', 'PUT', { installationId: 'installation', metric: 'temperature', min: null, max: null }, adminKey)).status, 200);
  await request('/v1/events', 'POST', event('override', { temperature: 80, humidity: 95 }));
  await drain();
  const alerts = (await request<{ metric: string }[]>('/v1/alerts?deviceId=device&from=2024-01-01T00:00:00Z&to=2024-01-02T00:00:00Z')).data;
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0]!.metric, 'humidity');
  await api.runtime.pool.query('DELETE FROM thresholds WHERE installation_id IS NOT NULL');
});
test('processing errors roll back alerts, retry and become failed after exactly five attempts', async () => {
  await reset();
  await api.runtime.pool.query(`CREATE FUNCTION fail_processing_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test failure'; END $$;
    CREATE TRIGGER fail_processing_test BEFORE INSERT ON business_alerts FOR EACH ROW EXECUTE FUNCTION fail_processing_test()`);
  try {
    await request('/v1/events', 'POST', event('failure', { temperature: 80 }));
    for (let attempt = 1; attempt <= 5; attempt++) {
      await processor.worker.runBatch();
      const row = (await api.runtime.pool.query('SELECT * FROM events')).rows[0];
      assert.equal(row.attempts, attempt);
      assert.equal(row.processing_status, attempt === 5 ? 'failed' : 'pending');
      assert.equal(row.last_error, 'P0001');
      assert.equal((await api.runtime.pool.query('SELECT * FROM business_alerts')).rowCount, 0);
    }
    assert.equal(await processor.worker.runBatch(), 0);
  } finally {
    await api.runtime.pool.query('DROP TRIGGER fail_processing_test ON business_alerts; DROP FUNCTION fail_processing_test()');
  }
});
test('graceful shutdown finishes the claimed batch and stops polling', async () => {
  await reset();
  for (let i = 0; i < 6; i++) await request('/v1/events', 'POST', event(`shutdown-${i}`));
  const graceful = await createProcessorApp({ ...processor.runtime.config, delayMs: 60 }, true);
  try {
    for (let i = 0; i < 100; i++) {
      const stats = (await request('/v1/stats')).data;
      if (stats.processing > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await graceful.worker.stop();
    const stats = (await request('/v1/stats')).data;
    assert.equal(stats.processed, 3);
    assert.equal(stats.pending, 3);
    assert.equal(stats.processing, 0);
  } finally { await graceful.app.close(); }
});
test('generator seeds idempotently, bursts, sustains, and verifies duplicates/older events including reruns', async () => {
  await reset();
  const run = async (command: string, args: string[] = []) => {
    const result = await execute(process.execPath, [resolve('node_modules/tsx/dist/cli.mjs'), resolve('../tools/generator/src/cli.ts'), command,
      '--base-url', base, '--api-key', ingestKey, '--admin-key', adminKey, '--installations', '1', '--devices', '2', ...args], { maxBuffer: 1024 * 1024 });
    return JSON.parse(result.stdout);
  };
  await run('seed');
  assert.equal((await run('seed')).summary.httpErrors, 0);
  const burst = await run('burst', ['--count', '20', '--concurrency', '4', '--batch-size', '3', '--invalid-ratio', '0.1']);
  assert.equal(burst.summary.accepted, 20);
  assert.equal(burst.summary.rejected, 2);
  assert.equal(burst.summary.sent, 22);
  const sustained = await run('sustained', ['--rate', '4', '--duration', '1']);
  assert.equal(sustained.summary.accepted, 4);
  assert.ok(sustained.summary.durationSeconds >= 1);
  const out = join(outputDirectory, 'report.json');
  for (let i = 0; i < 2; i++) {
    const dupes = await run('dupes-ooo', ['--count', '10', '--duplicates', '5', '--out-of-order', '5', '--batch-size', '4', '--out', out]);
    assert.equal(dupes.summary.accepted, i === 0 ? 15 : 0);
    assert.equal(dupes.summary.duplicate, i === 0 ? 5 : 20);
    assert.ok(Object.values(dupes.verification).every(Boolean));
    assert.deepEqual(JSON.parse(await readFile(out, 'utf8')), dupes);
  }
});

test('compiled applications export linked OTLP spans, structured logs, and flush on SIGTERM', { timeout: 30000 }, async () => {
  await reset();
  interface ExportedSpan { name: string; traceId: string; spanId: string; parentSpanId?: string; links?: { traceId: string; spanId: string }[] }
  const exported: ExportedSpan[] = [];
  const collector = createServer((req, res) => {
    if (req.url !== '/v1/traces') { req.resume(); res.writeHead(404).end(); return; }
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString()) as { resourceSpans: { scopeSpans: { spans: ExportedSpan[] }[] }[] };
      for (const resource of payload.resourceSpans) for (const scope of resource.scopeSpans) exported.push(...scope.spans);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
    });
  });
  await new Promise<void>((resolve) => collector.listen(0, '127.0.0.1', resolve));
  const collectorUrl = `http://127.0.0.1:${(collector.address() as AddressInfo).port}`;
  const children: ChildProcess[] = [];
  const logs: string[] = [];
  const start = async (name: 'ingest-api' | 'processor') => {
    const reservation = createServer();
    await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
    const port = (reservation.address() as AddressInfo).port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const child = spawn(process.execPath, [resolve(`dist/apps/${name}/main.js`)], { env: {
      ...process.env, DATABASE_URL: databaseUrl, INGEST_API_KEYS: ingestKey, ADMIN_API_KEY: adminKey,
      PORT: String(port), LOG_LEVEL: 'info', APP_ENV: 'dev', OTEL_EXPORTER_OTLP_ENDPOINT: collectorUrl,
      OTEL_BSP_SCHEDULE_DELAY: '50', OTEL_BSP_EXPORT_TIMEOUT: '3000', PROCESSOR_POLL_INTERVAL_MS: '25',
    }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    child.stdout!.on('data', (chunk: Buffer) => logs.push(chunk.toString()));
    child.stderr!.on('data', (chunk: Buffer) => logs.push(chunk.toString()));
    const origin = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) assert.fail(`${name} exited during startup`);
      try { if ((await fetch(`${origin}/healthz/ready`)).ok) return origin; } catch { /* Starting. */ }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.fail(`${name} did not become ready`);
  };
  const stop = async (child: ChildProcess) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('SIGTERM timed out')); }, 5000);
      child.once('exit', () => { clearTimeout(timeout); resolve(); });
      child.kill('SIGTERM');
    });
  };
  try {
    const origin = await start('ingest-api');
    const response = await fetch(`${origin}/v1/events`, { method: 'POST', headers: {
      'Content-Type': 'application/json', 'X-API-Key': ingestKey, traceparent: '00-12345678901234567890123456789012-1234567890123456-01',
    }, body: JSON.stringify(event('traced', { temperature: 80 })) });
    assert.equal(response.status, 202);
    const stored = (await api.runtime.pool.query<{ traceparent: string }>("SELECT traceparent FROM events WHERE event_id='traced'")).rows[0]!.traceparent;
    await start('processor');
    for (let i = 0; i < 100; i++) {
      if ((await request('/v1/stats')).data.processed === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.equal((await request('/v1/stats')).data.processed, 1);
    await Promise.all(children.map(stop));
    const processSpan = exported.find((span) => span.name === 'process_event');
    assert.ok(processSpan, 'process_event span was exported');
    assert.ok(exported.some((span) => span.name === 'process_batch' && span.spanId === processSpan.parentSpanId));
    assert.ok(processSpan.links?.some((link) => link.traceId === stored.split('-')[1] && link.spanId === stored.split('-')[2]));
    assert.ok(exported.some((span) => /pg\./.test(span.name)), 'pg auto-instrumentation exported spans');
    assert.ok(exported.some((span) => /POST/.test(span.name)), 'HTTP auto-instrumentation exported spans');
    const output = logs.join('');
    assert.ok(!output.includes(ingestKey) && !output.includes(adminKey) && !output.includes(databaseUrl));
    const receipt = output.split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line) as Record<string, unknown>; } catch { return {}; } })
      .find((log) => log.outcome === 'accepted');
    assert.ok(receipt?.timestamp && receipt.trace_id && receipt.span_id && receipt.requestId);
  } finally {
    await Promise.all(children.map(stop));
    await new Promise<void>((resolve) => collector.close(() => resolve()));
  }
});
