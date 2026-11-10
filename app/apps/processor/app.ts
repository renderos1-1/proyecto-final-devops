import 'reflect-metadata';
import { BeforeApplicationShutdown, Module } from '@nestjs/common';
import { Config, configuration } from '../../libs/common/config';
import { Runtime } from '../../libs/common/runtime';
import { createHttpApp, HealthController } from '../../libs/common/http';
import { Worker } from './worker';

export async function createProcessorApp(config: Config = configuration('processor'), start = true) {
  const runtime = new Runtime(config);
  const worker = new Worker(runtime);
  class Shutdown implements BeforeApplicationShutdown {
    async beforeApplicationShutdown(): Promise<void> { await worker.stop(); }
  }
  @Module({ controllers: [HealthController], providers: [{ provide: Runtime, useValue: runtime }, Shutdown] })
  class ProcessorModule {}
  const app = await createHttpApp(ProcessorModule, runtime);
  if (start) worker.start();
  return { app, runtime, worker };
}
