#!/usr/bin/env node
// Company-wide anti-slop ratchets. Run from a consumer repo root:
//   node slop-guard.mjs [--config .slop-guard.json] [--update] [--only a,b]
// Every rule is a ratchet: current offenders live in the baseline file, a new offender or a
// grown one fails, and a fixed one fails until the baseline is lowered (--update only lowers).
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const cwd = process.cwd();
const configPath = path.resolve(cwd, opt('--config', '.slop-guard.json'));
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const baselinePath = path.resolve(cwd, config.baseline ?? '.slop-baseline.json');
const baseline = fs.existsSync(baselinePath) ? JSON.parse(fs.readFileSync(baselinePath, 'utf8')) : {};
const only = opt('--only', '')?.split(',').filter(Boolean);
const caps = { source: 500, test: 1000, prefix: 8, ...config.caps };
const SRC = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const TEST = new RegExp(config.testPattern ?? '(?:\\.(?:test|spec)\\.|(?:^|/)(?:__tests__|tests?|e2e)/)');
const enabled = (rule) => !only?.length || only.includes(rule);

const files = [];
for (const root of config.roots) walk(path.resolve(cwd, root));
function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    const rel = path.relative(cwd, p).split(path.sep).join('/');
    if (e.isDirectory()) {
      if (!/(?:^|\/)(?:node_modules|dist|\.next|\.git|build|coverage|vendor)$/.test(rel) && !isIgnored(rel + '/')) walk(p);
    } else if (SRC.test(e.name) && !e.name.endsWith('.d.ts') && !isIgnored(rel)) files.push(rel);
  }
}
function isIgnored(rel) {
  return (config.ignore ?? []).some((g) => new RegExp(g).test(rel));
}
const isTest = (rel) => TEST.test(rel);
const text = new Map(files.map((f) => [f, fs.readFileSync(path.resolve(cwd, f), 'utf8')]));

// current[rule] = { key: number }
const current = {};
const note = {};

if (enabled('size')) {
  current.size = {};
  for (const [f, t] of text) {
    const lines = t.split('\n').length - (t.endsWith('\n') ? 1 : 0);
    if (lines > (isTest(f) ? caps.test : caps.source)) current.size[f] = lines;
  }
  note.size = `source files over ${caps.source} lines, test files over ${caps.test}`;
}

if (enabled('prefix')) {
  current.prefix = {};
  const groups = new Map();
  for (const f of text.keys()) {
    if (isTest(f)) continue;
    const base = path.posix.basename(f).replace(SRC, '');
    const m = /^([a-z0-9]+)-/i.exec(base);
    if (!m) continue;
    const k = `${path.posix.dirname(f)}/${m[1]}-*`;
    groups.set(k, (groups.get(k) ?? 0) + 1);
  }
  for (const [k, n] of groups) if (n > caps.prefix) current.prefix[k] = n;
  note.prefix = `more than ${caps.prefix} files in one directory sharing a prefix (merge near-duplicates)`;
}

let ts;
if (enabled('passthrough') || enabled('single-impl')) {
  try {
    ts = createRequire(path.join(cwd, 'package.json'))('typescript');
  } catch {
    try {
      ts = createRequire(import.meta.url)(path.resolve(process.env.SLOP_TS_DIR ?? '/nonexistent'));
    } catch {
      console.error('slop-guard: typescript must be installed in the consumer repo, or SLOP_TS_DIR must point at one.');
      process.exit(2);
    }
  }
}

const parse = (f) => ts.createSourceFile(f, text.get(f), ts.ScriptTarget.Latest, true, f.endsWith('x') ? ts.ScriptKind.TSX : undefined);

if (enabled('passthrough')) {
  current.passthrough = {};
  for (const f of text.keys()) {
    if (isTest(f)) continue;
    if (/\/\/\s*boundary:\s*\S{4,}/.test(text.get(f))) continue;
    if (isPassThrough(parse(f))) current.passthrough[f] = 1;
  }
  note.passthrough = 'files that only re-export or forward to another module (add `// boundary: <reason>` if genuine)';
}

