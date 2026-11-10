import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { aggregate, deviceIds, equalAggregates, Event, makePlan, Options, percentile, seedPlan } from './model';

interface Summary {
  sent: number; accepted: number; duplicate: number; rejected: number; httpErrors: number;
  latencyMs: { p50: number; p95: number; p99: number }; achievedRate: number; durationSeconds: number;
}
export async function run(options: Options) {
  const started = performance.now();
  const summary: Summary = { sent: 0, accepted: 0, duplicate: 0, rejected: 0, httpErrors: 0,
    latencyMs: { p50: 0, p95: 0, p99: 0 }, achievedRate: 0, durationSeconds: 0 };
  const latencies: number[] = [];
  const plan = makePlan(options);
  const expected: Record<string, ReturnType<typeof aggregate> & { from: string; to: string }> = {};
  const verification: Record<string, boolean> = {};
  const report = () => ({ command: options.command, seed: options.seed, dryRun: options.dryRun, summary, expected, verification,
    ...(options.dryRun ? { plan: options.command === 'seed' ? seedPlan(options) : plan } : {}) });
  const save = async () => { if (options.out) await writeFile(options.out, `${JSON.stringify(report(), null, 2)}\n`); };
  const request = async (path: string, method = 'GET', body?: unknown, admin = false) => {
    const response = await fetch(`${options.baseUrl}${path}`, { method, headers: {
      'X-API-Key': admin ? options.adminKey : options.apiKey, 'Content-Type': 'application/json',
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
    const data: unknown = await response.json();
    return { status: response.status, data };
  };
  const emit = async (events: Event[]) => {
    summary.sent += events.length;
    const start = performance.now();
    try {
      const batch = options.batchSize > 1;
      const response = await request(batch ? '/v1/events/batch' : '/v1/events', 'POST', batch ? { events } : events[0]);
      const results = batch ? (response.data as { results?: unknown[] }).results : [response.data];
      if (![200, 202, 422].includes(response.status) || !Array.isArray(results) || results.length !== events.length) {
        summary.httpErrors += events.length;
      } else {
        for (const result of results) {
          const outcome = (result as { result?: string } | null)?.result;
          if (outcome === 'accepted' || outcome === 'duplicate' || outcome === 'rejected') summary[outcome]++;
          else summary.httpErrors++;
        }
      }
    } catch { summary.httpErrors += events.length; }
    finally { latencies.push(performance.now() - start); }
  };
  const send = async (events: Event[], rate?: number) => {
    const batches = Array.from({ length: Math.ceil(events.length / options.batchSize) }, (_, i) => events.slice(i * options.batchSize, (i + 1) * options.batchSize));
    let next = 0;
    const phaseStart = performance.now();
    await Promise.all(Array.from({ length: Math.min(options.concurrency, batches.length) }, async () => {
      while (next < batches.length) {
        const index = next++;
        if (rate) {
          const delay = phaseStart + index * options.batchSize / rate * 1000 - performance.now();
          if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
        }
        await emit(batches[index]!);
      }
    }));
    if (rate) {
      const remaining = phaseStart + events.length / rate * 1000 - performance.now();
      if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
    }
  };
  try {
    if (options.dryRun) {
      summary.sent = options.command === 'seed' ? options.installations * (1 + options.devices) : plan.initial.length + plan.duplicates.length + plan.older.length + plan.invalid.length;
      if (options.command === 'dupes-ooo') for (const device of deviceIds(options)) expected[device] = { ...aggregate([...plan.initial, ...plan.older].filter((event) => event.deviceId === device)), from: plan.from, to: plan.to };
    } else if (options.command === 'seed') {
      for (const operation of seedPlan(options)) {
          summary.sent++;
          const start = performance.now();
          try {
            const response = await request(operation.path, 'POST', operation.body, true);
            if (response.status >= 200 && response.status < 300) summary.accepted++; else summary.httpErrors++;
          } catch { summary.httpErrors++; }
          finally { latencies.push(performance.now() - start); }
      }
    } else {
      if (options.command === 'dupes-ooo') {
        // Include pre-existing accepted rows, making verification safe when repeating a seed.
        for (const device of deviceIds(options)) {
          const baseline: Event[] = [];
          let cursor: string | null = null;
          do {
            const query = new URLSearchParams({ from: plan.from, to: plan.to, limit: '500', ...(cursor ? { cursor } : {}) });
            const response = await request(`/v1/devices/${encodeURIComponent(device)}/events?${query}`);
            if (response.status !== 200) throw new Error('Could not read baseline');
            const page = response.data as { events: Event[]; nextCursor: string | null };
            if (!Array.isArray(page.events)) throw new Error('Invalid baseline response');
            baseline.push(...page.events);
            cursor = page.nextCursor;
          } while (cursor);
          // Existing rows win, because duplicate payloads cannot modify the original.
          expected[device] = { ...aggregate([...plan.initial, ...plan.older].filter((event) => event.deviceId === device).concat(baseline)), from: plan.from, to: plan.to };
        }
        await save(); // Persist the independent expectation BEFORE sending/verifying.
      }
      await send(plan.initial, options.command === 'sustained' ? options.rate : undefined);
      await send(plan.duplicates);
      await send(plan.older);
      await send(plan.invalid);
      if (options.command === 'dupes-ooo') for (const device of deviceIds(options)) {
        const query = new URLSearchParams({ from: plan.from, to: plan.to });
        const response = await request(`/v1/devices/${encodeURIComponent(device)}/aggregates?${query}`);
        verification[device] = response.status === 200 && equalAggregates(expected[device]!, response.data);
      }
    }
  } catch {
    summary.httpErrors++;
    verification.run = false;
  } finally {
    if (!options.dryRun) {
      summary.durationSeconds = (performance.now() - started) / 1000;
      summary.achievedRate = summary.sent / summary.durationSeconds;
      summary.latencyMs = { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), p99: percentile(latencies, 0.99) };
    }
    await save();
  }
  return { report: report(), ok: summary.httpErrors === 0 && Object.values(verification).every(Boolean) };
}
