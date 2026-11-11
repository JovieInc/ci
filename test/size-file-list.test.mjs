import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, changedFiles } from '../guards/size.mjs';

const git = (cwd, args, input) => execFileSync('git', args, { cwd, encoding: 'utf8', input, maxBuffer: 1 << 28 }).trim();
const lines = (n) => Array.from({ length: n }, (_, i) => `// ${i}`).join('\n') + '\n';

function repo() {
  const d = mkdtempSync(join(tmpdir(), 'size-list-'));
  git(d, ['init', '-q', '-b', 'main']);
  git(d, ['config', 'user.email', 't@t.t']);
  git(d, ['config', 'user.name', 't']);
  mkdirSync(join(d, '.company-guards'));
  writeFileSync(join(d, '.company-guards/size-baseline.json'), '{}');
  return d;
}

// Index entries only (no working files): a tracked list over Node's 1 MiB
// default exec buffer, the size a large monorepo reaches.
function trackManyPaths(d, count) {
  const blob = git(d, ['hash-object', '-w', '--stdin'], '');
  const pad = 'p'.repeat(200);
  let info = '';
  for (let i = 0; i < count; i++) info += `100644 ${blob}\tbulk/${pad}/${i}.txt\n`;
  git(d, ['update-index', '--add', '--index-info'], info);
}

test('size-500 still runs when the tracked file list exceeds 1 MiB', () => {
  const d = repo();
  trackManyPaths(d, 5500);
  assert.ok(git(d, ['ls-files']).length > 1024 * 1024, 'fixture must exceed the default buffer');
  writeFileSync(join(d, 'big.ts'), lines(600));
  git(d, ['add', 'big.ts']);
  const r = run({ cwd: d });
  assert.deepEqual(r.fails, ['big.ts: 600 lines, over 500 and not baselined']);
});

test('size-500 measures non-ASCII paths instead of skipping them', () => {
  const d = repo();
  writeFileSync(join(d, 'über.ts'), lines(600));
  git(d, ['add', '-A']);
  const r = run({ cwd: d });
  assert.deepEqual(r.fails, ['über.ts: 600 lines, over 500 and not baselined']);
});

test('changedFiles returns non-ASCII paths unquoted', () => {
  const d = repo();
  git(d, ['add', '-A']);
  git(d, ['commit', '-qm', 'base']);
  const base = git(d, ['rev-parse', 'HEAD']);
  writeFileSync(join(d, 'ünï.ts'), 'x\n');
  git(d, ['add', '-A']);
  git(d, ['commit', '-qm', 'pr']);
  assert.deepEqual([...changedFiles(base, d)], ['ünï.ts']);
});
