// Source-level rules. Each returns { key: number } offenders. ctx: { files:Map, isTest, caps, config, ts, cwd }.
import fs from 'node:fs';
import path from 'node:path';

const ROUTE_FILE = /(^|\/)(page|layout|loading|error|global-error|not-found|template|default|route|middleware|proxy|instrumentation|opengraph-image|twitter-image|icon|apple-icon|sitemap|robots|manifest)\.[cm]?[jt]sx?$/;
const SCHEMA_FILE = /(^|\/)(db\/schema|schema|migrations?|drizzle)(\/|\.|-)|(^|\/)(env|env\.schema|env-schema|server-env|client-env)\.[cm]?[jt]s$|\.schema\.[jt]s$/;
const BAD_REASON = /^(todo|tbd|fixme|xxx|n\/?a|none|wip|\.+|-+|placeholder)\b/i;

export const exemptSize = (f, config) => SCHEMA_FILE.test(f) || (config.sizeExempt ?? []).some((g) => new RegExp(g).test(f));

export function size({ files, isTest, caps, config }) {
  const out = {};
  for (const [f, t] of files) {
    const lines = t.split('\n').length - (t.endsWith('\n') ? 1 : 0);
    const cap = exemptSize(f, config) ? caps.schema : isTest(f) ? caps.test : caps.source;
    if (lines > cap) out[f] = lines;
  }
  return out;
}

// Split a file stem into lowercase tokens: kebab, snake and camel/Pascal.
export const tokens = (stem) => stem.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2').split(/[-_.]+/).filter(Boolean).map((t) => t.toLowerCase());

export function prefix({ files, isTest, caps, config }) {
  const skip = new Set(config.prefixIgnore ?? ['use', 'index', 'test', 'types', 'utils', 'get', 'set', 'is', 'with', 'create']);
  const local = new Map(), global = new Map();
  for (const f of files.keys()) {
    if (isTest(f)) continue;
    const stem = path.posix.basename(f).replace(/\.[cm]?[jt]sx?$/, '');
    const t = tokens(stem);
    if (t.length < 2 || t[0].length < 3 || skip.has(t[0])) continue;
    const dir = path.posix.dirname(f);
    const k = `${dir}/${t[0]}-*`;
    local.set(k, (local.get(k) ?? 0) + 1);
    const g = global.get(t[0]) ?? { n: 0, dirs: new Set() };
    g.n++; g.dirs.add(dir); global.set(t[0], g);
  }
  const out = {};
  for (const [k, n] of local) if (n > caps.prefix) out[k] = n;
  for (const [t, g] of global) if (g.dirs.size >= 3 && g.n > caps.prefixGlobal) out[`*/${t}-* (cross-folder)`] = g.n;
  return out;
}

const exported = (ts, n) => n.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
const noop = (ts, s) => ts.isEmptyStatement(s) || (ts.isExpressionStatement(s) && (ts.isStringLiteral(s.expression) || ts.isVoidExpression(s.expression) || ts.isNumericLiteral(s.expression)));

function boundaryReason(ts, sf, text) {
  // Only a top-level line comment before/between/after top-level statements counts.
  const ranges = [];
  for (const st of sf.statements) ranges.push(...(ts.getLeadingCommentRanges(text, st.getFullStart()) ?? []));
  ranges.push(...(ts.getLeadingCommentRanges(text, sf.endOfFileToken.getFullStart()) ?? []));
  for (const r of ranges) {
    const m = /^\/\/\s*boundary:\s*(.+)$/.exec(text.slice(r.pos, r.end));
    if (m && m[1].trim().length >= 8 && !BAD_REASON.test(m[1].trim())) return true;
  }
  return false;
}

export function passthrough({ files, isTest, ts, parse, config }) {
  const out = {};
  for (const [f, text] of files) {
    if (isTest(f) || ROUTE_FILE.test(f) || (config.passthroughExempt ?? []).some((g) => new RegExp(g).test(f))) continue;
    const sf = parse(f);
    if (isPassThrough(ts, sf) && !boundaryReason(ts, sf, text)) out[f] = 1;
  }
  return out;
}

