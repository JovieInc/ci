#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const ledger = JSON.parse(readFileSync('templates/jovie-ci-release-prevention/ledger.v1.json', 'utf8'));
const registry = JSON.parse(readFileSync('templates/jovie-ci-release-prevention/fixture-registry.v1.json', 'utf8'));
assert.equal(ledger.incidents.length, 39);
for (const event of ['pull_request', 'merge_group']) {
  const result = spawnSync(process.execPath, ['scripts/ci-release-prevention-dispatch.mjs', '--event', event], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /dispatched 39 bounded/);
}
for (const incident of ledger.incidents) {
  const result = spawnSync(process.execPath, ['scripts/fixtures/ci-release-prevention-cases.mjs', incident, '--negative'], { encoding: 'utf8', timeout: 5000 });
  assert.notEqual(result.status, 0, `negative recurrence must fail: ${incident}`);
}
for (const [id, metadata] of Object.entries(registry.incident_metadata)) {
  assert.ok(ledger.incidents.includes(id), `metadata incident must be in the canonical ledger: ${id}`);
  assert.ok(['pr', 'post-merge'].includes(metadata.ci_stage_owner), `${id} must declare a valid CI stage owner`);
  for (const field of ['operator_doc', 'postmortem', 'template_propagation']) assert.equal(typeof metadata[field], 'string', `${id} missing ${field}`);
  assert.equal(metadata.template_propagation, registry.generalizable_scaffold, `${id} must propagate through the canonical scaffold`);
}
console.log('fresh scaffold dispatch contract passed: two events and 39 negative cases');
