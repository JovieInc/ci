#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { loadConfig, validateConfig } from '../config.mjs';
import { runWalk } from './walk.mjs';

export async function main(argv = process.argv.slice(2), { cwd = process.cwd(), run = runWalk } = {}) {
  const { values } = parseArgs({ args: argv, options: {
    'app-config': { type: 'string' }, surface: { type: 'string', default: 'web' },
    out: { type: 'string' }, 'base-url': { type: 'string' },
  } });
  if (!values['app-config'] || !values.out) throw new Error('usage: --app-config certification/app.json --surface web --out DIR [--base-url URL]');
  const { config, errors } = loadConfig(cwd, values['app-config']);
  errors.push(...validateConfig(config, { cwd }).errors);
  if (errors.length) throw new Error(errors.join('; '));
  const result = await run({ cwd, config, surface: values.surface, outDir: resolve(cwd, values.out),
    baseUrl: values['base-url'] ?? config.goldenPath.baseUrl ?? process.env.CERT_BASE_URL });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.status === 'passed' ? 0 : 1;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await main(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
