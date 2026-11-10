import { context, propagation, SpanStatusCode, trace, ROOT_CONTEXT, SpanContext } from '@opentelemetry/api';
import { Runtime } from '../../libs/common/runtime';
import { breached, Metric, Threshold } from '../../libs/common/domain';

interface Claim { pk: string; locked_at: string; device_id: string; event_id: string; traceparent: string | null }
interface EventRow { device_id: string; event_id: string; received_at: Date; generated_at: string; temperature: string; humidity: string }

export class Worker {
  private stopping = false;
  private running?: Promise<void>;
  private wake?: () => void;
  private lastBacklog = 0;
  private backlogTimer?: NodeJS.Timeout;
  private backlogRefresh?: Promise<void>;
  private readonly tracer = trace.getTracer('event-processor');
  constructor(readonly runtime: Runtime) {}
  start(): void {
    if (!this.running) {
      this.running = this.loop();
      this.backlogTimer = setInterval(() => {
        if (!this.backlogRefresh) this.backlogRefresh = this.refreshBacklog(true)
          .catch(() => this.runtime.log.error({ outcome: 'backlog_error' }, 'Backlog refresh failed'))
          .finally(() => { this.backlogRefresh = undefined; });
      }, 5000);
    }
  }
  async stop(): Promise<void> {
    this.stopping = true;
    clearInterval(this.backlogTimer);
    this.wake?.();
    await this.running;
    await this.backlogRefresh;
  }
  private async sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { this.wake = undefined; resolve(); }, ms);
      this.wake = () => { clearTimeout(timer); this.wake = undefined; resolve(); };
    });
  }
  private async loop(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.refreshBacklog();
        if (!(await this.runBatch())) await this.sleep(this.runtime.config.pollMs);
      } catch {
        this.runtime.log.error({ outcome: 'poll_error' }, 'Processor polling failed');
        await this.sleep(this.runtime.config.pollMs);
      }
      this.runtime.loopHeartbeat = Date.now();
    }
  }
  async refreshBacklog(force = false): Promise<void> {
    if (!force && Date.now() - this.lastBacklog < 5000) return;
    const result = await this.runtime.pool.query<{ processing_status: string; count: string }>(`SELECT processing_status,count(*) FROM events
      WHERE processing_status IN ('pending','processing') GROUP BY processing_status`);
    for (const status of ['pending', 'processing']) this.runtime.backlog.set({ status }, Number(result.rows.find((row) => row.processing_status === status)?.count ?? 0));
    this.lastBacklog = Date.now();
  }
  async runBatch(): Promise<number> {
    return this.tracer.startActiveSpan('process_batch', async (span) => {
      try {
        const claims = await this.runtime.transaction(async (client) => {
          const result = await client.query<Claim>(`WITH candidates AS (
            SELECT pk FROM events WHERE processing_status='pending'
              OR (processing_status='processing' AND locked_at < now() - ($1 * interval '1 second'))
            ORDER BY received_at,pk LIMIT $2 FOR UPDATE SKIP LOCKED
          ) UPDATE events e SET processing_status='processing',locked_at=clock_timestamp()
            FROM candidates c WHERE e.pk=c.pk
            RETURNING e.pk,e.locked_at::text,e.device_id,e.event_id,e.traceparent`,
          [this.runtime.config.leaseSeconds, this.runtime.config.batchSize]);
          return result.rows;
        });
        for (const claim of claims) {
          this.runtime.log.debug({ eventId: claim.event_id, deviceId: claim.device_id, outcome: 'processing' }, 'Event claimed');
          await this.process(claim);
          this.runtime.loopHeartbeat = Date.now();
          await this.refreshBacklog();
        }
        return claims.length;
      } finally { span.end(); }
    });
  }
  private linkedContext(traceparent: string | null): SpanContext | undefined {
    if (!traceparent) return undefined;
    const extracted = trace.getSpanContext(propagation.extract(ROOT_CONTEXT, { traceparent }));
    if (extracted) return extracted;
    const match = /^00-((?!0{32})[0-9a-f]{32})-((?!0{16})[0-9a-f]{16})-([0-9a-f]{2})$/.exec(traceparent);
    return match ? { traceId: match[1]!, spanId: match[2]!, traceFlags: parseInt(match[3]!, 16), isRemote: true } : undefined;
  }
  private async process(claim: Claim): Promise<void> {
    const linked = this.linkedContext(claim.traceparent);
    await this.tracer.startActiveSpan('process_event', {
      attributes: { 'device.id': claim.device_id, 'event.id': claim.event_id, 'event.pk': claim.pk },
      links: linked ? [{ context: linked }] : [],
    }, context.active(), async (span) => {
      const start = performance.now();
      try {
        const completed = await this.runtime.transaction(async (client) => {
          // Fence expired claims and retain the row lock until alerts + completion commit.
          // Another worker can reclaim a waiting batch member, but never execute stale work.
          const result = await client.query<EventRow>(`SELECT events.*,generated_at::text AS generated_at FROM events WHERE pk=$1
            AND processing_status='processing' AND locked_at=$2::timestamptz FOR UPDATE`, [claim.pk, claim.locked_at]);
          const event = result.rows[0];
          if (!event) return null;
          if (this.runtime.config.delayMs) await new Promise((resolve) => setTimeout(resolve, this.runtime.config.delayMs));
          const thresholds = await client.query<Threshold>(`SELECT DISTINCT ON (t.metric) t.metric,t.min::float8,t.max::float8
            FROM thresholds t JOIN devices d ON d.id=$1
            WHERE t.installation_id=d.installation_id OR t.installation_id IS NULL
            ORDER BY t.metric,t.installation_id NULLS LAST`, [event.device_id]);
          const raised: Metric[] = [];
          for (const threshold of thresholds.rows) {
            const value = Number(event[threshold.metric]);
            if (breached(value, threshold)) {
              const inserted = await client.query(`INSERT INTO business_alerts
                (event_pk,device_id,metric,value,threshold_min,threshold_max,generated_at)
                VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (event_pk,metric) DO NOTHING`,
              [claim.pk, event.device_id, threshold.metric, value, threshold.min, threshold.max, event.generated_at]);
              if (inserted.rowCount) raised.push(threshold.metric);
            }
          }
          const updated = await client.query<{ lag: number }>(`UPDATE events SET processing_status='processed',processed_at=clock_timestamp(),locked_at=NULL,last_error=NULL
            WHERE pk=$1 RETURNING extract(epoch FROM (processed_at-received_at))::float8 AS lag`, [claim.pk]);
          return { raised, lag: updated.rows[0]!.lag };
        });
        if (completed) {
          for (const metric of completed.raised) this.runtime.alerts.inc({ metric });
          this.runtime.processed.inc({ result: 'processed' });
          this.runtime.lag.observe(Math.max(0, completed.lag));
          this.runtime.log.info({ eventId: claim.event_id, deviceId: claim.device_id, outcome: 'processed', durationMs: performance.now() - start }, 'Event processed');
        }
      } catch (error) {
        // Error codes are useful without exposing SQL, credentials, or payloads.
        const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' && /^[A-Z0-9]{5}$/.test(error.code) ? error.code : 'PROCESSING_ERROR';
        span.setStatus({ code: SpanStatusCode.ERROR, message: code });
        const failure = await this.runtime.pool.query<{ processing_status: string }>(`UPDATE events SET attempts=attempts+1,
          processing_status=CASE WHEN attempts+1 >= 5 THEN 'failed' ELSE 'pending' END,
          locked_at=NULL,last_error=$3 WHERE pk=$1 AND processing_status='processing' AND locked_at=$2::timestamptz RETURNING processing_status`, [claim.pk, claim.locked_at, code]);
        if (failure.rows[0]?.processing_status === 'failed') this.runtime.processed.inc({ result: 'failed' });
        this.runtime.log.error({ eventId: claim.event_id, deviceId: claim.device_id, outcome: failure.rows[0]?.processing_status ?? 'lease_lost', reason: code }, 'Event processing failed');
      } finally {
        this.runtime.duration.observe((performance.now() - start) / 1000);
        span.end();
      }
    });
  }
}
