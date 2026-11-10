import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import type { Logger } from 'pino';
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';
import type { Config } from './config';
import { stopTelemetry } from './telemetry';
import { createLogger } from './logging';

@Injectable()
export class Runtime implements OnApplicationShutdown {
  readonly pool: Pool;
  readonly log: Logger;
  readonly registry = new Registry();
  readonly received = new Counter({ name: 'events_received_total', help: 'Ingestion outcomes', labelNames: ['outcome'], registers: [this.registry] });
  readonly rejected = new Counter({ name: 'events_rejected_total', help: 'Rejected events', labelNames: ['reason'], registers: [this.registry] });
  readonly processed = new Counter({ name: 'events_processed_total', help: 'Processor outcomes', labelNames: ['result'], registers: [this.registry] });
  readonly httpDuration = new Histogram({ name: 'http_request_duration_seconds', help: 'HTTP latency', labelNames: ['method', 'route', 'status_code'], registers: [this.registry] });
  readonly lag = new Histogram({ name: 'event_processing_lag_seconds', help: 'Queue wait plus processing time', buckets: [0.01, 0.1, 0.5, 1, 5, 15, 60, 300, 900, 3600], registers: [this.registry] });
  readonly duration = new Histogram({ name: 'event_processing_duration_seconds', help: 'Effective processing time', buckets: [0.001, 0.01, 0.1, 0.5, 1, 5, 30, 60], registers: [this.registry] });
  readonly backlog = new Gauge({ name: 'events_backlog', help: 'Queue depth', labelNames: ['status'], registers: [this.registry] });
  readonly alerts = new Counter({ name: 'business_alerts_total', help: 'Threshold alerts raised', labelNames: ['metric'], registers: [this.registry] });
  loopHeartbeat = Date.now();
  constructor(readonly config: Config) {
    this.pool = new Pool({ connectionString: config.databaseUrl, max: 12, connectionTimeoutMillis: 5000, statement_timeout: 30000 });
    this.log = createLogger(config);
    this.pool.on('error', () => this.log.error({ outcome: 'db_connection_error' }, 'Idle database connection failed'));
    collectDefaultMetrics({ register: this.registry });
    for (const status of ['pending', 'processing']) this.backlog.set({ status }, 0);
    for (const outcome of ['accepted', 'duplicate', 'rejected']) this.received.inc({ outcome }, 0);
    for (const result of ['processed', 'failed']) this.processed.inc({ result }, 0);
  }
  async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
    this.registry.clear();
    await stopTelemetry();
  }
}
