// Behaviour tests: every rule has a deliberate-red fixture and a green twin.
// Needs typescript: set SLOP_TS_DIR to an installed typescript package directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRIPT = path.resolve(import.meta.dirname, 'slop-guard.mjs');
const tsDir = process.env.SLOP_TS_DIR ?? path.dirname(createRequire(import.meta.url).resolve('typescript/package.json'));
const git = (d, ...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: d, encoding: 'utf8' });

function repo(files, config = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slop-'));
  git(dir, 'init', '-q');
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.symlinkSync(tsDir, path.join(dir, 'node_modules', 'typescript'));
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules\nbuild-out\n');
  fs.writeFileSync(path.join(dir, 'package.json'), '{}');
  fs.mkdirSync(`${dir}-policy`);
  fs.writeFileSync(`${dir}-policy/policy.json`, JSON.stringify({ roots: ['src'], knip: false, jscpd: false, ...config }));
  put(dir, files);
  return dir;
}
function put(dir, files) {
  for (const [f, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), c);
  }
}
const run = (dir, ...a) => spawnSync('node', [SCRIPT, '--policy', `${dir}-policy/policy.json`, ...a], { cwd: dir, encoding: 'utf8' });
const commit = (d, m = 'c') => { git(d, 'add', '-A'); git(d, 'commit', '-qm', m); return git(d, 'rev-parse', 'HEAD').trim(); };
const lines = (n) => 'export const x = 1;\n'.repeat(n);
const baseOf = (d) => JSON.parse(fs.readFileSync(path.join(d, '.slop-baseline.json')));
const flagged = (r, name) => new RegExp(`(NEW|GREW)[^\\n]*\\n(\\s+[^\\n]*\\n)*?\\s+${name}`).test(r.stdout);

test('size: new oversized fails; tests, schema and env files get their own caps', () => {
  const d = repo({ 'src/big.ts': lines(501), 'src/ok.ts': lines(10), 'src/a.test.ts': lines(900), 'src/db/schema.ts': lines(2500), 'src/env.ts': lines(600) });
  const r = run(d, '--only', 'size');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /src\/big\.ts/);
  for (const ok of ['a\\.test', 'db\\/schema', 'src\\/env']) assert.doesNotMatch(r.stdout, new RegExp(ok));
});

test('ratchet: growth budget, shrink warns, update only lowers', () => {
  const d = repo({ 'src/big.ts': lines(520) });
  const set = (n) => fs.writeFileSync(path.join(d, 'src/big.ts'), lines(n));
  assert.equal(run(d, '--init').status, 0);
  assert.equal(run(d).status, 0);
  set(540); // exactly +20
  assert.equal(run(d).status, 0, 'small growth budget');
  set(541);
  assert.equal(run(d).status, 1, 'beyond the budget fails');
  assert.equal(run(d, '--update').status, 1);
  assert.equal(baseOf(d).size['src/big.ts'], 520);
  set(510);
  assert.equal(run(d).status, 0, 'improvement never blocks');
  assert.equal(run(d, '--update').status, 0);
  assert.equal(baseOf(d).size['src/big.ts'], 510);
  set(20);
  assert.equal(run(d, '--update').status, 0);
  assert.deepEqual(baseOf(d).size, {});
});

test('baseline vs base: gained or raised entries fail, shrinking passes, first introduction is accepted', () => {
  const d = repo({ 'src/big.ts': lines(520), 'src/other.ts': lines(600) });
  assert.equal(run(d, '--init').status, 0);
  const none = commit(d); // baseline introduced in this very commit: nothing at base before it
  assert.equal(run(d, '--base', git(d, 'rev-parse', 'HEAD~0').trim()).status, 0);
  fs.writeFileSync(path.join(d, '.slop-baseline.json'), JSON.stringify({ size: { 'src/big.ts': 520 } }));
  const base = commit(d, 'baseline with one entry');
  const b = baseOf(d);
  b.size['src/big.ts'] = 525;
  fs.writeFileSync(path.join(d, '.slop-baseline.json'), JSON.stringify(b));
  assert.equal(run(d, '--base', base).status, 1, 'raised entry');
  b.size['src/big.ts'] = 520; b.size['src/other.ts'] = 600;
  fs.writeFileSync(path.join(d, '.slop-baseline.json'), JSON.stringify(b));
  const r = run(d, '--base', base);
  assert.equal(r.status, 1, 'added entry hides a new offender');
  assert.match(r.stdout, /baseline gained src\/other\.ts/);
  assert.ok(none);
});

