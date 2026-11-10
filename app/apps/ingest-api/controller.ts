import { Body, Controller, Get, Inject, Param, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Runtime } from '../../libs/common/runtime';
import { ApiError, ApiRequest } from '../../libs/common/http';
import { object, textId } from '../../libs/common/domain';
import { IngestService, windowQuery } from './service';

@Controller('v1')
export class IngestController {
  private readonly service: IngestService;
  constructor(@Inject(Runtime) private readonly runtime: Runtime) { this.service = new IngestService(runtime); }

  @Post('installations')
  async installation(@Body() body: unknown) {
    if (!object(body) || !textId(body.id) || !textId(body.name)) throw new ApiError(400, 'INVALID_INSTALLATION', 'id and name must be nonempty strings');
    const result = await this.runtime.pool.query(`INSERT INTO installations (id,name) VALUES ($1,$2)
      ON CONFLICT (id) DO UPDATE SET id=EXCLUDED.id RETURNING id,name,created_at AS "createdAt"`, [body.id, body.name]);
    return result.rows[0] as unknown;
  }
  @Get('installations')
  async installations() {
    return (await this.runtime.pool.query('SELECT id,name,created_at AS "createdAt" FROM installations ORDER BY id')).rows;
  }
  @Post('devices')
  async device(@Body() body: unknown) {
    if (!object(body) || !textId(body.id) || !textId(body.installationId) || !textId(body.name)) throw new ApiError(400, 'INVALID_DEVICE', 'id, installationId and name must be nonempty strings');
    const installation = await this.runtime.pool.query('SELECT id FROM installations WHERE id=$1', [body.installationId]);
    if (!installation.rowCount) throw new ApiError(422, 'UNKNOWN_INSTALLATION', 'Installation does not exist');
    const result = await this.runtime.pool.query(`INSERT INTO devices (id,installation_id,name) VALUES ($1,$2,$3)
      ON CONFLICT (id) DO UPDATE SET id=EXCLUDED.id RETURNING id,installation_id AS "installationId",name,created_at AS "createdAt"`, [body.id, body.installationId, body.name]);
    return result.rows[0] as unknown;
  }
  @Get('devices/:id')
  async getDevice(@Param('id') id: string) {
    const result = await this.runtime.pool.query('SELECT id,installation_id AS "installationId",name,created_at AS "createdAt" FROM devices WHERE id=$1', [id]);
    if (!result.rowCount) throw new ApiError(404, 'DEVICE_NOT_FOUND', 'Device does not exist');
    return result.rows[0] as unknown;
  }
  @Put('thresholds')
  async threshold(@Body() body: unknown) {
    if (!object(body) || (body.installationId !== null && !textId(body.installationId)) ||
      typeof body.metric !== 'string' || !['temperature', 'humidity'].includes(body.metric) ||
      ![body.min, body.max].every((n) => n === null || (typeof n === 'number' && Number.isFinite(n))) ||
      (typeof body.min === 'number' && typeof body.max === 'number' && body.min > body.max)) {
      throw new ApiError(400, 'INVALID_THRESHOLD', 'Provide installationId (or null), metric, and ordered numeric min/max (or null)');
    }
    if (body.installationId !== null && !(await this.runtime.pool.query('SELECT id FROM installations WHERE id=$1', [body.installationId])).rowCount) {
      throw new ApiError(422, 'UNKNOWN_INSTALLATION', 'Installation does not exist');
    }
    const result = await this.runtime.pool.query(`INSERT INTO thresholds (installation_id,metric,min,max) VALUES ($1,$2,$3,$4)
      ON CONFLICT (installation_id,metric) DO UPDATE SET min=EXCLUDED.min,max=EXCLUDED.max
      RETURNING installation_id AS "installationId",metric,min::float8,max::float8`, [body.installationId, body.metric, body.min, body.max]);
    return result.rows[0] as unknown;
  }
  @Get('thresholds')
  async thresholds() {
    return (await this.runtime.pool.query('SELECT installation_id AS "installationId",metric,min::float8,max::float8 FROM thresholds ORDER BY installation_id NULLS FIRST,metric')).rows;
  }
  @Post('events')
  async event(@Body() body: unknown, @Req() req: ApiRequest, @Res() res: Response): Promise<void> {
    const result = await this.service.ingest(body, req.requestId, req.header('traceparent'));
    res.status(result.result === 'accepted' ? 202 : result.result === 'duplicate' ? 200 : 422).json(result);
  }
  @Post('events/batch')
  async batch(@Body() body: unknown, @Req() req: ApiRequest, @Res() res: Response): Promise<void> {
    if (!object(body) || !Array.isArray(body.events) || body.events.length < 1 || body.events.length > 500) throw new ApiError(400, 'INVALID_BATCH', 'events must contain 1..500 items');
    const results: unknown[] = [];
    for (const event of body.events) {
      try { results.push(await this.service.ingest(event, req.requestId, req.header('traceparent'))); }
      catch {
        this.runtime.log.error({ requestId: req.requestId, outcome: 'batch_item_error' }, 'Batch item could not be committed');
        results.push({ error: { code: 'INTERNAL_ERROR', message: 'Event could not be committed' }, requestId: req.requestId });
      }
    }
    res.status(200).json({ results });
  }
  @Get('devices/:id/events')
  events(@Param('id') id: string, @Query() query: Record<string, unknown>) { return this.service.events(id, query); }
  @Get('devices/:id/aggregates')
  aggregates(@Param('id') id: string, @Query() query: Record<string, unknown>) { return this.service.aggregates(id, query); }
  @Get('stats')
  stats(@Query() query: Record<string, unknown>) { return this.service.stats(query); }
  @Get('alerts')
  async alerts(@Query() query: Record<string, unknown>) {
    const { from, to } = windowQuery(query);
    if (query.deviceId !== undefined && !textId(query.deviceId)) throw new ApiError(400, 'INVALID_DEVICE', 'Invalid deviceId');
    return (await this.runtime.pool.query(`SELECT id,event_pk AS "eventPk",device_id AS "deviceId",metric,value::float8,
      threshold_min::float8 AS "thresholdMin",threshold_max::float8 AS "thresholdMax",generated_at AS "generatedAt",created_at AS "createdAt"
      FROM business_alerts WHERE ($1::text IS NULL OR device_id=$1) AND ($2::timestamptz IS NULL OR generated_at >= $2)
      AND ($3::timestamptz IS NULL OR generated_at < $3) ORDER BY generated_at,id`, [query.deviceId ?? null, from, to])).rows;
  }
}