function isPassThrough(sf) {
  const sources = new Set();
  let exports = 0;
  for (const s of sf.statements) {
    if (ts.isImportDeclaration(s) || ts.isTypeAliasDeclaration(s) || ts.isInterfaceDeclaration(s)) continue;
    if (ts.isExportDeclaration(s) && s.moduleSpecifier) {
      sources.add(s.moduleSpecifier.text);
      exports++;
    } else if (ts.isExportDeclaration(s)) {
      exports++; // `export { a }` of imported names
    } else if (ts.isFunctionDeclaration(s) && hasExport(s)) {
      if (!forwardsOnly(s.parameters, s.body)) return false;
      exports++;
    } else if (ts.isVariableStatement(s) && hasExport(s)) {
      for (const d of s.declarationList.declarations) {
        const i = d.initializer;
        if (!i || !(ts.isArrowFunction(i) || ts.isFunctionExpression(i))) return false;
        if (!forwardsOnly(i.parameters, i.body)) return false;
        exports++;
      }
    } else if (ts.isExportAssignment(s)) {
      return false;
    } else return false; // any other statement is logic
  }
  if (!exports) return false;
  // Index barrels over several modules are a legitimate boundary; single-source ones are not.
  const barrelOnly = [...sf.statements].every((s) => ts.isImportDeclaration(s) || ts.isExportDeclaration(s) || ts.isTypeAliasDeclaration(s) || ts.isInterfaceDeclaration(s));
  return !(barrelOnly && sources.size >= 2);
}
function hasExport(n) {
  return n.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}
function forwardsOnly(params, body) {
  if (!body) return false;
  let expr = body;
  if (ts.isBlock(body)) {
    if (body.statements.length !== 1 || !ts.isReturnStatement(body.statements[0])) return false;
    expr = body.statements[0].expression;
  }
  while (expr && (ts.isAwaitExpression(expr) || ts.isParenthesizedExpression(expr))) expr = expr.expression;
  if (!expr || !ts.isCallExpression(expr)) return false;
  const names = params.map((p) => (ts.isIdentifier(p.name) ? p.name.text : null));
  if (names.includes(null)) return false;
  const passed = expr.arguments.map((a) => (ts.isIdentifier(a) ? a.text : ts.isSpreadElement(a) && ts.isIdentifier(a.expression) ? a.expression.text : null));
  return passed.length === names.length && passed.every((p, i) => p === names[i]);
}

