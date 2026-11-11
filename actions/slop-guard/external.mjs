// knip and jscpd adapters. Both return { key: number } with deterministic key order.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function run(cmd, args, cwd) {
  try {
    return execFileSync(cmd[0], [...cmd.slice(1), ...args], { cwd, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    if (e.stdout) return e.stdout; // both tools exit non-zero when they find issues
    throw e;
  }
}

export function knip(config, cwd) {
  const out = JSON.parse(run(config.knipCommand ?? ['pnpm', 'exec', 'knip'], ['--reporter', 'json', ...(config.knipArgs ?? [])], cwd));
  const skip = new Set(config.knipIgnoreCategories ?? ['dependencies', 'devDependencies', 'binaries', 'unlisted', 'optionalPeerDependencies', 'owners']);
  const res = {};
  for (const i of out.issues ?? []) for (const [cat, v] of Object.entries(i)) if (Array.isArray(v) && v.length && !skip.has(cat)) res[`${i.file}:${cat}`] = v.length;
  return sortKeys(res);
}

// Per-file duplicated line count = size of the union of line ranges the file has inside any clone,
// so overlapping clones and which side jscpd reports first never change the number.
export function jscpd(config, cwd, root) {
  const j = config.jscpd ?? {};
  const dir = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP ?? os.tmpdir(), 'jscpd-'));
  run(config.jscpdCommand ?? ['pnpm', 'exec', 'jscpd'], [...(j.paths ?? config.roots), '--config', config.jscpdConfig, '--reporters', 'json', '--output', dir, '--silent', '--absolute', '--min-lines', String(j.minLines ?? 8), '--min-tokens', String(j.minTokens ?? 70), '--ignore', (j.ignore ?? ['**/node_modules/**', '**/*.test.*', '**/tests/**']).join(',')], cwd);
  const file = path.join(dir, 'jscpd-report.json');
  if (!fs.existsSync(file)) throw new Error('slop-guard: jscpd produced no report (is jscpd installed for this repo?)');
  const lines = new Map();
  for (const d of JSON.parse(fs.readFileSync(file, 'utf8')).duplicates ?? []) {
    for (const side of [d.firstFile, d.secondFile]) {
      const from = side.startLoc?.line ?? side.start, to = side.endLoc?.line ?? side.end;
      const rel = path.relative(root, path.resolve(cwd, side.name)).split(path.sep).join('/');
      const set = lines.get(rel) ?? new Set();
      for (let n = from; n <= to; n++) set.add(n);
      lines.set(rel, set);
    }
  }
  return sortKeys(Object.fromEntries([...lines].map(([k, v]) => [k, v.size])));
}

export const sortKeys = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
