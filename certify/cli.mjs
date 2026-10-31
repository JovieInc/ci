#!/usr/bin/env node
// certify CLI (canon/PUBLIC-APP-CERTIFICATION.md). Runs in an app checkout (cwd).
//   node certify/cli.mjs validate   strict: every registered app's config is valid and filled
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, validateConfig } from './config.mjs';
import { repoSlug } from '../guards/plugins/public-app-certification.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const registry = JSON.parse(readFileSync(join(HERE, '..', 'canon', 'public-apps.json'), 'utf8'));
const [cmd] = process.argv.slice(2);

if (cmd === 'validate') {
  const repo = repoSlug('.');
  const apps = registry.apps.filter((a) => a.repo.toLowerCase() === String(repo).toLowerCase() && a.stage !== 'dormant');
  const errors = [];
  const warnings = [];
  for (const app of apps) {
    // Same grace as the guard plugin: before enforceFrom, problems warn (default with a deadline).
    const grace = app.enforceFrom && Date.parse(app.enforceFrom) > Date.now();
    const sink = grace ? warnings : errors;
    const tag = grace ? `${app.id} (enforced from ${app.enforceFrom})` : app.id;
    const { config, errors: le } = loadConfig('.', app.config);
    sink.push(...le.map((x) => `${tag}: ${x}`));
    if (config) sink.push(...validateConfig(config, { cwd: '.', registryEntry: app }).errors.map((x) => `${tag}: ${x}`));
  }
  for (const w of warnings) console.log(`::warning::${w}`);
  for (const e of errors) console.error(`::error::${e}`);
  // Strict fold: a repo with no registered apps has nothing to certify, which is not a pass.
  if (!apps.length) { console.error(`::error::${repo}: no non-dormant app registered in canon/public-apps.json`); process.exit(1); }
  console.log(`certify validate: ${errors.length ? 'FAIL' : 'ok'} (${apps.length} app(s), ${errors.length} error(s), ${warnings.length} warning(s))`);
  process.exit(errors.length ? 1 : 0);
} else {
  console.error('usage: certify/cli.mjs validate');
  process.exit(2);
}
