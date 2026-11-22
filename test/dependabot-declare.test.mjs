import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { augmentBody, declarations, gated } from '../scripts/dependabot-declare.mjs';

const update = (dependencyName, prevVersion, newVersion, updateType = 'version-update:semver-major') =>
  ({ dependencyName, prevVersion, newVersion, updateType });
const eveGate = {
  package: 'eve', linear: 'JOV-9613', requiredExit: 0,
  probe: { repo: 'JovieInc/summer-config', script: 'scripts/qualification/eve-legacy-import.mjs' },
};

test('declares major-key changes, sorted and de-duplicated', () => {
  const eve = update('eve', '0.47.7', '1.1.0');
  assert.deepEqual(declarations([
    update('zod', '3.25.0', '4.0.0'), eve, eve,
    update('@company/alpha', '1.2.3', '2.0.0'),
    update('zero', '0.0.5', '0.0.6', 'version-update:semver-patch'),
  ]), [
    'Dependency-Upgrade: @company/alpha 1.2.3 -> 2.0.0',
    'Dependency-Upgrade: eve 0.47.7 -> 1.1.0',
    'Dependency-Upgrade: zero 0.0.5 -> 0.0.6',
    'Dependency-Upgrade: zod 3.25.0 -> 4.0.0',
  ]);
});

test('deliberate-red regression: a 0.x minor MUST produce a declaration', () => {
  assert.deepEqual(declarations([
    update('eve', '0.27.13', '0.28.0', 'version-update:semver-minor'),
  ]), ['Dependency-Upgrade: eve 0.27.13 -> 0.28.0']);
});

test('does not declare updates within a major key or non-semver versions', () => {
  assert.deepEqual(declarations([
    update('minor', '1.2.3', '1.3.0', 'version-update:semver-minor'),
    update('patch', '1.2.3', '1.2.4', 'version-update:semver-patch'),
    update('zero-minor', '0.47.7', '0.47.8'),
    update('prerelease', 'v1.2.3-beta.1', 'v1.2.3+build.2'),
    update('unchanged', '0.0.5', '0.0.5'),
    update('git', 'abc123', 'def456'),
    update('unknown', null, '1.0.0'),
  ]), []);
  assert.deepEqual(declarations([]), []);
});

test('handles zero keys, pre-releases, and build metadata', () => {
  assert.deepEqual(declarations([
    update('eve', 'v0.47.7-beta.1+old', 'v1.1.0-rc.1+new'),
    update('initial', '0.0.0', '0.0.1'),
  ]), [
    'Dependency-Upgrade: eve v0.47.7-beta.1+old -> v1.1.0-rc.1+new',
    'Dependency-Upgrade: initial 0.0.0 -> 0.0.1',
  ]);
});

test('detects gates only for exact package matches with major-key changes', () => {
  const updated = [update('eve', '0.27.13', '0.28.0'), update('other', '1.0.0', '2.0.0')];
  const unmatched = { ...eveGate, package: 'eve-extra' };
  assert.deepEqual(gated(updated, [eveGate, unmatched]), [eveGate]);
  assert.deepEqual(gated([update('eve', '0.47.7', '0.47.8')], [eveGate]), []);
  assert.deepEqual(gated(updated, []), []);
  assert.deepEqual(gated(updated), []);
});

test('augmentBody is idempotent and replaces stale blocks without losing PR text', () => {
  const lines = declarations([update('eve', '0.47.7', '1.1.0')]);
  const body = 'Dependabot release notes\n\n<!-- jov-13093:declare -->\nstale\n<!-- /jov-13093:declare -->';
  const augmented = augmentBody(body, lines, [eveGate]);
  assert.equal(augmented, [
    'Dependabot release notes', '', '<!-- jov-13093:declare -->', 'Refs JOV-13093',
    'Dependency-Upgrade: eve 0.47.7 -> 1.1.0',
    'Migration-Gate: eve requires scripts/qualification/eve-legacy-import.mjs in JovieInc/summer-config exit 0 (JOV-9613)',
    '<!-- /jov-13093:declare -->', '',
  ].join('\n'));
  assert.equal(augmentBody(augmented, lines, [eveGate]), augmented);
  assert.equal((augmented.match(/<!-- jov-13093:declare -->/g) || []).length, 1);
});

test('augmentBody refreshes gates and handles empty bodies and patch/minor updates', () => {
  const before = augmentBody('Release notes', declarations([update('eve', '0.47.7', '1.1.0')]), [eveGate]);
  const after = augmentBody(before, [], []);
  assert.equal(after, 'Release notes\n\n<!-- jov-13093:declare -->\nRefs JOV-13093\n<!-- /jov-13093:declare -->\n');
  const empty = augmentBody('', [], []);
  assert.equal(empty, '<!-- jov-13093:declare -->\nRefs JOV-13093\n<!-- /jov-13093:declare -->\n');
  assert.equal(augmentBody(empty, [], []), empty);
});

test('CLI writes declarations and a summary, accepts missing gates, and rejects malformed gates', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dependabot-declare-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const files = Object.fromEntries(['updated', 'body', 'gates', 'out'].map((key) => [key, join(dir, key)]));
  writeFileSync(files.updated, JSON.stringify([update('eve', '0.27.13', '0.28.0')]));
  writeFileSync(files.body, 'Release notes');
  const run = () => spawnSync(process.execPath, [
    fileURLToPath(new URL('../scripts/dependabot-declare.mjs', import.meta.url)),
    ...Object.entries(files).flatMap(([key, file]) => [`--${key}`, file]),
  ], { encoding: 'utf8' });
  const missing = run();
  assert.equal(missing.status, 0, missing.stderr);
  assert.deepEqual(JSON.parse(missing.stdout), {
    declarations: 1, gated: [],
    updates: [{ dependencyName: 'eve', prevVersion: '0.27.13', newVersion: '0.28.0' }],
  });
  const withoutGates = readFileSync(files.out, 'utf8');
  assert.match(withoutGates, /Dependency-Upgrade: eve 0\.27\.13 -> 0\.28\.0/);
  assert.doesNotMatch(withoutGates, /Migration-Gate:/);
  writeFileSync(files.gates, JSON.stringify({ schema: 'dependency-migration-gates/v1', gates: [eveGate] }));
  const withGates = run();
  assert.equal(withGates.status, 0, withGates.stderr);
  assert.deepEqual(JSON.parse(withGates.stdout).gated, ['eve']);
  assert.match(readFileSync(files.out, 'utf8'), /Migration-Gate: eve requires/);
  writeFileSync(files.gates, '{broken json');
  assert.equal(run().status, 1);
  writeFileSync(files.gates, '{}');
  assert.equal(run().status, 1);
});