if (enabled('single-impl')) {
  current['single-impl'] = {};
  const decls = new Map(); // name -> file
  const impls = new Map(); // name -> {src:number, test:number}
  const bump = (n, f) => {
    const r = impls.get(n) ?? { src: 0, test: 0 };
    r[isTest(f) ? 'test' : 'src']++;
    impls.set(n, r);
  };
  for (const f of text.keys()) {
    const sf = parse(f);
    const visit = (n) => {
      if (ts.isInterfaceDeclaration(n) && !isTest(f)) decls.set(n.name.text, f);
      if (ts.isClassDeclaration(n) && n.name) {
        if (!isTest(f) && n.modifiers?.some((m) => m.kind === ts.SyntaxKind.AbstractKeyword)) decls.set(n.name.text, f);
        for (const h of n.heritageClauses ?? []) for (const t of h.types) if (ts.isIdentifier(t.expression)) bump(t.expression.text, f);
      }
      // Structural doubles in tests: `x satisfies I`, `x as I`, `const x: I = ...`.
      if (isTest(f)) {
        const ty = ts.isSatisfiesExpression?.(n) || ts.isAsExpression(n) ? n.type : ts.isVariableDeclaration(n) ? n.type : null;
        if (ty && ts.isTypeReferenceNode(ty) && ts.isIdentifier(ty.typeName)) bump(ty.typeName.text, f);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  for (const [name, f] of decls) {
    const r = impls.get(name);
    if (r && r.src === 1 && r.test === 0) current['single-impl'][`${f}#${name}`] = 1;
  }
  note['single-impl'] = 'interfaces/abstract classes with exactly one implementation and no test double';
}

function extern(cmd, cmdArgs) {
  try {
    return execFileSync(cmd[0], [...cmd.slice(1), ...cmdArgs], { cwd: path.resolve(cwd, config.workdir ?? '.'), encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    if (e.stdout) return e.stdout; // knip/jscpd exit non-zero when they find issues
    throw e;
  }
}

if (enabled('knip') && config.knip !== false) {
  current.knip = {};
  const out = JSON.parse(extern(config.knipCommand ?? ['pnpm', 'exec', 'knip'], ['--reporter', 'json', ...(config.knipArgs ?? [])]));
  const skip = new Set(config.knipIgnoreCategories ?? ['dependencies', 'devDependencies', 'binaries', 'unlisted', 'optionalPeerDependencies']);
  for (const i of out.issues ?? []) {
    for (const [cat, v] of Object.entries(i)) {
      if (Array.isArray(v) && v.length && !skip.has(cat)) current.knip[`${i.file}:${cat}`] = v.length;
    }
  }
  note.knip = 'dead code (unused files/exports/types) reported by knip';
}

if (enabled('jscpd') && config.jscpd !== false) {
  current.jscpd = {};
  const dir = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP ?? '/tmp', 'jscpd-'));
  const j = config.jscpd ?? {};
  extern(config.jscpdCommand ?? ['pnpm', 'exec', 'jscpd'], [...(j.paths ?? config.roots), '--reporters', 'json', '--output', dir, '--silent', '--absolute', '--min-lines', String(j.minLines ?? 8), '--min-tokens', String(j.minTokens ?? 70), '--ignore', (j.ignore ?? ['**/node_modules/**', '**/*.test.*', '**/tests/**']).join(',')]);
  const rep = JSON.parse(fs.readFileSync(path.join(dir, 'jscpd-report.json'), 'utf8'));
  // One counter per file keeps the ratchet attributable: lines of this file inside clones.
  const per = {};
  for (const d of rep.duplicates ?? []) {
    for (const side of [d.firstFile, d.secondFile]) per[side.name] = (per[side.name] ?? 0) + (d.lines ?? 0);
  }
  for (const [f, n] of Object.entries(per)) current.jscpd[path.relative(cwd, path.resolve(cwd, config.workdir ?? '.', f)).split(path.sep).join('/')] = n;
  note.jscpd = 'duplicated lines per file (jscpd clones)';
}

if (flag('--init')) {
  fs.writeFileSync(baselinePath, JSON.stringify({ ...baseline, ...current }, null, 2) + '\n');
  console.log(`baseline initialized: ${path.relative(cwd, baselinePath)}`);
  process.exit(0);
}

// Ratchet.
let failed = false;
const next = { ...baseline };
for (const [rule, cur] of Object.entries(current)) {
  const base = baseline[rule] ?? {};
  const grown = [], fresh = [], shrunk = [];
  for (const [k, v] of Object.entries(cur)) {
    if (!(k in base)) fresh.push(`${k} (${v})`);
    else if (v > base[k]) grown.push(`${k}: ${base[k]} -> ${v}`);
    else if (v < base[k]) shrunk.push(`${k}: ${base[k]} -> ${v}`);
  }
  const gone = Object.keys(base).filter((k) => !(k in cur));
  if (flag('--update')) {
    if (fresh.length || grown.length) failed = true;
    next[rule] = Object.fromEntries(Object.entries(base).filter(([k]) => k in cur).map(([k, v]) => [k, Math.min(v, cur[k])]));
  } else if (fresh.length || grown.length || shrunk.length || gone.length) {
    failed = true;
  }
  const total = Object.values(cur).reduce((a, b) => a + b, 0);
  console.log(`[${rule}] ${Object.keys(cur).length} offenders (${total}), baseline ${Object.keys(base).length}. ${note[rule]}`);
  for (const [label, list, msg] of [
    ['NEW', fresh, 'new offender: fix it, never add it to the baseline'],
    ['GREW', grown, 'baselined offender grew: shrink it back'],
    ['SHRUNK', shrunk, 'improved: run with --update to lock the gain'],
    ['FIXED', gone, 'resolved: run with --update to drop it from the baseline'],
  ]) if (list.length && !(flag('--update') && (label === 'SHRUNK' || label === 'FIXED'))) {
    console.log(`  ${label} ${msg}`);
    for (const x of list.slice(0, 40)) console.log(`    ${x}`);
    if (list.length > 40) console.log(`    ... ${list.length - 40} more`);
  }
}
if (flag('--update') && !failed) {
  fs.writeFileSync(baselinePath, JSON.stringify(next, null, 2) + '\n');
  console.log(`baseline lowered: ${path.relative(cwd, baselinePath)}`);
}
process.exit(failed ? 1 : 0);