function isPassThrough(ts, sf) {
  const imported = new Set();
  const importSource = new Map(); // local name -> module, so `import {a} from 'x'; export {a}` counts x
  const sources = new Set();
  let exports = 0, logic = false;
  for (const s of sf.statements) {
    if (ts.isImportDeclaration(s)) {
      const c = s.importClause;
      const spec = s.moduleSpecifier.text;
      const add = (n) => { imported.add(n); importSource.set(n, spec); };
      if (c?.name) add(c.name.text);
      if (c?.namedBindings) ts.isNamespaceImport(c.namedBindings) ? add(c.namedBindings.name.text) : c.namedBindings.elements.forEach((e) => add(e.name.text));
    } else if (ts.isTypeAliasDeclaration(s) || ts.isInterfaceDeclaration(s) || noop(ts, s)) {
      // types and no-op statements never count as logic
    } else if (ts.isExportDeclaration(s)) {
      if (s.moduleSpecifier) sources.add(s.moduleSpecifier.text);
      else if (s.exportClause && ts.isNamedExports(s.exportClause)) for (const e of s.exportClause.elements) { const m = importSource.get((e.propertyName ?? e.name).text); if (m) sources.add(m); }
      exports++;
    } else if (ts.isExportAssignment(s)) {
      if (!aliasOrForward(ts, s.expression, imported)) logic = true;
      exports++;
    } else if (ts.isFunctionDeclaration(s) && exported(ts, s)) {
      if (!forwardsOnly(ts, s.parameters, s.body)) logic = true;
      exports++;
    } else if (ts.isVariableStatement(s) && exported(ts, s)) {
      for (const d of s.declarationList.declarations) {
        const i = d.initializer;
        if (!i) { logic = true; continue; }
        const fn = ts.isArrowFunction(i) || ts.isFunctionExpression(i);
        if (!(fn ? forwardsOnly(ts, i.parameters, i.body) : aliasOrForward(ts, i, imported))) logic = true;
        exports++;
      }
    } else logic = true;
  }
  if (logic || !exports) return false;
  const barrelOnly = sf.statements.every((s) => ts.isImportDeclaration(s) || ts.isExportDeclaration(s) || ts.isTypeAliasDeclaration(s) || ts.isInterfaceDeclaration(s) || noop(ts, s));
  return !(barrelOnly && sources.size >= 2); // multi-module index barrels are a boundary
}

function aliasOrForward(ts, e, imported) {
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression?.(e) || ts.isNonNullExpression(e)) e = e.expression;
  let root = e;
  while (ts.isPropertyAccessExpression(root)) root = root.expression;
  if (ts.isIdentifier(root)) return imported.has(root.text);
  return false;
}

function forwardsOnly(ts, params, body) {
  if (!body) return false;
  let expr = body;
  if (ts.isBlock(body)) {
    const st = body.statements.filter((s) => !noop(ts, s));
    if (st.length !== 1 || !ts.isReturnStatement(st[0])) return false;
    expr = st[0].expression;
  }
  while (expr && (ts.isAwaitExpression(expr) || ts.isParenthesizedExpression(expr))) expr = expr.expression;
  if (!expr || !ts.isCallExpression(expr)) return false;
  const names = params.map((p) => (ts.isIdentifier(p.name) ? p.name.text : null));
  if (names.includes(null)) return false;
  const passed = expr.arguments.map((a) => (ts.isIdentifier(a) ? a.text : ts.isSpreadElement(a) && ts.isIdentifier(a.expression) ? a.expression.text : null));
  return passed.length === names.length && passed.every((p, i) => p === names[i]);
}

