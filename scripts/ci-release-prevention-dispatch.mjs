#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = process.cwd();
const template = resolve(root, 'templates/jovie-ci-release-prevention');
const ledger = JSON.parse(readFileSync(resolve(template, 'ledger.v1.json'), 'utf8'));
const registry = JSON.parse(readFileSync(resolve(template, 'fixture-registry.v1.json'), 'utf8'));
const index = process.argv.indexOf('--event');
const event = index === -1 ? process.env.GITHUB_EVENT_NAME : process.argv[index + 1];
const dryRun = process.argv.includes('--dry-run');

if (!registry.events.includes(event)) throw new Error('event must be pull_request or merge_group');
if (ledger.incidents.length !== 48 || new Set(ledger.incidents).size !== 48) throw new Error('canonical ledger must contain exactly 48 unique incident IDs');
if (registry.required_incident_count !== ledger.incidents.length) throw new Error('fixture registry incident count does not match canonical ledger');
if (registry.runner !== 'node' || !Number.isInteger(registry.timeout_seconds) || registry.timeout_seconds < 1 || registry.timeout_seconds > 5) throw new Error('registry runner or timeout is invalid');
if (registry.fixture !== 'scripts/fixtures/ci-release-prevention-cases.mjs') throw new Error('registry fixture path is not canonical');

if (dryRun) {
  console.log(JSON.stringify({ event, hooks: ledger.incidents }));
  process.exit(0);
}
for (const incident of ledger.incidents) {
  const result = spawnSync(process.execPath, [registry.fixture, incident], { cwd: root, encoding: 'utf8', timeout: registry.timeout_seconds * 1000 });
  if (result.status !== 0 || result.error) throw new Error(`fixture failed: ${incident}: ${result.error?.message ?? result.stderr}`);
}
console.log(`dispatched ${ledger.incidents.length} bounded ${event} fixtures`);