test('a base commit that cannot be read is an error, never a skip', () => {
  const d = repo({ 'src/ok.ts': lines(2) });
  commit(d);
  assert.equal(run(d, '--base', '0'.repeat(40)).status, 2);
});

test('renames carry the baseline entry in the same PR and from history on main', () => {
  const d = repo({ 'src/big.ts': lines(520) });
  run(d, '--init');
  const base = commit(d);
  git(d, 'mv', 'src/big.ts', 'src/moved.ts');
  commit(d, 'rename');
  assert.equal(run(d, '--base', base, '--only', 'size').status, 0, 'rename inside the PR');
  assert.equal(run(d, '--only', 'size').status, 0, 'rename found in history');
  assert.equal(run(d, '--base', base, '--only', 'size', '--update').status, 0);
  assert.deepEqual(Object.keys(baseOf(d).size), ['src/moved.ts']);
});

test('deleted or fixed entries only warn and are dropped', () => {
  const d = repo({ 'src/big.ts': lines(520), 'src/gone.ts': lines(520) });
  run(d, '--init');
  fs.rmSync(path.join(d, 'src/gone.ts'));
  const r = run(d, '--only', 'size');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /FIXED/);
  assert.equal(run(d, '--only', 'size', '--update').status, 0);
  assert.deepEqual(Object.keys(baseOf(d).size), ['src/big.ts']);
});

test('tool configs come from ci: repo-local .jscpd.json and knip settings are never passed', () => {
  const d = repo({ 'src/a.ts': lines(1), '.jscpd.json': '{"threshold": 100}', 'knip.json': '{"entry": ["src/**"]}' }, { knip: true, jscpd: { paths: ['src'] }, knipCommand: ['node', 'argv.mjs', 'knip'], jscpdCommand: ['node', 'argv.mjs', 'jscpd'] });
  fs.mkdirSync(path.join(`${d}-policy`, '..', 'default'), { recursive: true });
  fs.writeFileSync(path.join(d, 'argv.mjs'), `import fs from 'node:fs';
const out = process.argv.includes('--output') ? process.argv[process.argv.indexOf('--output') + 1] : null;
fs.appendFileSync(process.env.ARGV_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
if (out) fs.writeFileSync(out + '/jscpd-report.json', '{"duplicates":[]}'); else console.log('{"issues":[]}');`);
  const log = `${d}-argv.log`;
  const r = spawnSync('node', [SCRIPT, '--policy', `${d}-policy/policy.json`, '--init'], { cwd: d, encoding: 'utf8', env: { ...process.env, ARGV_LOG: log } });
  assert.equal(r.status, 0, r.stderr);
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  for (const c of calls) {
    const i = c.indexOf('--config');
    assert.ok(i > -1, 'explicit --config');
    assert.ok(path.resolve(c[i + 1]).startsWith(path.dirname(`${d}-policy`)), `config ${c[i + 1]} is outside the repo`);
    assert.ok(!path.resolve(c[i + 1]).startsWith(d + path.sep));
  }
});

test('discovery: generated headers skipped; vendor and build dirs scanned; gitignored output skipped', () => {
  const d = repo({
    'src/gen.ts': `// @generated by tool\n${lines(600)}`,
    'src/go.ts': `// Code generated by protoc. DO NOT EDIT.\n${lines(600)}`,
    'src/lint.ts': `/* eslint-disable */\n// This file is auto-generated\n${lines(600)}`,
    'src/not.ts': `// Hand written, not auto-generated, do not regenerate\n${lines(600)}`,
    'src/vendor/v.ts': lines(600),
    'src/build/b.ts': lines(600),
    'src/build-out/o.ts': lines(600),
  });
  const r = run(d, '--only', 'size');
  assert.match(r.stdout, /src\/vendor\/v\.ts/);
  assert.match(r.stdout, /src\/build\/b\.ts/);
  assert.match(r.stdout, /src\/not\.ts/);
  assert.doesNotMatch(r.stdout, /src\/gen\.ts|src\/go\.ts|src\/lint\.ts|build-out/);
});

