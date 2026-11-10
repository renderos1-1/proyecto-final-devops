import { context, propagation, trace } from '@opentelemetry/api';
import type { PoolClient } from 'pg';
import { Runtime } from '../../libs/common/runtime';
import { ApiError } from '../../libs/common/http';
import { EventInput, object, RejectionReason, textId, timestampMicros, trimmedPayload, utcTimestamp, validateEvent } from '../../libs/common/domain';

export interface Receipt { result: 'accepted' | 'duplicate' | 'rejected'; eventPk?: string; deviceId?: string; eventId?: string; reason?: RejectionReason }
export function windowQuery(query: Record<string, unknown>): { from: string | null; to: string | null } {
  const from = query.from ?? null;
  const to = query.to ?? null;
  if ((from !== null && !utcTimestamp(from)) || (to !== null && !utcTimestamp(to))) throw new ApiError(400, 'INVALID_WINDOW', 'from and to must be UTC ISO-8601 timestamps');
  if (from !== null && to !== null && timestampMicros(from as string) >= timestampMicros(to as string)) throw new ApiError(400, 'INVALID_WINDOW', 'from must precede to');
  return { from: from as string | null, to: to as string | null };
}

export class IngestService {
  constructor(readonly runtime: Runtime) {}
  async ingest(payload: unknown, requestId: string, incomingTrace?: string): Promise<Receipt> {
    const started = performance.now();
    const reason = validateEvent(payload, this.runtime.config.futureSkew);
    const carrier: Record<string, string> = {};
    propagation.inject(context.active(), carrier);
    // A disabled SDK still permits preserving a valid incoming W3C context.
    const extracted = incomingTrace ? trace.getSpanContext(propagation.extract(context.active(), { traceparent: incomingTrace })) : undefined;
    const traceparent = carrier.traceparent ?? (extracted ? incomingTrace :
      incomingTrace && /^00-(?!0{32})[0-9a-f]{32}-(?!0{16})[0-9a-f]{16}-[0-9a-f]{2}$/.test(incomingTrace) ? incomingTrace : null);
    const receipt = await this.runtime.transaction(async (client): Promise<Receipt> => {
      if (reason) return this.reject(client, payload, reason);
      const event = payload as EventInput;
      const device = await client.query('SELECT id FROM devices WHERE id=$1 FOR KEY SHARE', [event.deviceId]);
      if (!device.rowCount) return this.reject(client, payload, 'unknown_device');
      const inserted = await client.query<{ pk: string }>(`INSERT INTO events
        (device_id,event_id,generated_at,temperature,humidity,op_status,traceparent)
        VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (device_id,event_id) DO NOTHING RETURNING pk`,
      [event.deviceId, event.eventId, event.generatedAt, event.temperature, event.humidity, event.status, traceparent]);
      if (inserted.rows[0]) return { result: 'accepted', eventPk: inserted.rows[0].pk, deviceId: event.deviceId, eventId: event.eventId };
      const existing = await client.query<{ pk: string }>('SELECT pk FROM events WHERE device_id=$1 AND event_id=$2', [event.deviceId, event.eventId]);
      await client.query('INSERT INTO duplicate_receipts (device_id,event_id) VALUES ($1,$2)', [event.deviceId, event.eventId]);
      return { result: 'duplicate', eventPk: existing.rows[0]!.pk, deviceId: event.deviceId, eventId: event.eventId };
    });
    this.runtime.received.inc({ outcome: receipt.result });
    if (receipt.reason) this.runtime.rejected.inc({ reason: receipt.reason });
    this.runtime.log.info({ requestId, deviceId: receipt.deviceId ?? (object(payload) && textId(payload.deviceId) ? payload.deviceId : undefined),
      eventId: receipt.eventId ?? (object(payload) && textId(payload.eventId) ? payload.eventId : undefined), outcome: receipt.result,
      reason: receipt.reason, durationMs: performance.now() - started }, 'Event receipt committed');
    return receipt;
  }
  private async reject(client: PoolClient, payload: unknown, reason: RejectionReason): Promise<Receipt> {
    const deviceId = object(payload) && textId(payload.deviceId) ? payload.deviceId : null;
    const eventId = object(payload) && textId(payload.eventId) ? payload.eventId : null;
    await client.query('INSERT INTO rejections (device_id,event_id,reason,payload) VALUES ($1,$2,$3,$4::jsonb)',
      [deviceId, eventId, reason, trimmedPayload(payload)]);
    return { result: 'rejected', reason };
  }
  async events(deviceId: string, query: Record<string, unknown>) {
    const { from, to } = windowQuery(query);
    const limit = Number(query.limit ?? 100);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new ApiError(400, 'INVALID_LIMIT', 'limit must be 1..500');
    let after: { generatedAt: string; eventId: string } | null = null;
    if (query.cursor !== undefined) {
      try {
        if (typeof query.cursor !== 'string' || query.cursor.length > 2048 || !/^[\w-]+$/.test(query.cursor)) throw new Error();
        const value: unknown = JSON.parse(Buffer.from(query.cursor, 'base64url').toString());
        if (!object(value) || !utcTimestamp(value.generatedAt) || !textId(value.eventId)) throw new Error();
        after = { generatedAt: value.generatedAt, eventId: value.eventId };
      } catch { throw new ApiError(400, 'INVALID_CURSOR', 'Invalid pagination cursor'); }
    }
    const result = await this.runtime.pool.query(`SELECT pk AS "eventPk", device_id AS "deviceId", event_id AS "eventId",
      to_char(generated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "generatedAt", received_at AS "receivedAt",
      temperature::float8, humidity::float8, op_status AS status, processing_status AS "processingStatus"
      FROM events WHERE device_id=$1 AND ($2::timestamptz IS NULL OR generated_at >= $2)
      AND ($3::timestamptz IS NULL OR generated_at < $3)
      AND ($4::timestamptz IS NULL OR (generated_at,event_id) > ($4,$5))
      ORDER BY generated_at,event_id LIMIT $6`, [deviceId, from, to, after?.generatedAt ?? null, after?.eventId ?? null, limit + 1]);
    const items = result.rows.slice(0, limit) as { generatedAt: string; eventId: string }[];
    const last = items.at(-1);
    const nextCursor = result.rows.length > limit && last ? Buffer.from(JSON.stringify({ generatedAt: last.generatedAt, eventId: last.eventId })).toString('base64url') : null;
    return { events: items, nextCursor };
  }
  async aggregates(deviceId: string, query: Record<string, unknown>) {
    const { from, to } = windowQuery(query);
    const result = await this.runtime.pool.query<{ count: string; tmin: number | null; tmax: number | null; tavg: number | null; hmin: number | null; hmax: number | null; havg: number | null }>(`SELECT count(*) AS count,
      min(temperature)::float8 AS tmin,max(temperature)::float8 AS tmax,avg(temperature)::float8 AS tavg,
      min(humidity)::float8 AS hmin,max(humidity)::float8 AS hmax,avg(humidity)::float8 AS havg FROM events
      WHERE device_id=$1 AND ($2::timestamptz IS NULL OR generated_at >= $2) AND ($3::timestamptz IS NULL OR generated_at < $3)`, [deviceId, from, to]);
    const row = result.rows[0]!;
    return { count: Number(row.count), temperature: { min: row.tmin, max: row.tmax, avg: row.tavg }, humidity: { min: row.hmin, max: row.hmax, avg: row.havg }, from, to };
  }
  async stats(query: Record<string, unknown>) {
    const { from, to } = windowQuery(query);
    const result = await this.runtime.pool.query<Record<string, string>>(`WITH accepted AS (
      SELECT * FROM events WHERE ($1::timestamptz IS NULL OR received_at >= $1) AND ($2::timestamptz IS NULL OR received_at < $2)
    ) SELECT count(*) AS accepted,
      count(*) FILTER (WHERE processing_status='pending') AS pending,
      count(*) FILTER (WHERE processing_status='processing') AS processing,
      count(*) FILTER (WHERE processing_status='processed') AS processed,
      count(*) FILTER (WHERE processing_status='failed') AS failed,
      (SELECT count(*) FROM duplicate_receipts WHERE ($1::timestamptz IS NULL OR received_at >= $1) AND ($2::timestamptz IS NULL OR received_at < $2)) AS duplicates,
      (SELECT count(*) FROM rejections WHERE ($1::timestamptz IS NULL OR received_at >= $1) AND ($2::timestamptz IS NULL OR received_at < $2)) AS rejected
      FROM accepted`, [from, to]);
    const row = Object.fromEntries(Object.entries(result.rows[0]!).map(([key, value]) => [key, Number(value)]));
    return { received: row.accepted! + row.duplicates! + row.rejected!, ...row };
  }
}
