#!/usr/bin/env node
import { help, options } from './options';
import { run } from './runner';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help')) { console.log(help); return; }
  let config;
  try { config = options(args); }
  catch (error) { console.error(error instanceof Error ? error.message : 'Invalid options'); process.exitCode = 1; return; }
  try {
    const result = await run(config);
    console.log(JSON.stringify(result.report, null, 2));
    if (!result.ok) process.exitCode = 1;
  } catch { console.error('Generator failed; check output path and connectivity'); process.exitCode = 1; }
}
void main();
