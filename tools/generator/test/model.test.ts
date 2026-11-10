import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregate, equalAggregates, makePlan, percentile } from '../src/model';
import { options } from '../src/options';
import { run } from '../src/runner';

test('same seed yields identical complete payloads; different seeds change them', () => {
  const config = options(['burst', '--dry-run', '--seed', '42']);
  assert.deepEqual(makePlan(config), makePlan(config));
  assert.notDeepEqual(makePlan(config), makePlan({ ...config, seed: '43' }));
  const plan = makePlan(config);
  assert.equal(plan.initial.length, 1000);
  assert.equal(new Set(plan.initial.map((e) => e.eventId)).size, 1000);
});
test('sustained count and duplicate/out-of-order scenarios are deterministic', () => {
  assert.equal(makePlan(options(['sustained', '--dry-run'])).initial.length, 2400);
  const plan = makePlan(options(['dupes-ooo', '--dry-run', '--count', '100', '--invalid-ratio', '0.2']));
  assert.equal(plan.duplicates.length, 50);
  assert.equal(plan.older.length, 50);
  assert.equal(plan.invalid.length, 30);
  assert.deepEqual(plan.duplicates[0], plan.initial[0]);
  assert.ok(plan.older.every((e) => Date.parse(e.generatedAt) < Date.parse(plan.initial[0]!.generatedAt)));
  assert.ok(plan.invalid.every((e) => e.eventId.includes('invalid') && e.temperature > 85));
  assert.equal(aggregate([...plan.initial, ...plan.duplicates, ...plan.older]).count, 150);
});
test('aggregate verification catches mismatches and tolerates float rounding', () => {
  const plan = makePlan(options(['burst', '--dry-run', '--count', '10']));
  const expected = aggregate(plan.initial);
  assert.ok(equalAggregates(expected, expected));
  assert.ok(!equalAggregates(expected, { ...expected, count: 11 }));
  assert.ok(!equalAggregates(expected, null));
  assert.ok(equalAggregates(expected, { ...expected, temperature: { ...expected.temperature, avg: expected.temperature.avg! + 1e-10 } }));
  assert.equal(percentile([5, 2, 1, 4, 3], 0.5), 3);
  assert.equal(percentile([], 0.99), 0);
});
test('dry-run makes no network requests and is fully reproducible', async () => {
  const config = options(['burst', '--dry-run', '--count', '4', '--base-url', 'http://127.0.0.1:1']);
  assert.deepEqual(await run(config), await run(config));
  const result = await run(config);
  assert.equal(result.report.summary.sent, 4);
  assert.equal(result.report.summary.accepted, 0);
  assert.ok(result.ok);
});
test('CLI rejects invalid flags, bounds and missing credentials', () => {
  for (const args of [['burst'], ['bad', '--dry-run'], ['burst', '--dry-run', '--batch-size', '501'], ['burst', '--dry-run', '--invalid-ratio', '1.1'], ['burst', '--dry-run', '--concurrency', '0']]) {
    assert.throws(() => options(args, {}));
  }
});

test('seed dry-run describes administrative requests', async () => {
  const result = await run(options(['seed', '--dry-run', '--installations', '1', '--devices', '2']));
  assert.equal(result.report.summary.sent, 3);
  assert.ok(Array.isArray(result.report.plan));
  assert.deepEqual(result.report.plan.map((operation) => operation.path), ['/v1/installations', '/v1/devices', '/v1/devices']);
});

test('dupes-ooo reports verification mismatch as failure and persists the expectation', async () => {
  const { createServer } = await import('node:http');
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const server = createServer((req, res) => {
    req.resume();
    res.setHeader('Content-Type', 'application/json');
    if (req.url?.includes('/aggregates')) res.end(JSON.stringify({ count: -1 }));
    else if (req.method === 'GET') res.end(JSON.stringify({ events: [], nextCursor: null }));
    else res.end(JSON.stringify({ result: 'accepted' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const directory = await mkdtemp(join(tmpdir(), 'generator-test-'));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const out = join(directory, 'report.json');
    const result = await run(options(['dupes-ooo', '--api-key', 'test-placeholder', '--base-url', `http://127.0.0.1:${address.port}`, '--installations', '1', '--devices', '1', '--count', '2', '--duplicates', '1', '--out-of-order', '1', '--out', out]));
    assert.equal(result.ok, false);
    assert.equal(result.report.expected['generator-device-1-1']!.count, 3);
    assert.equal(result.report.verification['generator-device-1-1'], false);
    assert.deepEqual(JSON.parse(await readFile(out, 'utf8')), result.report);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
