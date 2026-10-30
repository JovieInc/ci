#!/usr/bin/env node
// Company-wide anti-slop ratchets. Policy lives only in JovieInc/ci (policy/<owner>__<repo>/policy.json plus
// knip.json and jscpd.json beside it); a consumer repo owns nothing but its baseline, which can only shrink.
//   node slop-guard.mjs --policy <policy.json> [--only a,b] [--base <git sha>] [--update] [--init]
// Rules: size, prefix, passthrough, single-impl, knip, jscpd. Each is a ratchet over the baseline:
//  - a new offender, or growth beyond the small size budget, fails;
//  - fixed or deleted debt is dropped in memory with a warning and never fails;
//  - with --base the baseline may not gain or raise any entry compared to the base revision; a PR that
//    introduces the baseline (none at base) is the only time a new baseline is accepted.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as rules from './rules.mjs';
import { knip, jscpd, sortKeys } from './external.mjs';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const startCwd = process.cwd();
let cwd = startCwd;
const git = (...a) => execFileSync('git', a, { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] });
const root = git('rev-parse', '--show-toplevel').trim();
const policyPath = path.resolve(opt('--policy', ''));
const config = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
const policyDir = path.dirname(policyPath);
process.chdir(path.resolve(root, config.workdir ?? '.'));
const wd = process.cwd();
const prefix = git('rev-parse', '--show-prefix').trim();
// Repo-local tool configs (.jscpd.json, knip.json, package.json settings) are ignored: ci passes its own.
const toolConfig = (name) => (fs.existsSync(path.join(policyDir, name)) ? path.join(policyDir, name) : path.join(policyDir, '..', 'default', name));
config.knipArgs = ['--config', toolConfig('knip.json'), ...(config.knipArgs ?? [])];
config.jscpdConfig = toolConfig('jscpd.json');
cwd = wd;
const baselinePath = path.resolve(cwd, config.baseline ?? '.slop-baseline.json');
const readJson = (p) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {});
const baseline = readJson(baselinePath);
const only = (opt('--only', '') ?? '').split(',').filter(Boolean);
const enabled = (r) => !only.length || only.includes(r);
const caps = { source: 500, test: 1000, schema: 3000, prefix: 8, prefixGlobal: 24, ...config.caps };
const BASE = opt('--base');

