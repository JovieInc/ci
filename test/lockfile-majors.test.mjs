import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { majorKey, parseLockfile, resolutionDiff, manifestSpecifiers, looseDiff,
  isLoose, declarations, levenshtein } from '../guards/lib/lockfile.mjs';
import { run, name } from '../guards/plugins/lockfile-majors.mjs';

const NOW = Date.parse('2026-11-19T12:00:00Z');
const OLD = '2026-01-01T00:00:00Z';
const json = JSON.stringify;
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
function write(cwd, files) {
  for (const [path, value] of Object.entries(files)) {
    if (value === null) { rmSync(join(cwd, path), { force: true }); continue; }
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), value);
  }
}
function fixture(t, before, after) {
  const cwd = mkdtempSync(join(tmpdir(), 'lockfile-majors-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  git(cwd, 'init', '-q', '-b', 'main');
  git(cwd, 'config', 'user.email', 'test@example.invalid');
  git(cwd, 'config', 'user.name', 'fixture');
  git(cwd, 'config', 'commit.gpgsign', 'false');
  write(cwd, { 'note.txt': 'base\n', ...before });
  git(cwd, 'add', '-A'); git(cwd, 'commit', '-qm', 'base');
  const base = git(cwd, 'rev-parse', 'HEAD');
  write(cwd, after);
  git(cwd, 'add', '-A'); git(cwd, 'commit', '--allow-empty', '-qm', 'head');
  return { cwd, base, env: { GITHUB_EVENT_NAME: 'pull_request', SIZE_BASE_SHA: base } };
}
const lock = (deps, extra = {}) => json({ lockfileVersion: 3, packages: {
  '': { dependencies: deps }, ...Object.fromEntries(Object.entries(deps).map(([n, v]) => [`node_modules/${n}`, { version: v }])), ...extra,
} });
const files = (deps, extra) => ({ 'package.json': json({ dependencies: deps }), 'package-lock.json': lock(deps, extra) });
const fetchOld = async () => ({ ok: true, json: async () => ({ time: new Proxy({}, { get: () => OLD }) }) });
const check = (f, env = {}, options = {}) => run({ ...f, env: { ...f.env, ...env }, now: NOW, fetch: fetchOld, ...options });

test('major keys use first nonzero semver component; protocols ignored', () => {
  for (const [v, key] of [['1.2.3', '1'], ['0.47.7', '0.47'], ['0.0.5', '0.0.5'], ['1.0.0-rc.1', '1'], ['v2.1.0', '2']])
    assert.equal(majorKey(v), key);
  for (const v of ['file:foo', 'link:../foo', 'git+https://x', '1.2', '01.2.3']) assert.equal(majorKey(v), null);
});
test('pnpm v9 mapping extracts scoped names, quoted peers, snapshots and importers', () => {
  const parsed = parseLockfile('pnpm-lock.yaml', `lockfileVersion: '9.0'
overrides:
  'foo@<2': 1.2.3
importers:
  .:
    dependencies:
      '@scope/pkg':
        specifier: 1.2.3
        version: 1.2.3(react@19.0.0)
  apps/web:
    devDependencies:
      foo: {specifier: 0.47.7, version: 0.47.7}
packages:
  '@scope/pkg@1.2.3': {}
  foo@0.47.7: {}
snapshots:
  '@scope/pkg@1.2.3(react@19.0.0)': {}
  'foo@0.47.7': {}
  'local@file:../foo': {}
  'local@file:../foo/1.2.3': {}
  'git@git+https://github.com/org/repo/1.2.3': {}
`);
  assert.deepEqual(parsed.resolutions, [{ name: '@scope/pkg', version: '1.2.3' }, { name: 'foo', version: '0.47.7' }]);
  assert.equal(parsed.importers['.']['@scope/pkg'].specifier, '1.2.3');
  assert.equal(parsed.importers['apps/web'].foo.version, '0.47.7');
  assert.equal(parsed.overrides['foo@<2'], '1.2.3');
});
test('pnpm v6 leading slashes, nested direct deps and legacy specifiers', () => {
  const parsed = parseLockfile('pnpm-lock.yaml', `lockfileVersion: '6.0'
importers:
  .:
    optionalDependencies:
      foo:
        specifier: 1.2.3
        version: 1.2.3(react@19.0.0)
packages:
  /foo@1.2.3(react@19.0.0): {}
  /@scope/pkg@0.0.5: {}
  /old/2.3.4: {}
`);
  assert.equal(parsed.resolutions.length, 3);
  assert.equal(parsed.importers['.'].foo.version, '1.2.3');
  const legacy = parseLockfile('pnpm-lock.yaml', 'specifiers:\n  foo: 1.2.3\ndependencies:\n  foo: 1.2.3\n');
  assert.equal(legacy.importers['.'].foo.specifier, '1.2.3');
  const underscore = parseLockfile('pnpm-lock.yaml', 'packages:\n  /foo_bar@1.0.0_react@19.0.0: {}\n');
  assert.deepEqual(underscore.resolutions, [{ name: 'foo_bar', version: '1.0.0' }]);
});
test('npm lock parsers include nested resolutions and workspace direct dependencies', () => {
  const p = parseLockfile('npm-shrinkwrap.json', lock({ foo: '1.0.0' }, {
    'node_modules/a/node_modules/foo': { version: '2.0.0' },
    'node_modules/linked': { version: 'file:../linked' },
    'apps/web': { devDependencies: { '@scope/pkg': '3.0.0' } },
    'node_modules/@scope/pkg': { version: '3.0.0' },
  }));
  assert.deepEqual(p.resolutions.map((v) => `${v.name}@${v.version}`), ['foo@1.0.0', 'foo@2.0.0', '@scope/pkg@3.0.0']);
  assert.equal(p.importers['apps/web']['@scope/pkg'].specifier, '3.0.0');
});
test('diff accepts existing major keys but detects new 0.x and 0.0.x keys', () => {
  const p = (version) => ({ name: 'foo', version });
  assert.equal(resolutionDiff([p('1.0.0'), p('2.0.0')], [p('2.4.0')]).majors.length, 0);
  assert.equal(resolutionDiff([p('0.47.7')], [p('0.48.0')]).majors.length, 1);
  assert.equal(resolutionDiff([p('0.0.5')], [p('0.0.6')]).majors.length, 1);
});
test('declaration parser tolerates bullets, backticks and whitespace, preserves invalid declarations', () => {
  const d = declarations('- `Dependency-Upgrade: @scope/pkg  1.0.0 -> 2.0.0`\n* `Dependency-Add: foo`\nDependency-Add: foo extra\ndependency-add: ignored');
  assert.equal(d.length, 3); assert.equal(d[0].to, '2.0.0'); assert.equal(d[1].name, 'foo'); assert.equal(d[2].name, undefined);
});
test('loose specifier classifier and recursive overrides are diff-based', () => {
  for (const v of ['^1.0.0', '~1.0.0', '>1', '>=1', '<2', '*', '1.x', 'latest', '1 || 2', '1 - 2',
    'git+https://x', 'https://x', 'github:org/repo', 'npm:foo@^1.0.0']) assert.equal(isLoose(v), true, v);
  for (const v of ['1.2.3', '0.0.5-rc.1', 'workspace:*', 'catalog:', 'link:..', 'file:..', 'npm:@scope/pkg@1.0.0'])
    assert.equal(isLoose(v), false, v);
  const before = manifestSpecifiers('package.json', json({ dependencies: { debt: '^1.0.0' } }));
  const after = manifestSpecifiers('package.json', json({ dependencies: { debt: '^1.0.0' }, overrides: { foo: { '.': '^2' } },
    pnpm: { overrides: { bar: '~3' } }, resolutions: { baz: '*' } }));
  assert.deepEqual(looseDiff(before, after).added.map(([k]) => k).sort(), ['overrides/foo/.', 'pnpm.overrides/bar', 'resolutions/baz']);
  assert.equal(looseDiff(before, after).count, 4);
});
test('MAJOR deliberate red -> matching declaration green; stale and wrong declarations fail', async (t) => {
  const f = fixture(t, files({ alpha: '1.2.3' }), files({ alpha: '2.0.0' }));
  assert.match((await check(f)).fails.join('\n'), /MAJOR: package-lock.json: alpha 1.2.3 -> 2.0.0/);
  assert.deepEqual((await check(f, { PR_BODY: '- `Dependency-Upgrade: alpha 1.2.3 -> 2.0.0`' })).fails, []);
  for (const body of ['Dependency-Upgrade: alpha 1.0.0 -> 2.0.0', 'Dependency-Upgrade: alpha 1.2.3 -> 3.0.0', 'Dependency-Add: absent'])
    assert.match((await check(f, { PR_BODY: body })).fails.join('\n'), /stale\/incorrect declaration/);
});
test('every new major must be declared, even with a retained base version', async (t) => {
  const f = fixture(t, files({ alpha: '1.0.0' }), files({ alpha: '1.0.0' }, {
    'node_modules/b/node_modules/alpha': { version: '2.0.0' }, 'node_modules/c/node_modules/alpha': { version: '3.0.0' },
  }));
  const r = await check(f, { PR_BODY: 'Dependency-Upgrade: alpha 1.0.0 -> 2.0.0' });
  assert.equal(r.fails.length, 1); assert.match(r.fails[0], /-> 3.0.0/);
});
test('new importer dependency requires add; near-name declared addition is red unless old name removed', async (t) => {
  assert.equal(levenshtein('alpha', 'alhpa'), 2);
  const f = fixture(t, files({ alpha: '1.0.0' }), files({ alpha: '1.0.0', alhpa: '1.0.0' }));
  assert.match((await check(f)).fails.join('\n'), /NEW TOP-LEVEL:.*alhpa.*needs Dependency-Add/);
  assert.match((await check(f, { PR_BODY: 'Dependency-Add: alhpa' })).fails.join('\n'), /typosquat.*alpha/);
  const rename = fixture(t, files({ alpha: '1.0.0' }), files({ alhpa: '1.0.0' }));
  assert.deepEqual((await check(rename, { PR_BODY: 'Dependency-Add: alhpa' })).fails, []);
});
test('brand new package is declared as add; existing transitive becoming direct also needs add', async (t) => {
  const f = fixture(t, files({}, { 'node_modules/beta': { version: '1.0.0' } }), files({ beta: '1.0.0' }));
  assert.match((await check(f)).fails.join('\n'), /NEW TOP-LEVEL/);
  assert.deepEqual((await check(f, { PR_BODY: 'Dependency-Add: beta' })).fails, []);
});
test('LOOSE deliberate red: new/changed ranges fail while unchanged debt only warns', async (t) => {
  const initial = files({ alpha: '1.0.0' });
  initial['package.json'] = json({ dependencies: { alpha: '1.0.0' }, resolutions: { debt: '^1' } });
  const f = fixture(t, initial, { 'package.json': json({ dependencies: { alpha: '1.0.0' }, resolutions: { debt: '^1', newer: '*' } }) });
  const r = await check(f);
  assert.equal(r.fails.length, 1); assert.match(r.fails[0], /LOOSE:.*newer.*\*/);
  assert.ok(r.warnings.includes('package.json: 2 remaining loose specifiers'));
  const green = fixture(t, initial, { 'package.json': json({ dependencies: { alpha: '1.0.0' }, resolutions: { debt: '^1' }, private: true }) });
  assert.deepEqual((await check(green)).fails, []);
});
test('pnpm workspace overrides ratchet detects new loose values', async (t) => {
  const f = fixture(t, { 'pnpm-workspace.yaml': 'overrides:\n  alpha: ^1\n' }, { 'pnpm-workspace.yaml': 'overrides:\n  alpha: ^1\n  beta: latest\n' });
  const r = await check(f); assert.equal(r.fails.length, 1); assert.match(r.fails[0], /LOOSE: pnpm-workspace.yaml: overrides\/beta/);
});
test('LOCKFILE deliberate reds: missing lock, unchanged lock, mismatching importer, missing importer', async (t) => {
  const cases = [
    [{}, { 'package.json': json({ dependencies: { alpha: '1.0.0' } }) }],
    [files({ alpha: '1.0.0' }), { 'package.json': json({ dependencies: { alpha: '1.1.0' } }) }],
    [files({ alpha: '1.0.0' }), { ...files({ alpha: '1.1.0' }), 'package.json': json({ dependencies: { alpha: '1.2.0' } }) }],
    [files({}), { 'apps/new/package.json': json({ dependencies: { alpha: '1.0.0' } }) }],
  ];
  for (const [before, after] of cases) assert.match((await check(fixture(t, before, after))).fails.join('\n'), /LOCKFILE:.*lockfile missing or out of date/);
});
test('pnpm importer finds its root lock through the directory chain', async (t) => {
  const pnpm = (version) => `lockfileVersion: '9.0'\nimporters:\n  apps/web:\n    dependencies:\n      alpha:\n        specifier: ${version}\n        version: ${version}\npackages:\n  alpha@${version}: {}\n`;
  const manifest = (v) => json({ dependencies: { alpha: v } });
  const f = fixture(t, { 'apps/web/package.json': manifest('1.0.0'), 'pnpm-lock.yaml': pnpm('1.0.0') },
    { 'apps/web/package.json': manifest('1.1.0'), 'pnpm-lock.yaml': pnpm('1.1.0') });
  assert.deepEqual((await check(f)).fails, []);
});
test('adding an existing package to another workspace importer still needs a declaration', async (t) => {
  const pnpm = (add) => `lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      alpha:\n        specifier: 1.0.0\n        version: 1.0.0\n  apps/web:\n${add ? '    devDependencies:\n      alpha:\n        specifier: 1.0.0\n        version: 1.0.0\n' : '    dependencies: {}\n'}packages:\n  alpha@1.0.0: {}\n`;
  const f = fixture(t, { 'package.json': json({ dependencies: { alpha: '1.0.0' } }), 'apps/web/package.json': '{}', 'pnpm-lock.yaml': pnpm(false) },
    { 'apps/web/package.json': json({ devDependencies: { alpha: '1.0.0' } }), 'pnpm-lock.yaml': pnpm(true) });
  assert.match((await check(f)).fails.join('\n'), /NEW TOP-LEVEL: pnpm-lock.yaml \(apps\/web\): alpha/);
  assert.deepEqual((await check(f, { PR_BODY: 'Dependency-Add: alpha' })).fails, []);
});
test('dependency sections and package overrides all ratchet; shrinkwrap counts as a lock', async (t) => {
  const before = { 'package.json': '{}', 'npm-shrinkwrap.json': lock({}) };
  const after = { 'package.json': json({ devDependencies: { beta: 'workspace:*' }, optionalDependencies: { gamma: 'npm:gamma@1.0.0' },
    overrides: { root: '*' }, pnpm: { overrides: { nested: '^1' } }, resolutions: { last: 'latest' } }),
  'npm-shrinkwrap.json': json({ lockfileVersion: 3, packages: { '': { devDependencies: { beta: 'workspace:*' }, optionalDependencies: { gamma: 'npm:gamma@1.0.0' } } } }) };
  const f = fixture(t, before, after);
  const r = await check(f, { PR_BODY: 'Dependency-Add: beta\nDependency-Add: gamma' });
  assert.equal(r.fails.length, 3); assert.ok(r.fails.every((f) => f.startsWith('LOOSE:')));
});
test('AGE red before green: young versions fail, exactly 3 days passes, encoded scope fetched once', async (t) => {
  const f = fixture(t, files({ '@scope/alpha': '1.0.0' }), files({ '@scope/alpha': '1.1.0' }, {
    'node_modules/z/node_modules/@scope/alpha': { version: '1.2.0' },
  }));
  let calls = 0;
  const fetch = async (url, options) => {
    calls++; assert.equal(url, 'https://registry.npmjs.org/%40scope%2Falpha'); assert.ok(options.signal);
    return { ok: true, json: async () => ({ time: { '1.1.0': new Date(NOW - 2 * 86400_000).toISOString(), '1.2.0': new Date(NOW - 3 * 86400_000).toISOString() } }) };
  };
  const r = await check(f, {}, { fetch });
  assert.equal(calls, 1); assert.equal(r.fails.length, 1); assert.match(r.fails[0], /AGE:.*1.1.0.*younger than 3 days/);
});
test('AGE registry errors, absent release time and timeout fail closed per resolution', async (t) => {
  const f = fixture(t, files({ alpha: '1.0.0' }), files({ alpha: '1.1.0' }));
  const responses = [async () => { throw Error('unavailable'); }, async () => ({ ok: false, status: 503 }),
    async () => ({ ok: true, json: async () => ({ time: {} }) }), async () => new Promise(() => {})];
  for (const fetch of responses) assert.match((await check(f, {}, { fetch, timeoutMs: 5 })).fails.join('\n'), /registry unreachable; fail closed for dependency changes/);
});
test('security-advisory exempts AGE only; 401 resolutions hit cap before fetching', async (t) => {
  const f = fixture(t, files({ alpha: '1.0.0' }), files({ alpha: '2.0.0' }));
  const fetch = () => { assert.fail('no network expected'); };
  const r = await check(f, { PR_LABELS: '["security-advisory"]' }, { fetch });
  assert.equal(r.fails.length, 1); assert.match(r.fails[0], /MAJOR/);
  const extra = Object.fromEntries(Array.from({ length: 401 }, (_, i) => [`node_modules/pkg-${i}`, { version: '1.0.0' }]));
  const large = fixture(t, files({}), files({}, extra));
  assert.deepEqual((await check(large, {}, { fetch })).fails, ['AGE: too many new resolutions to age-check; split the PR']);
  assert.deepEqual((await check(large, { PR_LABELS: '["security-advisory"]' }, { fetch })).fails, []);
});
test('registry fetch concurrency is capped at eight', async (t) => {
  const extra = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`node_modules/pkg-${i}`, { version: '1.0.0' }]));
  const f = fixture(t, files({}), files({}, extra));
  let active = 0, max = 0, count = 0;
  const fetch = async () => {
    count++; max = Math.max(max, ++active);
    await new Promise((resolve) => setTimeout(resolve, 3)); active--;
    return fetchOld();
  };
  assert.deepEqual((await check(f, {}, { fetch })).fails, []); assert.equal(max, 8); assert.equal(count, 17);
});
test('eve major jumps load the migration gate and warn even when declared', async (t) => {
  const f = fixture(t, files({ eve: '0.47.7' }), files({ eve: '1.0.0' }));
  const r = await check(f, { PR_BODY: 'Dependency-Upgrade: eve 0.47.7 -> 1.0.0' });
  assert.deepEqual(r.fails, []);
  assert.ok(r.warnings.includes('migration-gated: eve 0.47.7 -> 1.0.0 requires probe scripts/qualification/eve-legacy-import.mjs exit 0 (JOV-9613)'));
});
test('skip contexts and unrelated diffs have no network or manifest reads; empty PR_BODY opts in', async (t) => {
  const f = fixture(t, { 'package.json': '{broken' }, { 'note.txt': 'head' });
  const fetch = () => assert.fail('no network expected');
  assert.deepEqual(await check(f, {}, { fetch }), { fails: [], warnings: [] });
  for (const GITHUB_EVENT_NAME of ['push', 'merge_group', 'workflow_dispatch', undefined]) {
    const env = { GITHUB_EVENT_NAME, ...(GITHUB_EVENT_NAME === 'push' ? { PR_BODY: '' } : {}) };
    assert.deepEqual(await run({ cwd: '/missing', env, fetch }), { fails: [], warnings: [] });
  }
  const changed = fixture(t, files({ alpha: '1.0.0' }), files({ alpha: '2.0.0' }));
  assert.match((await check(changed, { GITHUB_EVENT_NAME: undefined, PR_BODY: '' })).fails.join('\n'), /MAJOR/);
  assert.match((await check(changed, { GITHUB_EVENT_NAME: 'pull_request_target' })).fails.join('\n'), /MAJOR/);
});
test('unavailable base warns once, internal parsing errors never throw', async (t) => {
  const f = fixture(t, files({}), { 'package.json': '{broken' });
  const r = await check(f, { SIZE_BASE_SHA: 'missing' });
  assert.deepEqual(r.fails, []); assert.equal(r.warnings.length, 1); assert.match(r.warnings[0], /base unavailable/);
  assert.match((await check(f)).warnings[0], /lockfile-majors: internal error/);
  assert.match((await check(f, { SIZE_BASE_SHA: '' })).warnings[0], /base unavailable/);
});
test('merge commit first parent is the default hermetic PR base', async (t) => {
  const f = fixture(t, files({ alpha: '1.0.0' }), files({ alpha: '2.0.0' }));
  git(f.cwd, 'branch', 'pr'); git(f.cwd, 'checkout', '-q', '-b', 'base', f.base);
  write(f.cwd, { 'other.txt': 'main change' }); git(f.cwd, 'add', '-A'); git(f.cwd, 'commit', '-qm', 'base moves');
  git(f.cwd, 'merge', '--no-ff', '-qm', 'merge PR', 'pr');
  assert.match((await check(f, { SIZE_BASE_SHA: '' })).fails.join('\n'), /MAJOR/);
});
test('plugin remains shadow and every plugin module exports name/run', async () => {
  const registry = JSON.parse((await import('node:fs')).readFileSync(new URL('../canon/guards.json', import.meta.url), 'utf8'));
  assert.equal(name, 'lockfile-majors'); assert.equal(registry.guards.find((g) => g.id === name).mode, 'shadow');
  const { readdirSync } = await import('node:fs');
  for (const file of readdirSync(new URL('../guards/plugins/', import.meta.url)).filter((p) => p.endsWith('.mjs'))) {
    const module = await import(new URL(`../guards/plugins/${file}`, import.meta.url));
    assert.equal(typeof module.name, 'string'); assert.equal(typeof module.run, 'function');
  }
});
test('real runner downgrades a deliberate MAJOR violation to a warning while shadowed', (t) => {
  const f = fixture(t, { ...files({ alpha: '1.0.0' }), 'AGENTS.md': 'Company canon: JovieInc/ci canon/COMPANY.md\n' }, files({ alpha: '2.0.0' }));
  const result = spawnSync(process.execPath, [new URL('../guards/run.mjs', import.meta.url).pathname], {
    cwd: f.cwd, encoding: 'utf8', env: { PATH: process.env.PATH, ...f.env, PR_BODY: '',
      PR_LABELS: '["security-advisory"]', GITHUB_REPOSITORY: 'JovieInc/fixture' },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /::warning::lockfile-majors: MAJOR: package-lock.json: alpha/);
  assert.match(result.stdout, /company-guards: ok \(0\)/);
});

// Regressions found replaying real Jovie dependency commits (JOV-13093 simulation).
test('ratchet: an existing loose entry may move, an exact one may not turn loose', () => {
  const before = { 'dependencies/lucide-react': '^1.70.0', 'dependencies/zod': '4.3.6' };
  const bump = { 'dependencies/lucide-react': '^1.72.0', 'dependencies/zod': '4.3.6' };
  assert.deepEqual(looseDiff(before, bump).added, []);
  const loosened = { 'dependencies/lucide-react': '^1.70.0', 'dependencies/zod': '^4.3.6' };
  assert.deepEqual(looseDiff(before, loosened).added.map(([k]) => k), ['dependencies/zod']); // deliberate red
});

test('override keys resolve to the overridden package name', async () => {
  const { overrideTarget } = await import('../guards/plugins/lockfile-majors.mjs');
  assert.deepEqual(['sharp', 'react@19', 'a>ws', '@scope/x@^1', '@modelcontextprotocol/sdk'].map(overrideTarget),
    ['sharp', 'react', 'ws', '@scope/x', '@modelcontextprotocol/sdk']);
});
