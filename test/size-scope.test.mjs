import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, scopeFor } from '../guards/size.mjs';

const RUN = fileURLToPath(new URL('../guards/run.mjs', import.meta.url));
const lines = (n) => Array.from({ length: n }, (_, i) => `// ${i}`).join('\n') + '\n';
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

// Repo where touched.ts and untouched.ts are both baselined at 600 lines.
function fixture() {
  const d = mkdtempSync(join(tmpdir(), 'size-scope-'));
  git(d, 'init', '-q', '-b', 'main');
  git(d, 'config', 'user.email', 't@t.t');
  git(d, 'config', 'user.name', 't');
  writeFileSync(join(d, 'AGENTS.md'), 'JovieInc/ci canon/COMPANY.md\n');
  writeFileSync(join(d, 'touched.ts'), lines(600));
  writeFileSync(join(d, 'untouched.ts'), lines(600));
  mkdirSync(join(d, '.company-guards'));
  writeFileSync(join(d, '.company-guards/size-baseline.json'), JSON.stringify({ 'touched.ts': 600, 'untouched.ts': 600 }));
  git(d, 'add', '-A');
  git(d, 'commit', '-qm', 'base');
  return { d, base: git(d, 'rev-parse', 'HEAD') };
}
// main moved on: untouched.ts grew behind the PR's back.
function growOnMain(d) {
  writeFileSync(join(d, 'untouched.ts'), lines(620));
  git(d, 'commit', '-qam', 'main growth');
}
function guard(d, env) {
  const r = spawnSync('node', [RUN], { cwd: d, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, GITHUB_REPOSITORY: 'JovieInc/ci', ...env } });
  return { code: r.status, out: r.stdout + r.stderr };
}

test('check: scope splits fails from warnings', () => {
  const cur = { 'a.ts': 700, 'b.ts': 700 };
  const base = { 'a.ts': 600, 'b.ts': 600 };
  const r = check(cur, base, new Set(['a.ts']));
  assert.equal(r.fails.length, 1);
  assert.equal(r.warnings.length, 1);
  assert.equal(check(cur, base).fails.length, 2);
});

test('scopeFor: only pull_request and merge_group scope; push is repo-wide', () => {
  const { d, base } = fixture();
  writeFileSync(join(d, 'touched.ts'), lines(601));
  git(d, 'commit', '-qam', 'pr');
  assert.deepEqual([...scopeFor({ GITHUB_EVENT_NAME: 'pull_request', SIZE_BASE_SHA: base }, d)], ['touched.ts']);
  assert.deepEqual([...scopeFor({ GITHUB_EVENT_NAME: 'merge_group', SIZE_BASE_SHA: base }, d)], ['touched.ts']);
  assert.equal(scopeFor({ GITHUB_EVENT_NAME: 'push', SIZE_BASE_SHA: base }, d), null);
  assert.equal(scopeFor({ GITHUB_EVENT_NAME: 'pull_request' }, d), null, 'missing base fails closed to repo-wide');
  assert.equal(scopeFor({ GITHUB_EVENT_NAME: 'pull_request', SIZE_BASE_SHA: 'deadbeef' }, d), null, 'bad base fails closed');
});

for (const event of ['pull_request', 'merge_group']) {
  test(`${event}: growing a touched file is red`, () => {
    const { d, base } = fixture();
    writeFileSync(join(d, 'touched.ts'), lines(610));
    git(d, 'commit', '-qam', 'pr grows touched');
    const r = guard(d, { GITHUB_EVENT_NAME: event, SIZE_BASE_SHA: base });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /touched\.ts: grew 600 -> 610/);
  });

  test(`${event}: a grown file the change does not touch only warns`, () => {
    const { d, base } = fixture();
    growOnMain(d);
    writeFileSync(join(d, 'other.ts'), lines(10));
    git(d, 'add', '-A');
    git(d, 'commit', '-qm', 'pr adds small file');
    // base is the pre-growth commit's tree? No: base is the queue/PR base that already has the growth.
    const prBase = git(d, 'rev-parse', 'HEAD~1');
    const r = guard(d, { GITHUB_EVENT_NAME: event, SIZE_BASE_SHA: prBase });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /::warning::.*untouched\.ts: grew 600 -> 620/);
    void base;
  });
}

test('push to main: repo-wide and red on growth the commit did not touch', () => {
  const { d, base } = fixture();
  growOnMain(d);
  writeFileSync(join(d, 'other.ts'), lines(10));
  git(d, 'add', '-A');
  git(d, 'commit', '-qm', 'unrelated');
  const r = guard(d, { GITHUB_EVENT_NAME: 'push', SIZE_BASE_SHA: base });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /untouched\.ts: grew 600 -> 620/);
});

test('pull_request without a usable base fails closed (repo-wide)', () => {
  const { d } = fixture();
  growOnMain(d);
  const r = guard(d, { GITHUB_EVENT_NAME: 'pull_request' });
  assert.equal(r.code, 1, r.out);
});