// --- file discovery: tracked + new files (so only real build output, which is gitignored, is skipped).
const SRC = /\.(?:[cm]?[jt]s|[jt]sx)$/;
// Only exact, standard markers exempt a file: `@generated`, Go-style `// Code generated ... DO NOT EDIT.`,
// or an eslint-disable header followed by a generated notice within the first three lines.
const isGenerated = (text) => {
  const head = text.split('\n', 10);
  if (head.some((l) => /^\s*(?:\/\/|\/?\*+)\s*@generated\b/.test(l) || /^\/\/ Code generated .* DO NOT EDIT\.$/.test(l))) return true;
  const top = head.slice(0, 3);
  return top.some((l) => /eslint-disable/.test(l)) && top.some((l) => /^\s*(?:\/\/|\/?\*+)\s*(?:this file (?:is|was) )?(?:auto-?)?generated\b/i.test(l));
};
const TEST = new RegExp(config.testPattern ?? '(?:\\.(?:test|spec)\\.|(?:^|/)(?:__tests__|tests?|e2e)/)');
const isTest = (f) => TEST.test(f);
const ignored = (f) => (config.ignore ?? []).some((g) => new RegExp(g).test(f));
const files = new Map();
const listed = git('ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...config.roots).split('\0').filter(Boolean);
for (const gitRel of listed) {
  const f = prefix && gitRel.startsWith(prefix) ? gitRel.slice(prefix.length) : gitRel;
  if (!SRC.test(f) || f.endsWith('.d.ts') || ignored(f) || !fs.existsSync(path.resolve(cwd, f))) continue;
  const text = fs.readFileSync(path.resolve(cwd, f), 'utf8');
  if (isGenerated(text)) continue;
  files.set(f, text);
}

let ts, parseCache = new Map();
if (enabled('passthrough') || enabled('single-impl')) {
  try { ts = createRequire(path.join(cwd, 'package.json'))('typescript'); }
  catch {
    try { ts = createRequire(import.meta.url)(path.resolve(process.env.SLOP_TS_DIR ?? '/nonexistent')); }
    catch { console.error('slop-guard: typescript must be installed in the consumer repo, or SLOP_TS_DIR must point at one.'); process.exit(2); }
  }
}
const parse = (f) => {
  if (!parseCache.has(f)) parseCache.set(f, ts.createSourceFile(f, files.get(f), ts.ScriptTarget.Latest, true, f.endsWith('x') ? ts.ScriptKind.TSX : undefined));
  return parseCache.get(f);
};

const ctx = { files, isTest, caps, config, ts, parse, cwd };
const current = {};
const notes = {
  size: `source files over ${caps.source} lines, tests over ${caps.test} (schema/env files ${caps.schema})`,
  prefix: `more than ${caps.prefix} files sharing a name prefix in one folder, or ${caps.prefixGlobal} across 3+ folders`,
  passthrough: 'files that only re-export, alias or forward to another module (add a top-level `// boundary: <reason>` if genuine)',
  'single-impl': 'behavioural interfaces/abstract classes (with methods) that have exactly one implementation and no test double',
  knip: 'dead code (unused files/exports/types) reported by knip',
  jscpd: 'duplicated lines per file (union of jscpd clone ranges)',
};
for (const r of ['size', 'prefix', 'passthrough']) if (enabled(r)) current[r] = sortKeys(rules[r](ctx));
if (enabled('single-impl')) current['single-impl'] = sortKeys(rules.singleImpl(ctx));
if (enabled('knip') && config.knip !== false) current.knip = knip(config, cwd);
if (enabled('jscpd') && config.jscpd !== false) current.jscpd = jscpd(config, cwd, root);

if (flag('--init')) {
  fs.writeFileSync(baselinePath, JSON.stringify({ ...baseline, ...current }, null, 2) + '\n');
  console.log(`baseline initialized: ${path.relative(cwd, baselinePath)}`);
  process.exit(0);
}

// --- base comparison and rename carry-over.
const renames = new Map();
let failed = false;
const fail = (m) => { failed = true; console.log(`  FAIL ${m}`); };
let baseLine = null;
let renameBase = BASE;
if (!renameBase) { try { renameBase = git('merge-base', 'HEAD', 'origin/HEAD').trim(); } catch { renameBase = null; } }
if (BASE) {
  try { git('cat-file', '-e', `${BASE}^{commit}`); } catch { console.error(`slop-guard: base ${BASE} is not available; fetch it first.`); process.exit(2); }
  try { baseLine = JSON.parse(git('show', `${BASE}:${prefix}${path.relative(cwd, baselinePath).split(path.sep).join('/')}`)); } catch { baseLine = null; }
}
if (renameBase) {
  for (const l of git('diff', '-M', '--name-status', renameBase).split('\n')) {
    const [st, from, to] = l.split('\t');
    if (st?.startsWith('R') && to) renames.set(from.startsWith(prefix) ? from.slice(prefix.length) : from, to.startsWith(prefix) ? to.slice(prefix.length) : to);
  }
}
const keyPath = (k) => k.split(/[:# ]/)[0];
const migrate = (obj) => Object.fromEntries(Object.entries(obj ?? {}).map(([k, v]) => {
  const p = keyPath(k), to = renames.get(p);
  return [to ? to + k.slice(p.length) : k, v];
}));
if (baseLine) {
  console.log('[baseline] compared to base (it may only shrink)');
  for (const [rule, entries] of Object.entries(baseline)) {
    const was = migrate(baseLine[rule]);
    for (const [k, v] of Object.entries(migrate(entries))) {
      if (!(k in was)) fail(`${rule}: baseline gained ${k}`);
      else if (v > was[k]) fail(`${rule}: baseline raised ${k} ${was[k]} -> ${v}`);
    }
  }
} else if (BASE) {
  console.log('[baseline] none at base: first introduction, accepted once');
}

function historyOldPath(p) {
  try {
    const out = git('log', '--follow', '--diff-filter=R', '--name-status', '--format=', '-n', '1', '--', p);
    const m = /^R\d+\t([^\t]+)\t/m.exec(out);
    if (!m) return null;
    return m[1].startsWith(prefix) ? m[1].slice(prefix.length) : m[1];
  } catch { return null; }
}

// --- ratchet.
const budget = (rule, v) => (rule === 'size' ? Math.min(Math.ceil(v * 0.05), 20) : 0);
const next = { ...baseline };
for (const [rule, cur] of Object.entries(current)) {
  const base = migrate(baseline[rule]);
  // A moved file that is still baselined under its old path (rename merged earlier) keeps its entry.
  let lookups = 0;
  for (const k of Object.keys(cur)) {
    if (k in base || rule === 'prefix' || lookups >= 100) continue;
    lookups++;
    const oldPath = historyOldPath(keyPath(k));
    const oldKey = oldPath && oldPath + k.slice(keyPath(k).length);
    if (oldKey && oldKey in base && !(oldKey in cur)) { base[k] = base[oldKey]; delete base[oldKey]; }
  }
  const grown = [], fresh = [], shrunk = [];
  for (const [k, v] of Object.entries(cur)) {
    if (!(k in base)) fresh.push(`${k} (${v})`);
    else if (v > base[k] + budget(rule, base[k])) grown.push(`${k}: ${base[k]} -> ${v} (budget +${budget(rule, base[k])})`);
    else if (v < base[k]) shrunk.push(`${k}: ${base[k]} -> ${v}`);
  }
  const gone = Object.keys(base).filter((k) => !(k in cur));
  if (fresh.length || grown.length) failed = true;
  next[rule] = sortKeys(Object.fromEntries(Object.entries(base).filter(([k]) => k in cur).map(([k, v]) => [k, Math.min(v, cur[k])])));
  console.log(`[${rule}] ${Object.keys(cur).length} offenders (${Object.values(cur).reduce((a, b) => a + b, 0)}), baseline ${Object.keys(base).length}. ${notes[rule]}`);
  for (const [label, list, msg] of [
    ['NEW', fresh, 'new offender: fix it, never baseline it'],
    ['GREW', grown, 'baselined offender grew past its budget: shrink it back'],
    ['IMPROVED', shrunk, 'will be locked in by the baseline auto-shrink'],
    ['FIXED', gone, 'resolved; baseline entry will be dropped by auto-shrink'],
  ]) if (list.length) {
    console.log(`  ${label}: ${msg}`);
    for (const x of list.slice(0, 40)) console.log(`    ${x}`);
    if (list.length > 40) console.log(`    ... ${list.length - 40} more`);
  }
}
if (flag('--update') && !failed) {
  const body = JSON.stringify(next, null, 2) + '\n';
  if (flag('--print-baseline-path')) console.log(`baseline-file=${baselinePath}`);
  if (!fs.existsSync(baselinePath) || fs.readFileSync(baselinePath, 'utf8') !== body) {
    fs.writeFileSync(baselinePath, body);
    console.log(`baseline lowered: ${path.relative(cwd, baselinePath)}`);
  }
}
process.exit(failed ? 1 : 0);
