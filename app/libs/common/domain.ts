export type Metric = 'temperature' | 'humidity';
export type RejectionReason = 'invalid_payload' | 'missing_field' | 'invalid_event_id' | 'invalid_device_id' |
  'invalid_timestamp' | 'future_timestamp' | 'temperature_out_of_range' | 'humidity_out_of_range' | 'invalid_status' | 'unknown_device';
export interface EventInput {
  eventId: string; deviceId: string; generatedAt: string; temperature: number; humidity: number;
  status: 'ok' | 'warning' | 'fault' | 'offline';
}
export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function textId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.trim().length > 0 && !value.includes('\0');
}
export function utcTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|\+00:00)$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 19) === value.slice(0, 19);
}
export function timestampMicros(value: string): bigint {
  const fraction = /\.(\d+)/.exec(value)?.[1] ?? '0';
  return BigInt(Date.parse(`${value.slice(0, 19)}Z`)) * 1000n + BigInt(Math.round(Number(`0.${fraction}`) * 1000000));
}
export function validateEvent(value: unknown, skewSeconds: number, now = Date.now()): RejectionReason | null {
  if (!object(value)) return 'invalid_payload';
  for (const key of ['eventId', 'deviceId', 'generatedAt', 'temperature', 'humidity', 'status']) {
    if (value[key] === undefined || value[key] === null) return 'missing_field';
  }
  if (!textId(value.eventId) || value.eventId.length > 128) return 'invalid_event_id';
  if (!textId(value.deviceId)) return 'invalid_device_id';
  if (!utcTimestamp(value.generatedAt)) return 'invalid_timestamp';
  if (timestampMicros(value.generatedAt) > BigInt(now + skewSeconds * 1000) * 1000n) return 'future_timestamp';
  if (typeof value.temperature !== 'number' || !Number.isFinite(value.temperature) || value.temperature < -40 || value.temperature > 85) return 'temperature_out_of_range';
  if (typeof value.humidity !== 'number' || !Number.isFinite(value.humidity) || value.humidity < 0 || value.humidity > 100) return 'humidity_out_of_range';
  if (typeof value.status !== 'string' || !['ok', 'warning', 'fault', 'offline'].includes(value.status)) return 'invalid_status';
  return null;
}
export interface Threshold { metric: Metric; min: number | null; max: number | null }
export function breached(value: number, threshold: Threshold): boolean {
  return (threshold.min !== null && value < threshold.min) || (threshold.max !== null && value > threshold.max);
}
export function aggregate(values: number[]): { min: number | null; max: number | null; avg: number | null } {
  if (!values.length) return { min: null, max: null, avg: null };
  return { min: values.reduce((a, b) => Math.min(a, b)), max: values.reduce((a, b) => Math.max(a, b)), avg: values.reduce((a, b) => a + b, 0) / values.length };
}
export interface Stats { received: number; accepted: number; duplicates: number; rejected: number; pending: number; processing: number; processed: number; failed: number }
export function statsConsistent(stats: Stats): boolean {
  return stats.received === stats.accepted + stats.duplicates + stats.rejected &&
    stats.accepted === stats.pending + stats.processing + stats.processed + stats.failed;
}

// Budget conservatively for jsonb's whitespace and JSON escaping, including multibyte input.
export function trimmedPayload(value: unknown): string {
  const json = JSON.stringify(value ?? null);
  // PostgreSQL jsonb cannot represent NUL or unpaired UTF-16 surrogates.
  if (/\\u0000|\\u[dD][89a-fA-F][0-9a-fA-F]{2}/.test(json)) {
    return JSON.stringify({ truncated: true, encoding: 'base64', preview: Buffer.from(json).toString('base64').slice(0, 1600) });
  }
  if (Buffer.byteLength(json) <= 1800) return json;
  let preview = json.slice(0, 600);
  while (Buffer.byteLength(JSON.stringify({ truncated: true, preview })) > 1800) preview = preview.slice(0, -1);
  return JSON.stringify({ truncated: true, preview });
}