test('prefix sprawl: kebab, Pascal, snake and cross-folder', () => {
  const mk = (names, dir = 'src') => Object.fromEntries(names.map((n) => [`${dir}/${n}`, lines(1)]));
  const caps = { prefix: 3, prefixGlobal: 5 };
  assert.equal(run(repo(mk(['provider-a.ts', 'provider-b.ts', 'provider-c.ts']), { caps }), '--only', 'prefix').status, 0);
  for (const names of [['provider-a.ts', 'provider-b.ts', 'provider-c.ts', 'provider-d.ts'], ['ProviderA.tsx', 'ProviderB.tsx', 'ProviderC.tsx', 'ProviderD.tsx'], ['provider_a.ts', 'provider_b.ts', 'provider_c.ts', 'provider_d.ts']]) {
    assert.equal(run(repo(mk(names), { caps }), '--only', 'prefix').status, 1, names[0]);
  }
  const cross = { ...mk(['provider-a.ts', 'provider-b.ts'], 'src/a'), ...mk(['provider-c.ts', 'provider-d.ts'], 'src/b'), ...mk(['provider-e.ts', 'provider-f.ts'], 'src/c') };
  assert.equal(run(repo(cross, { caps }), '--only', 'prefix').status, 1);
});

test('passthrough: forwarding shapes fail, logic, barrels, boundary and route files pass', () => {
  const real = "import { real } from './real';\n";
  const d = repo({
    'src/real.ts': 'export function real(a: number) { return a + 1; }\n',
    'src/reexport.ts': "export { real } from './real';\n",
    'src/star.ts': "export * from './real';\n",
    'src/forward.ts': `${real}export function f(a: number, b: number) { return real(a, b); }\n`,
    'src/arrow.ts': `${real}export const g = async (a: number) => real(a);\n`,
    'src/alias.ts': `${real}export const alias = real;\n`,
    'src/member.ts': "import * as ns from './real';\nexport const m = ns.real;\n",
    'src/dflt.ts': `${real}export default real;\n`,
    'src/noop.ts': `'use strict';\n${real};\nvoid 0;\n// eslint-disable-next-line\nexport { real };\n`,
    'src/noopfn.ts': `${real}export function n(a: number) { void 0; return real(a); }\n`,
    'src/boundary.ts': "// boundary: public SDK entry point\nexport { real } from './real';\n",
    'src/todo.ts': "// boundary: TODO\nexport { real } from './real';\n",
    'src/nested.ts': "export {\n  // boundary: inside the braces is not top level\n  real,\n} from './real';\n",
    'src/short.ts': "// boundary: x\nexport { real } from './real';\n",
    'src/logic.ts': `${real}export function h(a: number) { return real(a) * 2; }\n`,
    'src/reorder.ts': `${real}export function r(a: number, b: number) { return real(b, a); }\n`,
    'src/index.ts': "export { real } from './real';\nexport { h } from './logic';\n",
    'src/app/page.tsx': "export { default } from './impl';\n",
    'src/app/api/route.ts': "export { GET } from './impl';\n",
  });
  const r = run(d, '--only', 'passthrough');
  assert.equal(r.status, 1);
  for (const bad of ['reexport', 'star', 'forward', 'arrow', 'alias', 'member', 'dflt', 'noop', 'noopfn', 'todo', 'nested', 'short']) assert.ok(flagged(r, `src/${bad}\\.ts`) || r.stdout.includes(`src/${bad}.ts`), bad);
  for (const ok of ['real', 'boundary', 'logic', 'reorder', 'index', 'page', 'route']) assert.doesNotMatch(r.stdout, new RegExp(`src/(app/)?(api/)?${ok}\\.tsx?[ \\n(]`), ok);
});

