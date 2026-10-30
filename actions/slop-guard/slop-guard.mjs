#!/usr/bin/env node
// Company-wide anti-slop ratchets. Run from a consumer package root:
//   node slop-guard.mjs [--config .slop-guard.json] [--only a,b] [--base <git sha>] [--update] [--init]
// Rules: size, prefix, passthrough, single-impl, knip, jscpd. Each is a ratchet over a baseline file:
//  - a new offender, or growth beyond the small size budget, fails;
//  - fixed debt only warns here; CI lowers the baseline with --update (it can never raise an entry);
//  - with --base, config and baseline are compared to the base revision: any added or raised baseline
//    entry, loosened cap, new ignore/exempt pattern, or dropped root fails, so --init and hand edits cannot game it.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as rules from './rules.mjs';
import { knip, jscpd, sortKeys } from './external.mjs';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const cwd = process.cwd();
const git = (...a) => execFileSync('git', a, { cwd, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] });
const root = git('rev-parse', '--show-toplevel').trim();
const prefix = git('rev-parse', '--show-prefix').trim();
const configPath = path.resolve(cwd, opt('--config', '.slop-guard.json'));
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
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
// A missing base never skips the check: with no base config the pinned DEFAULT_POLICY applies, and a
// missing base baseline is a first introduction that needs a CODEOWNER-applied `slop-guard-policy` label.
const DEFAULT_POLICY = { baseline: '.slop-baseline.json', knipCommand: ['pnpm', 'exec', 'knip'], caps: { source: 500, test: 1000, schema: 3000, prefix: 8, prefixGlobal: 24 }, roots: [], ignore: [], sizeExempt: [], passthroughExempt: [], prefixIgnore: [], knipIgnoreCategories: ['dependencies', 'devDependencies', 'binaries', 'unlisted', 'optionalPeerDependencies', 'owners'], knipArgs: [] };
const approved = flag('--policy-approved');
const renames = new Map();
let failed = false;
const fail = (m) => { failed = true; console.log(`  FAIL ${m}`); };
const policyFail = (m) => (approved ? console.log(`  note (policy approved) ${m}`) : fail(`${m} (needs a CODEOWNER-applied slop-guard-policy label)`));
let baseCfg = null, baseLine = null;
let renameBase = BASE;
if (!renameBase) { try { renameBase = git('merge-base', 'HEAD', 'origin/HEAD').trim(); } catch { renameBase = null; } }
if (BASE) {
  try { git('cat-file', '-e', `${BASE}^{commit}`); } catch { console.error(`slop-guard: base ${BASE} is not available; fetch it first.`); process.exit(2); }
  const show = (p) => { try { return JSON.parse(git('show', `${BASE}:${prefix}${path.relative(cwd, p).split(path.sep).join('/')}`)); } catch { return null; } };
  baseCfg = show(configPath);
  baseLine = show(baselinePath);
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
if (BASE) {
  const ref = baseCfg ?? DEFAULT_POLICY;
  console.log(`[config] compared to ${baseCfg ? 'base' : 'pinned default policy (base has no config)'}`);
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const cf = baseCfg ? fail : policyFail; // introduction: the whole config is a CODEOWNER-approved event
  const capsNow = { ...DEFAULT_POLICY.caps, ...config.caps }, capsRef = { ...DEFAULT_POLICY.caps, ...ref.caps };
  for (const k of Object.keys(capsNow)) if (capsNow[k] > capsRef[k]) cf(`cap ${k} raised ${capsRef[k]} -> ${capsNow[k]}`);
  for (const k of ['ignore', 'sizeExempt', 'passthroughExempt', 'prefixIgnore', 'knipIgnoreCategories', 'knipArgs']) {
    const had = new Set(ref[k] ?? []);
    for (const x of config[k] ?? []) if (!had.has(x)) cf(`${k} gained "${x}"`);
  }
  for (const x of ref.roots ?? []) if (!(config.roots ?? []).includes(x)) cf(`root "${x}" dropped`);
  for (const k of ['knip', 'jscpd']) if (config[k] === false && ref[k] !== false) (baseCfg ? fail : policyFail)(`${k} disabled`);
  if ((config.testPattern ?? '') !== (ref.testPattern ?? '')) cf('testPattern changed');
  const bj = ref.jscpd ?? {}, hj = config.jscpd ?? {};
  for (const k of ['minLines', 'minTokens']) if (hj[k] !== undefined && hj[k] > (bj[k] ?? 0)) cf(`jscpd.${k} raised`);
  for (const x of hj.ignore ?? []) if (!(bj.ignore ?? []).includes(x)) cf(`jscpd.ignore gained "${x}"`);
  // Policy fields are locked: any change needs a CODEOWNER-applied label.
  const polRef = { baseline: ref.baseline ?? DEFAULT_POLICY.baseline, knipCommand: ref.knipCommand ?? DEFAULT_POLICY.knipCommand, jscpdPaths: ref.jscpd?.paths ?? ref.roots, tsconfigDir: ref.tsconfigDir ?? '.', jscpdCommand: ref.jscpdCommand ?? ['pnpm', 'exec', 'jscpd'] };
  const polNow = { baseline: config.baseline ?? DEFAULT_POLICY.baseline, knipCommand: config.knipCommand ?? DEFAULT_POLICY.knipCommand, jscpdPaths: config.jscpd?.paths ?? config.roots, tsconfigDir: config.tsconfigDir ?? '.', jscpdCommand: config.jscpdCommand ?? ['pnpm', 'exec', 'jscpd'] };
  for (const k of Object.keys(polNow)) if (!eq(polNow[k], polRef[k])) policyFail(`policy field ${k} changed`);
  if (!baseCfg) for (const x of config.roots ?? []) if (!ref.roots.includes(x)) policyFail(`introducing root "${x}"`);
}
if (BASE && !baseLine) policyFail('baseline introduced (no baseline at base)');
if (baseLine) {
  console.log('[baseline] compared to base');
  for (const [rule, entries] of Object.entries(baseline)) {
    const was = migrate(baseLine[rule]);
    for (const [k, v] of Object.entries(migrate(entries))) {
      if (!(k in was)) fail(`${rule}: baseline gained ${k}`);
      else if (v > was[k]) fail(`${rule}: baseline raised ${k} ${was[k]} -> ${v}`);
    }
  }
}
// Baseline keys must follow renames and deletions in the same PR (otherwise main breaks on the next PR).
if (!flag('--update')) {
  for (const [rule, entries] of Object.entries(baseline)) {
    if (rule === 'prefix') continue;
    for (const k of Object.keys(entries)) {
      const p = keyPath(k);
      if (renames.has(p)) fail(`${rule}: baseline still references renamed path ${p} (now ${renames.get(p)}); run --update`);
      else if (!fs.existsSync(path.resolve(cwd, p)) && !fs.existsSync(path.resolve(root, p))) fail(`${rule}: baseline references missing path ${p}; run --update`);
    }
  }
}

// --- ratchet.
const budget = (rule, v) => (rule === 'size' ? Math.min(Math.ceil(v * 0.05), 20) : 0);
const next = { ...baseline };
for (const [rule, cur] of Object.entries(current)) {
  const base = migrate(baseline[rule]);
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
  if (!fs.existsSync(baselinePath) || fs.readFileSync(baselinePath, 'utf8') !== body) {
    fs.writeFileSync(baselinePath, body);
    console.log(`baseline lowered: ${path.relative(cwd, baselinePath)}`);
  }
}
process.exit(failed ? 1 : 0);
