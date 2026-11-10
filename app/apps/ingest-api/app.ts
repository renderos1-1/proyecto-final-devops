import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { Config, configuration } from '../../libs/common/config';
import { Runtime } from '../../libs/common/runtime';
import { createHttpApp, HealthController } from '../../libs/common/http';
import { IngestController } from './controller';

export async function createIngestApp(config: Config = configuration('ingest-api')) {
  const runtime = new Runtime(config);
  @Module({ controllers: [HealthController, IngestController], providers: [{ provide: Runtime, useValue: runtime }] })
  class IngestModule {}
  const app = await createHttpApp(IngestModule, runtime);
  return { app, runtime };
}