// Resolve identifiers to declaring files so same-named interfaces in different modules never merge.
export function singleImpl({ files, isTest, ts, parse, cwd, config }) {
  let options = { allowImportingTsExtensions: true, moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext };
  const tsconfig = ts.findConfigFile(path.resolve(cwd, config.tsconfigDir ?? '.'), ts.sys.fileExists);
  if (tsconfig) {
    const raw = ts.readConfigFile(tsconfig, ts.sys.readFile);
    options = { ...ts.parseJsonConfigFileContent(raw.config ?? {}, ts.sys, path.dirname(tsconfig)).options, noEmit: true };
  }
  const rel = (p) => path.relative(cwd, p).split(path.sep).join('/');
  const decls = new Map(); // "file#Name"
  const stats = new Map(); // "file#Name" -> {src, test}
  const bump = (id, f) => {
    const r = stats.get(id) ?? { src: 0, test: 0 };
    r[isTest(f) ? 'test' : 'src']++;
    stats.set(id, r);
  };
  const byName = new Map(); // fallback for unresolved imports: name -> [ids]
  const parsed = new Map([...files.keys()].map((f) => [f, parse(f)]));
  for (const [f, sf] of parsed) {
    sf.statements.forEach((n) => {
      const abs = ts.isClassDeclaration(n) && n.modifiers?.some((m) => m.kind === ts.SyntaxKind.AbstractKeyword);
      // Data-only interfaces (no methods or callable members) are shapes, not swappable abstractions.
      const behavioural = abs || (ts.isInterfaceDeclaration(n) && n.members.some((m) => ts.isMethodSignature(m) || ts.isCallSignatureDeclaration(m) || (ts.isPropertySignature(m) && m.type && ts.isFunctionTypeNode(m.type))));
      if (behavioural && n.name && !isTest(f) && !/^Use[A-Z]\w*(Return|Result)$/.test(n.name.text)) {
        const id = `${f}#${n.name.text}`;
        decls.set(id, f);
        byName.set(n.name.text, [...(byName.get(n.name.text) ?? []), id]);
      }
    });
  }
  const resolveIn = (f, sf, name) => {
    if (decls.has(`${f}#${name}`)) return `${f}#${name}`;
    for (const s of sf.statements) {
      if (!ts.isImportDeclaration(s) || !s.importClause?.namedBindings || ts.isNamespaceImport(s.importClause.namedBindings)) continue;
      const el = s.importClause.namedBindings.elements.find((e) => e.name.text === name);
      if (!el) continue;
      const orig = (el.propertyName ?? el.name).text;
      const r = ts.resolveModuleName(s.moduleSpecifier.text, path.resolve(cwd, f), options, ts.sys).resolvedModule;
      const id = r && `${rel(r.resolvedFileName)}#${orig}`;
      if (id && decls.has(id)) return id;
      const c = byName.get(orig);
      return c?.length === 1 ? c[0] : null;
    }
    const c = byName.get(name);
    return c?.length === 1 ? c[0] : null;
  };
  const typeId = (f, sf, t) => (t && ts.isTypeReferenceNode(t) && ts.isIdentifier(t.typeName) ? resolveIn(f, sf, t.typeName.text) : null);
  const returnsObjectLiteral = (fn) => {
    if (!fn.body) return false;
    if (!ts.isBlock(fn.body)) return ts.isObjectLiteralExpression(fn.body) || (ts.isParenthesizedExpression(fn.body) && ts.isObjectLiteralExpression(fn.body.expression));
    let found = false;
    const walk = (n) => {
      if (ts.isFunctionLike(n) && n !== fn) return;
      if (ts.isReturnStatement(n) && n.expression && ts.isObjectLiteralExpression(n.expression)) found = true;
      ts.forEachChild(n, walk);
    };
    walk(fn.body);
    return found;
  };
  for (const [f, sf] of parsed) {
    const visit = (n) => {
      if (ts.isClassDeclaration(n)) for (const h of n.heritageClauses ?? []) for (const t of h.types) if (ts.isIdentifier(t.expression)) { const id = resolveIn(f, sf, t.expression.text); if (id) bump(id, f); }
      // object-literal and factory implementations: `x satisfies I`, `x as I`, `const x: I = {...}`, `function make(): I`
      let ty = null;
      if ((ts.isAsExpression(n) || ts.isSatisfiesExpression?.(n)) && ts.isObjectLiteralExpression(n.expression)) ty = n.type;
      else if (ts.isVariableDeclaration(n) && n.initializer && ts.isObjectLiteralExpression(n.initializer)) ty = n.type;
      else if ((ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isMethodDeclaration(n)) && returnsObjectLiteral(n)) {
        ty = n.type;
        if (ty && ts.isTypeReferenceNode(ty) && ts.isIdentifier(ty.typeName) && ty.typeName.text === 'Promise' && ty.typeArguments?.[0]) ty = ty.typeArguments[0];
      }
      const id = typeId(f, sf, ty);
      if (id) bump(id, f);
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  const out = {};
  for (const id of decls.keys()) {
    const r = stats.get(id);
    if (r && r.src === 1 && r.test === 0) out[id] = 1;
  }
  return out;
}
