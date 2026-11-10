import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregate, breached, statsConsistent, trimmedPayload, utcTimestamp, validateEvent } from '../libs/common/domain';
import { configuration } from '../libs/common/config';

const valid = { eventId: 'one', deviceId: 'device', generatedAt: '2024-01-01T00:00:00Z', temperature: 20, humidity: 50, status: 'ok' };
test('validation accepts endpoints, UTC offsets, subseconds and every status', () => {
  for (const temperature of [-40, 85]) for (const humidity of [0, 100]) for (const status of ['ok', 'warning', 'fault', 'offline']) {
    assert.equal(validateEvent({ ...valid, temperature, humidity, status }, 300), null);
  }
  assert.ok(utcTimestamp('2024-02-29T12:00:00.123456+00:00'));
  assert.equal(validateEvent({ ...valid, eventId: 'x'.repeat(128) }, 300), null);
});
test('validation rejects missing, malformed, unknown enum, invalid dates and numeric coercion', () => {
  const cases = [
    [null, 'invalid_payload'], [[], 'invalid_payload'], [{}, 'missing_field'],
    [{ ...valid, eventId: '' }, 'invalid_event_id'], [{ ...valid, eventId: 'x'.repeat(129) }, 'invalid_event_id'],
    [{ ...valid, deviceId: '' }, 'invalid_device_id'], [{ ...valid, status: 'bad' }, 'invalid_status'], [{ ...valid, status: ['ok'] }, 'invalid_status'],
    [{ ...valid, temperature: '20' }, 'temperature_out_of_range'], [{ ...valid, temperature: NaN }, 'temperature_out_of_range'],
    [{ ...valid, temperature: 85.1 }, 'temperature_out_of_range'], [{ ...valid, temperature: -40.1 }, 'temperature_out_of_range'],
    [{ ...valid, humidity: -1 }, 'humidity_out_of_range'], [{ ...valid, humidity: 101 }, 'humidity_out_of_range'],
  ] as const;
  for (const [value, reason] of cases) assert.equal(validateEvent(value, 300), reason);
  for (const generatedAt of ['2024-02-30T00:00:00Z', '2023-02-29T00:00:00Z', '2024-01-01', '2024-01-01T00:00:00', '2024-01-01T00:00:00+01:00', '2024-01-01T24:00:00Z']) {
    assert.equal(validateEvent({ ...valid, generatedAt }, 300), 'invalid_timestamp');
  }
});
test('future skew accepts the exact boundary and rejects anything beyond', () => {
  const now = Date.parse(valid.generatedAt);
  assert.equal(validateEvent({ ...valid, generatedAt: new Date(now + 300000).toISOString() }, 300, now), null);
  assert.equal(validateEvent({ ...valid, generatedAt: new Date(now + 300001).toISOString() }, 300, now), 'future_timestamp');
  assert.equal(validateEvent({ ...valid, generatedAt: '2024-01-01T00:05:00.000001Z' }, 300, now), 'future_timestamp');
});
test('threshold boundaries are inclusive; null bounds disable that comparison', () => {
  for (const n of [-10, 60]) assert.equal(breached(n, { metric: 'temperature', min: -10, max: 60 }), false);
  for (const n of [-10.1, 60.1]) assert.equal(breached(n, { metric: 'temperature', min: -10, max: 60 }), true);
  assert.equal(breached(-1000, { metric: 'humidity', min: null, max: 90 }), false);
  assert.equal(breached(1000, { metric: 'humidity', min: null, max: null }), false);
});
test('aggregate math handles empty, decimal, negative and repeated values', () => {
  assert.deepEqual(aggregate([]), { min: null, max: null, avg: null });
  assert.deepEqual(aggregate([-10.5, 0, 10.5]), { min: -10.5, max: 10.5, avg: 0 });
  assert.deepEqual(aggregate([4, 4]), { min: 4, max: 4, avg: 4 });
});
test('stats detects violations of both accounting invariants', () => {
  const stats = { received: 12, accepted: 8, duplicates: 3, rejected: 1, pending: 2, processing: 1, processed: 4, failed: 1 };
  assert.ok(statsConsistent(stats));
  assert.ok(!statsConsistent({ ...stats, received: 13 }));
  assert.ok(!statsConsistent({ ...stats, processed: 5 }));
});
test('rejection JSON remains valid and bounded for escaping and multibyte payloads', () => {
  for (const payload of [{ huge: '😀"\\'.repeat(5000) }, { data: Array.from({ length: 10000 }, () => 0) }, { ok: true }, null]) {
    const json = trimmedPayload(payload);
    assert.doesNotThrow(() => JSON.parse(json));
    assert.ok(Buffer.byteLength(json) <= 1800);
  }
});
test('configuration validates required keys and numeric operational bounds', () => {
  const env = { DATABASE_URL: 'postgres://placeholder', INGEST_API_KEYS: 'one, two', ADMIN_API_KEY: 'admin' };
  assert.equal(configuration('ingest-api', env).port, 3000);
  assert.equal(configuration('processor', env).port, 3001);
  assert.deepEqual(configuration('ingest-api', env).ingestKeys, ['one', 'two']);
  assert.throws(() => configuration('ingest-api', { DATABASE_URL: 'postgres://placeholder' }));
  for (const PROCESSOR_BATCH_SIZE of ['0', '-1', 'nope', '1.1']) assert.throws(() => configuration('processor', { ...env, PROCESSOR_BATCH_SIZE }));
});
