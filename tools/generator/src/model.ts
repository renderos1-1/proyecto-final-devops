import { createHash } from 'node:crypto';

export interface Options {
  command: 'seed' | 'burst' | 'sustained' | 'dupes-ooo'; seed: string; baseUrl: string;
  apiKey: string; adminKey: string; installations: number; devices: number; count: number;
  concurrency: number; rate: number; duration: number; duplicates: number; outOfOrder: number;
  invalidRatio: number; batchSize: number; out?: string; dryRun: boolean;
}
export interface Event {
  eventId: string; deviceId: string; generatedAt: string; temperature: number; humidity: number; status: string;
}
export interface Plan { initial: Event[]; duplicates: Event[]; older: Event[]; invalid: Event[]; from: string; to: string }
export function random(seed: string): () => number {
  let state = createHash('sha256').update(seed).digest().readUInt32LE(0);
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function deviceIds(options: Options): string[] {
  return Array.from({ length: options.installations }, (_, i) =>
    Array.from({ length: options.devices }, (_, j) => `generator-device-${i + 1}-${j + 1}`)).flat();
}
export function seedPlan(options: Options): { path: string; body: Record<string, string> }[] {
  return Array.from({ length: options.installations }, (_, index) => {
    const i = index + 1;
    return [{ path: '/v1/installations', body: { id: `generator-installation-${i}`, name: `Generator installation ${i}` } },
      ...Array.from({ length: options.devices }, (_, deviceIndex) => {
        const j = deviceIndex + 1;
        return { path: '/v1/devices', body: { id: `generator-device-${i}-${j}`, installationId: `generator-installation-${i}`, name: `Generator device ${i}-${j}` } };
      })];
  }).flat();
}
export function makePlan(options: Options): Plan {
  const rng = random(options.seed);
  const prefix = createHash('sha256').update(`${options.command}:${options.seed}`).digest('hex').slice(0, 20);
  const devices = deviceIds(options);
  // A fixed historic UTC anchor makes the entire payload reproducible, including dates.
  const anchor = Date.UTC(2024, 0, 2);
  const count = options.command === 'sustained' ? Math.round(options.rate * options.duration) : options.count;
  const make = (index: number, older = false): Event => ({
    eventId: `${prefix}-${older ? 'older' : 'event'}-${index}`,
    deviceId: devices[index % devices.length]!,
    generatedAt: new Date(anchor + (older ? -(index + 1) * 1000 : index * 1000)).toISOString(),
    temperature: Math.round((-40 + rng() * 125) * 100) / 100,
    humidity: Math.round(rng() * 10000) / 100,
    status: ['ok', 'warning', 'fault', 'offline'][Math.floor(rng() * 4)]!,
  });
  const initial = Array.from({ length: count }, (_, index) => make(index));
  const duplicates = options.command === 'dupes-ooo' ? Array.from({ length: options.duplicates }, (_, index) => ({ ...initial[index % initial.length]! })) : [];
  const older = options.command === 'dupes-ooo' ? Array.from({ length: options.outOfOrder }, (_, index) => make(index, true)) : [];
  const invalid = Array.from({ length: Math.round((initial.length + older.length) * options.invalidRatio) }, (_, index) => ({
    ...make(index), eventId: `${prefix}-invalid-${index}`, temperature: 1000,
  }));
  return { initial, duplicates, older, invalid,
    from: new Date(anchor - (older.length + 1) * 1000).toISOString(),
    to: new Date(anchor + count * 1000).toISOString() };
}
export function aggregate(events: Event[]) {
  const unique = [...new Map(events.map((event) => [`${event.deviceId}\0${event.eventId}`, event])).values()];
  const values = (key: 'temperature' | 'humidity') => {
    const items = unique.map((event) => event[key]);
    return items.length ? { min: items.reduce((a, b) => Math.min(a, b)), max: items.reduce((a, b) => Math.max(a, b)), avg: items.reduce((a, b) => a + b, 0) / items.length } : { min: null, max: null, avg: null };
  };
  return { count: unique.length, temperature: values('temperature'), humidity: values('humidity') };
}
export function equalAggregates(expected: ReturnType<typeof aggregate>, actual: unknown): boolean {
  if (!actual || typeof actual !== 'object') return false;
  const value = actual as ReturnType<typeof aggregate>;
  if (value.count !== expected.count) return false;
  return (['temperature', 'humidity'] as const).every((metric) => (['min', 'max', 'avg'] as const).every((stat) => {
    const a = expected[metric][stat], b = value[metric]?.[stat];
    return a === null ? b === null : typeof b === 'number' && Math.abs(a - b) < 1e-8;
  }));
}
export function percentile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * q) - 1)]! : 0;
}