test('single-impl: resolved by module, counts object-literal and factory implementations and test doubles', () => {
  const store = 'export interface Store { get(): number }\n';
  const lone = repo({ 'src/i.ts': `${store}export class Mem implements Store { get() { return 1; } }\n` });
  const r = run(lone, '--only', 'single-impl');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /src\/i\.ts#Store/);
  // Same name in two modules: each is judged on its own implementations.
  const twin = repo({
    'src/a.ts': store, 'src/b.ts': store,
    'src/ia.ts': "import type { Store } from './a';\nexport class A implements Store { get() { return 1; } }\n",
    'src/ib1.ts': "import type { Store } from './b';\nexport class B1 implements Store { get() { return 1; } }\n",
    'src/ib2.ts': "import type { Store } from './b';\nexport const b2: Store = { get: () => 2 };\n",
  });
  const t = run(twin, '--only', 'single-impl');
  assert.match(t.stdout, /src\/a\.ts#Store/);
  assert.doesNotMatch(t.stdout, /src\/b\.ts#Store/);
  const mk = (extra) => repo({ 'src/i.ts': `${store}export class Mem implements Store { get() { return 1; } }\n`, ...extra });
  assert.equal(run(mk({ 'src/o.ts': "import type { Store } from './i';\nexport const o = { get: () => 2 } satisfies Store;\n" }), '--only', 'single-impl').status, 0, 'object literal');
  assert.equal(run(mk({ 'src/c.ts': "import type { Store } from './i';\nexport const c: Store = makeIt();\nfunction makeIt() { return { get: () => 1 }; }\n" }), '--only', 'single-impl').status, 1, 'typed variable initialised by a call is not an implementation');
  assert.equal(run(mk({ 'src/w.ts': "import type { Store } from './i';\nexport function wrap(s: Store): Store { return s; }\n" }), '--only', 'single-impl').status, 1, 'forwarding a Store is not an implementation');
  assert.equal(run(repo({ 'src/h.ts': 'export interface UseThingReturn { run(): void }\nexport class H implements UseThingReturn { run() {} }\n' }), '--only', 'single-impl').status, 0, 'hook return types are excluded');
  assert.equal(run(mk({ 'src/f.ts': "import type { Store } from './i';\nexport function make(): Store { return { get: () => 3 }; }\n" }), '--only', 'single-impl').status, 0, 'factory');
  assert.equal(run(mk({ 'src/i.test.ts': "import type { Store } from './i';\nexport default { get: () => 2 } satisfies Store;\n" }), '--only', 'single-impl').status, 0, 'test double');
  assert.equal(run(repo({ 'src/a.ts': 'export abstract class Base { abstract f(): void }\nexport class Only extends Base { f() {} }\n' }), '--only', 'single-impl').status, 1);
});

test('knip adapter ratchets per file and category', () => {
  const fake = (d, issues) => {
    fs.writeFileSync(path.join(d, 'fake-knip.mjs'), `console.log(${JSON.stringify(JSON.stringify({ issues }))})`);
  };
  const d = repo({ 'src/a.ts': lines(1) }, { knip: true, knipCommand: ['node', 'fake-knip.mjs'] });
  fake(d, [{ file: 'src/a.ts', exports: [{}, {}], types: [], dependencies: [{}] }]);
  assert.equal(run(d, '--init').status, 0);
  assert.deepEqual(baseOf(d).knip, { 'src/a.ts:exports': 2 });
  assert.equal(run(d, '--only', 'knip').status, 0);
  fake(d, [{ file: 'src/a.ts', exports: [{}, {}, {}] }]);
  assert.equal(run(d, '--only', 'knip').status, 1);
  fake(d, [{ file: 'src/a.ts', exports: [{}, {}] }, { file: 'src/b.ts', files: [{}] }]);
  assert.equal(run(d, '--only', 'knip').status, 1);
});

test('jscpd adapter counts the union of clone lines per file, independent of clone order', () => {
  const d = repo({ 'src/a.ts': lines(1), 'src/b.ts': lines(1), 'src/c.ts': lines(1) }, { jscpd: { paths: ['src'] }, jscpdCommand: ['node', 'fake-jscpd.mjs'] });
  const side = (name, a, b) => ({ name, startLoc: { line: a }, endLoc: { line: b } });
  const write = (dups) => fs.writeFileSync(path.join(d, 'fake-jscpd.mjs'), `import fs from 'node:fs';import path from 'node:path';
const out=process.argv[process.argv.indexOf('--output')+1];
fs.writeFileSync(path.join(out,'jscpd-report.json'),${JSON.stringify(JSON.stringify({ duplicates: dups }))});`);
  const c1 = { firstFile: side('src/a.ts', 1, 10), secondFile: side('src/b.ts', 5, 14) };
  const c2 = { firstFile: side('src/a.ts', 6, 12), secondFile: side('src/c.ts', 1, 7) };
  write([c1, c2]);
  assert.equal(run(d, '--init').status, 0);
  assert.deepEqual(baseOf(d).jscpd, { 'src/a.ts': 12, 'src/b.ts': 10, 'src/c.ts': 7 });
  write([c2, { firstFile: c1.secondFile, secondFile: c1.firstFile }]);
  assert.equal(run(d, '--only', 'jscpd').status, 0, 'order-independent');
});

test('--init writes a baseline and exits 0 even with offenders', () => {
  const d = repo({ 'src/big.ts': lines(600) });
  assert.equal(run(d, '--init').status, 0);
  assert.equal(baseOf(d).size['src/big.ts'], 600);
});
