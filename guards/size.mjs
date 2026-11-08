#!/usr/bin/env node
// 500-line source file ratchet. Baseline: .company-guards/size-baseline.json
// ({path: lines}). New files over the limit fail; baselined files may not grow.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const LIMIT = 500;
const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|py|swift|ex|exs|sh|rb|go|rs)$/;
const SKIP = /(^|\/)(node_modules|vendor|dist|build|\.next|Pods)\/|\.gen\.|\.generated\.|\.min\.|\.d\.ts$|lock/;

export function measure(files, read) {
  const out = {};
  for (const f of files) {
    if (!CODE.test(f) || SKIP.test(f)) continue;
    const text = read(f);
    if (text == null) continue;
    const lines = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    if (lines > LIMIT) out[f] = lines;
  }
  return out;
}

// Violations of the ratchet. With `scope` (a Set of changed paths) only those
// files fail; violations elsewhere are returned as `warnings` so a PR is never
// blocked by growth that landed on main behind its back. Without `scope` every
// violation fails (push to main stays repo-wide and honest).
export function check(current, baseline, scope = null) {
  const fails = [];
  const warnings = [];
  for (const [f, n] of Object.entries(current)) {
    let msg = null;
    if (!(f in baseline)) msg = `${f}: ${n} lines, over ${LIMIT} and not baselined`;
    else if (n > baseline[f]) msg = `${f}: grew ${baseline[f]} -> ${n}`;
    if (!msg) continue;
    (scope && !scope.has(f) ? warnings : fails).push(msg);
  }
  return { fails, warnings };
}

export function compare(current, baseline) {
  return check(current, baseline).fails;
}

// Files changed between `base` (a commit present in the checkout) and HEAD.
// Returns null when the diff cannot be computed, so callers fail closed to the
// repo-wide check.
export function changedFiles(base, cwd = '.') {
  if (!base) return null;
  try {
    const out = execFileSync('git', ['diff', '--name-only', '--no-renames', base, 'HEAD'], { cwd, encoding: 'utf8' });
    return new Set(out.split('\n').filter(Boolean));
  } catch {
    return null;
  }
}

// Scope is only applied on pull_request and merge_group. Push (main) and any
// unknown event are repo-wide.
export function scopeFor(env = process.env, cwd = '.') {
  const event = env.GITHUB_EVENT_NAME;
  if (event !== 'pull_request' && event !== 'merge_group') return null;
  return changedFiles(env.SIZE_BASE_SHA, cwd);
}

export function run({ cwd = '.', update = false, scope = null } = {}) {
  const files = execFileSync('git', ['ls-files'], { cwd, encoding: 'utf8' }).split('\n').filter(Boolean);
  const current = measure(files, (f) => { try { return readFileSync(`${cwd}/${f}`, 'utf8'); } catch { return null; } });
  const path = `${cwd}/.company-guards/size-baseline.json`;
  if (update) {
    mkdirSync(`${cwd}/.company-guards`, { recursive: true });
    writeFileSync(path, JSON.stringify(current, null, 2) + '\n');
    return { fails: [], warnings: [], count: Object.keys(current).length };
  }
  const baseline = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  return { ...check(current, baseline, scope), count: Object.keys(current).length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const r = run({ update: process.argv.includes('--update'), scope: scopeFor() });
  for (const w of r.warnings) console.log(`::warning::size-500 (not in this change): ${w}`);
  for (const f of r.fails) console.error(`size-500: ${f}`);
  console.log(`size-500: ${r.count} oversize file(s) baselined/seen`);
  if (r.fails.length) process.exit(1);
}
