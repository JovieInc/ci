#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, validateConfig } from '../config.mjs';
import { evaluate, fixProposals } from './run.mjs';
import { calibrate } from './calibrate.mjs';
import { buyerReady } from './gate.mjs';
import { readReceipts, stateDir } from './store.mjs';
import { gateDecision } from '../judge/receipt.mjs';

export async function main(argv = process.argv.slice(2), { cwd = process.cwd(), evaluateRun = evaluate, calibrateRun = calibrate } = {}) {
  const [command, ...args] = argv;
  const { values } = parseArgs({ args, options: {
    'app-config': { type: 'string' }, walk: { type: 'string' }, persona: { type: 'string' },
    samples: { type: 'string', default: '3' }, sha: { type: 'string' }, subject: { type: 'string' },
    cert: { type: 'string' }, 'tim-yes': { type: 'boolean', default: false },
    'was-ready': { type: 'boolean', default: false },
  } });
  if (!['run', 'gate', 'calibrate'].includes(command) || !values['app-config']) throw new Error('usage: buyer/cli.mjs run|gate|calibrate --app-config certification/app.json');
  const { config, errors } = loadConfig(cwd, values['app-config']);
  errors.push(...validateConfig(config, { cwd }).errors);
  if (errors.length) throw new Error(errors.join('; '));
  let result, passed;
  if (command === 'run') {
    if (!values.walk || !values.persona) throw new Error('run needs --walk and --persona');
    result = await evaluateRun({ cwd, config, walk: resolve(cwd, values.walk), persona: values.persona,
      samples: Number(values.samples), sha: values.sha });
    result = { ...result, fixProposals: fixProposals(result) };
    passed = result.verdict === 'pay';
  } else if (command === 'calibrate') {
    result = await calibrateRun({ cwd, config, walk: values.walk, sha: values.sha, samples: Number(values.samples) });
    // Do not print private receipt content or persona briefs.
    result = { status: result.status, checks: result.checks };
    passed = result.status === 'passed';
  } else {
    if (!values.subject || !values.sha || !values.cert) throw new Error('gate needs --subject, --sha and --cert');
    const receipt = JSON.parse(readFileSync(resolve(cwd, values.cert), 'utf8'));
    const cert = gateDecision({ receipt, config, sourceSha: values.sha });
    result = buyerReady({ cwd, config, subject: values.subject, sha: values.sha, cert,
      receipts: readReceipts(stateDir(config)), timYes: values['tim-yes'], wasReady: values['was-ready'] });
    passed = result.ready;
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return passed ? 0 : 1;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await main(); }
  catch { console.error('buyer eval failed closed; inspect private input and configuration'); process.exitCode = 1; }
}
