#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const ledger = JSON.parse(readFileSync('templates/jovie-ci-release-prevention/ledger.v1.json', 'utf8'));
assert.equal(ledger.incidents.length, 29);
for (const event of ['pull_request', 'merge_group']) {
  const result = spawnSync(process.execPath, ['scripts/ci-release-prevention-dispatch.mjs', '--event', event], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /dispatched 29 bounded/);
}
for (const incident of ledger.incidents) {
  const result = spawnSync(process.execPath, ['scripts/fixtures/ci-release-prevention-cases.mjs', incident, '--negative'], { encoding: 'utf8', timeout: 5000 });
  assert.notEqual(result.status, 0, `negative recurrence must fail: ${incident}`);
}
console.log('fresh scaffold dispatch contract passed: two events and 29 negative cases');
