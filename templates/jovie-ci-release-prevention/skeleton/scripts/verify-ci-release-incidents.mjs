#!/usr/bin/env node
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--config') throw new Error('usage: node verifier.mjs --config .github/ci-release-prevention.json');
const root = await realpath(process.cwd());
async function file(path, label) {
  if (typeof path !== 'string' || !path || isAbsolute(path) || path.includes('\\') || path.split('/').some(p => !p || p === '..' || p === '.')) throw new Error(`${label} must be a safe repository-relative path`);
  const full = resolve(root, path);
  const resolved = await realpath(full);
  if (relative(root, resolved).startsWith('..') || isAbsolute(relative(root, resolved)) || !(await lstat(full)).isFile()) throw new Error(`${label} must be a regular file within this repository`);
  return readFile(full, 'utf8');
}
function requireString(object, field, label) {
  if (typeof object?.[field] !== 'string' || !object[field].trim()) throw new Error(`${label}.${field} is required`);
}
const config = JSON.parse(await file(args[1], 'config'));
for (const field of ['contract', 'ledger', 'template', 'template_version', 'bootstrap', 'scaffold_proof']) requireString(config, field, 'config');
if (config.contract !== 'ci-release/v1') throw new Error('unsupported contract');
if (!/^[a-f0-9]{40}$/.test(config.template_version)) throw new Error('template_version must be a full commit SHA');
const ledger = JSON.parse(await file(config.ledger, 'ledger'));
if (!Array.isArray(ledger?.incidents) || !ledger.incidents.length) throw new Error('ledger must contain at least one incident');
const seen = new Set();
for (const incident of ledger.incidents) {
  for (const field of ['id', 'invariant', 'regression', 'ci_stage_owner', 'operator_doc', 'postmortem']) requireString(incident, field, 'incident');
  if (!/^ci-release\/[a-z0-9-]+$/.test(incident.id) || seen.has(incident.id)) throw new Error('incident ids must be unique ci-release/<slug> values');
  seen.add(incident.id);
  for (const field of ['template', 'bootstrap', 'scaffold_proof']) {
    if (incident.template_propagation?.[field] !== config[field]) throw new Error(`${incident.id}: template_propagation.${field} must match config.${field}`);
  }
  for (const field of ['regression', 'operator_doc', 'postmortem']) await file(incident[field], field);
}
console.log(`Incident metadata valid: ${seen.size} row(s). This does not execute or certify regressions.`);
