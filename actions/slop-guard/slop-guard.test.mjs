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

function repo(files, config = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slop-'));
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.symlinkSync(tsDir, path.join(dir, 'node_modules', 'typescript'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{}');
  fs.writeFileSync(path.join(dir, '.slop-guard.json'), JSON.stringify({ roots: ['src'], knip: false, jscpd: false, ...config }));
  for (const [f, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), c);
  }
  return dir;
}
const run = (dir, ...a) => spawnSync('node', [SCRIPT, ...a], { cwd: dir, encoding: 'utf8' });
const lines = (n) => 'export const x = 1;\n'.repeat(n);

test('size: a new oversized file fails, test files get the higher cap', () => {
  const d = repo({ 'src/big.ts': lines(501), 'src/ok.ts': lines(10), 'src/a.test.ts': lines(900) });
  const r = run(d);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /NEW[^\n]*\n\s+src\/big\.ts/);
  assert.doesNotMatch(r.stdout, /a\.test\.ts/);
});

test('ratchet: baselined passes, growth fails, shrink demands --update, update never raises', () => {
  const d = repo({ 'src/big.ts': lines(520) });
  const base = () => JSON.parse(fs.readFileSync(path.join(d, '.slop-baseline.json'))).size['src/big.ts'];
  const set = (n) => fs.writeFileSync(path.join(d, 'src/big.ts'), lines(n));
  assert.equal(run(d, '--init').status, 0);
  assert.equal(run(d).status, 0);
  set(530);
  assert.equal(run(d).status, 1, 'growth fails');
  assert.equal(run(d, '--update').status, 1, 'update refuses to raise');
  assert.equal(base(), 520);
  set(510);
  assert.equal(run(d).status, 1, 'improvement must be locked in');
  assert.equal(run(d, '--update').status, 0);
  assert.equal(base(), 510);
  set(515);
  assert.equal(run(d).status, 1, 'cannot drift back up to the old baseline');
  set(20);
  assert.equal(run(d).status, 1, 'fixed offender must leave the baseline');
  assert.equal(run(d, '--update').status, 0);
  assert.equal(run(d).status, 0);
});

test('prefix sprawl', () => {
  const files = Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`src/provider-${i}.ts`, lines(1)]));
  assert.equal(run(repo(files), '--only', 'prefix').status, 0);
  assert.equal(run(repo(files, { caps: { prefix: 3 } }), '--only', 'prefix').status, 1);
});

test('passthrough: re-export file, forwarding function; boundary comment and real logic pass', () => {
  const d = repo({
    'src/real.ts': 'export function real(a: number) { return a + 1; }\n',
    'src/reexport.ts': "export { real } from './real';\n",
    'src/star.ts': "export * from './real';\n",
    'src/forward.ts': "import { real } from './real';\nexport function f(a: number, b: number) { return real(a, b); }\n",
    'src/arrow.ts': "import { real } from './real';\nexport const g = async (a: number) => real(a);\n",
    'src/boundary.ts': "// boundary: public SDK entry point\nexport { real } from './real';\n",
    'src/logic.ts': "import { real } from './real';\nexport function h(a: number) { return real(a) * 2; }\n",
    'src/reorder.ts': "import { real } from './real';\nexport function r(a: number, b: number) { return real(b, a); }\n",
    'src/index.ts': "export { real } from './real';\nexport { h } from './logic';\n",
  });
  const r = run(d, '--only', 'passthrough');
  assert.equal(r.status, 1);
  for (const bad of ['reexport', 'star', 'forward', 'arrow']) assert.match(r.stdout, new RegExp(`src/${bad}\\.ts`));
  for (const ok of ['real', 'boundary', 'logic', 'reorder', 'index']) assert.doesNotMatch(r.stdout, new RegExp(`src/${ok}\\.ts`));
});

test('single-impl: one implementation fails, a test double or second implementation passes', () => {
  const lone = repo({ 'src/i.ts': 'export interface Store { get(): number }\nexport class Mem implements Store { get() { return 1; } }\n' });
  const r = run(lone, '--only', 'single-impl');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /src\/i\.ts#Store/);
  const double = repo({
    'src/i.ts': 'export interface Store { get(): number }\nexport class Mem implements Store { get() { return 1; } }\n',
    'src/i.test.ts': "import type { Store } from './i';\nconst fake = { get: () => 2 } satisfies Store;\nexport default fake;\n",
  });
  assert.equal(run(double, '--only', 'single-impl').status, 0);
  const two = repo({
    'src/i.ts': 'export interface Store { get(): number }\nexport class A implements Store { get() { return 1; } }\nexport class B implements Store { get() { return 2; } }\n',
  });
  assert.equal(run(two, '--only', 'single-impl').status, 0);
  const abs = repo({ 'src/a.ts': 'export abstract class Base { abstract f(): void }\nexport class Only extends Base { f() {} }\n' });
  assert.equal(run(abs, '--only', 'single-impl').status, 1);
});
