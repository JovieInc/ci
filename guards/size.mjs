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

export function compare(current, baseline) {
  const fails = [];
  for (const [f, n] of Object.entries(current)) {
    if (!(f in baseline)) fails.push(`${f}: ${n} lines, over ${LIMIT} and not baselined`);
    else if (n > baseline[f]) fails.push(`${f}: grew ${baseline[f]} -> ${n}`);
  }
  return fails;
}

export function run({ cwd = '.', update = false } = {}) {
  const files = execFileSync('git', ['ls-files'], { cwd, encoding: 'utf8' }).split('\n').filter(Boolean);
  const current = measure(files, (f) => { try { return readFileSync(`${cwd}/${f}`, 'utf8'); } catch { return null; } });
  const path = `${cwd}/.company-guards/size-baseline.json`;
  if (update) {
    mkdirSync(`${cwd}/.company-guards`, { recursive: true });
    writeFileSync(path, JSON.stringify(current, null, 2) + '\n');
    return { fails: [], count: Object.keys(current).length };
  }
  const baseline = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  return { fails: compare(current, baseline), count: Object.keys(current).length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const r = run({ update: process.argv.includes('--update') });
  for (const f of r.fails) console.error(`size-500: ${f}`);
  console.log(`size-500: ${r.count} oversize file(s) baselined/seen`);
  if (r.fails.length) process.exit(1);
}
