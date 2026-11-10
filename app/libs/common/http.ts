import { ArgumentsHost, Catch, Controller, ExceptionFilter, Get, HttpException, Inject, Res } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Type } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { Runtime } from './runtime';
import { traceFields } from './telemetry';

export class ApiError extends HttpException {
  constructor(status: number, code: string, message: string) { super({ code, message }, status); }
}
export interface ApiRequest extends Request { requestId: string }

@Catch()
export class Errors implements ExceptionFilter {
  constructor(private readonly runtime: Runtime) {}
  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const request = host.switchToHttp().getRequest<ApiRequest>();
    const status = error instanceof HttpException ? error.getStatus() : 500;
    const body = error instanceof HttpException ? error.getResponse() : null;
    const message = status >= 500 ? 'Internal server error' : error instanceof Error ? error.message : 'Request failed';
    const detail = body && typeof body === 'object' && 'code' in body ? body : { code: status >= 500 ? 'INTERNAL_ERROR' : 'HTTP_ERROR', message };
    if (status >= 500) this.runtime.log.error({ requestId: request.requestId, outcome: 'http_error', statusCode: status }, 'Request failed');
    response.status(status).json({ error: detail, requestId: request.requestId ?? randomUUID() });
  }
}

@Controller()
export class HealthController {
  constructor(@Inject(Runtime) private readonly runtime: Runtime) {}
  @Get('healthz/live')
  live(): { status: string } {
    if (this.runtime.config.app === 'processor' && Date.now() - this.runtime.loopHeartbeat > 60000) {
      throw new ApiError(503, 'LOOP_STUCK', 'Processor loop is not making progress');
    }
    return { status: 'ok' };
  }
  @Get('healthz/ready')
  async ready(): Promise<{ status: string }> {
    try { await this.runtime.pool.query('SELECT 1'); }
    catch { throw new ApiError(503, 'DB_UNAVAILABLE', 'Database is unavailable'); }
    return { status: 'ok' };
  }
  @Get('version')
  version(): { app: string; version: string; gitSha: string } {
    const { app, version, gitSha } = this.runtime.config;
    return { app, version, gitSha };
  }
  @Get('metrics')
  async metrics(@Res() response: Response): Promise<void> {
    response.type(this.runtime.registry.contentType).send(await this.runtime.registry.metrics());
  }
}

function sameKey(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}
export async function createHttpApp(module: Type<unknown>, runtime: Runtime) {
  const app = await NestFactory.create(module, { logger: false });
  app.use((req: ApiRequest, res: Response, next: NextFunction) => {
    req.requestId = randomUUID();
    res.setHeader('X-Request-Id', req.requestId);
    const start = performance.now();
    const tracing = traceFields();
    res.on('finish', () => {
      const durationMs = performance.now() - start;
      const route = (req.route as { path?: string } | undefined)?.path ?? 'unmatched';
      const method = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(req.method) ? req.method : 'OTHER';
      runtime.httpDuration.observe({ method, route, status_code: res.statusCode }, durationMs / 1000);
      runtime.log.info({ ...tracing, requestId: req.requestId, method, route, statusCode: res.statusCode, durationMs }, 'HTTP request');
    });
    const path = req.path.toLowerCase();
    if (/^\/v1(?:\/|$)/.test(path)) {
      const key = req.header('X-API-Key') ?? '';
      const admin = !!key && sameKey(key, runtime.config.adminKey);
      const valid = admin || runtime.config.ingestKeys.some((candidate) => sameKey(key, candidate));
      const adminRoute = /^\/v1\/(?:installations|thresholds)(?:\/|$)/.test(path) ||
        (req.method === 'POST' && /^\/v1\/devices\/?$/.test(path)) ||
        (['GET', 'HEAD'].includes(req.method) && /^\/v1\/devices\/[^/]+\/?$/.test(path));
      if (!valid || (adminRoute && !admin)) {
        const status = valid ? 403 : 401;
        res.status(status).json({ error: { code: valid ? 'FORBIDDEN' : 'UNAUTHORIZED', message: valid ? 'Admin key required' : 'Valid API key required' }, requestId: req.requestId });
        return;
      }
    }
    next();
  });
  // Nest's default body limit is too small for 500 events with metadata.
  const { json } = await import('express');
  app.use(json({ limit: '2mb' }));
  app.useGlobalFilters(new Errors(runtime));
  app.enableShutdownHooks();
  await app.init();
  return app;
}
