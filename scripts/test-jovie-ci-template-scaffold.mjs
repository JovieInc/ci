#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = resolve(import.meta.dirname, '..');
const bootstrap = resolve(root, 'templates/jovie-ci-release-prevention/bootstrap.mjs');
const ref = '76dff6c43dd9f5871e93dcf92775325cfd6f6552';
const temp = await mkdtemp(resolve(tmpdir(), 'ci-scaffold-'));
const project = resolve(temp, 'project');
const run = (args, cwd = root) => {
  const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8' });
  if (result.error) throw result.error;
  return result;
};
const install = (target, pin = ref) => run([bootstrap, '--target', target, '--ci-ref', pin]);
const verify = () => run(['scripts/verify-ci-release-incidents.mjs', '--config', '.github/ci-release-prevention.json'], project);
try {
  assert.notEqual(install(project, 'v1').status, 0, 'moving tags refused');
  assert.equal(install(project).status, 0);
  const workflow = await readFile(resolve(project, '.github/workflows/ci-release-prevention.yml'), 'utf8');
  assert.ok(workflow.includes(`verify-ci-release-prevention.yml@${ref}`));
  const baseline = verify();
  assert.equal(baseline.status, 0, baseline.stderr);
  assert.match(baseline.stdout, /does not execute or certify/);
  const ledgerPath = resolve(project, 'ci-release/incidents.json');
  const initial = JSON.parse(await readFile(ledgerPath, 'utf8'));
  for (const change of [
    x => { delete x.incidents[0].postmortem; },
    x => { x.incidents = []; },
    x => { x.incidents.push(x.incidents[0]); },
    x => { x.incidents[0].invariant = true; },
    x => { x.incidents[0].regression = '../outside'; },
    x => { x.incidents[0].postmortem = 'docs'; },
    x => { x.incidents[0].template_propagation.bootstrap = 'wrong'; },
  ]) {
    const changed = structuredClone(initial); change(changed);
    await writeFile(ledgerPath, JSON.stringify(changed));
    assert.notEqual(verify().status, 0);
  }
  await writeFile(ledgerPath, JSON.stringify(initial));
  const postmortem = resolve(project, initial.incidents[0].postmortem);
  await rm(postmortem);
  await writeFile(resolve(temp, 'outside.md'), 'external');
  await symlink(resolve(temp, 'outside.md'), postmortem);
  assert.notEqual(verify().status, 0, 'external evidence symlink refused');
  assert.notEqual(install(project).status, 0, 'existing files preserved');
  const unsafe = resolve(temp, 'unsafe');
  await symlink(project, unsafe);
  assert.notEqual(install(unsafe).status, 0, 'symlink destination refused');
  console.log('Fresh scaffold passes; malformed metadata, floating pins, overwrites and symlink escapes fail closed.');
} finally { await rm(temp, { recursive: true, force: true }); }
