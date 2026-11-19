// Dependency-change qualification. Registered in shadow until JOV-13093 unit 2.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { posix, join } from 'node:path';
import {
  parseLockfile, resolutionDiff, newDirectDependencies, declarations, levenshtein,
  directDependencies, manifestSpecifiers, looseDiff,
} from '../lib/lockfile.mjs';

export const name = 'lockfile-majors';
const LOCKS = ['pnpm-lock.yaml', 'package-lock.json', 'npm-shrinkwrap.json'];
const isLock = (p) => LOCKS.includes(posix.basename(p));
const isManifest = (p) => ['package.json', 'pnpm-workspace.yaml'].includes(posix.basename(p));
const gatesURL = new URL('../../canon/dependency-migration-gates.json', import.meta.url);
const read = (cwd, path) => {
  try { return readFileSync(join(cwd, path), 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
};
const depsOf = (text) => text == null ? {} : directDependencies(JSON.parse(text));
// Override keys: `name`, `name@range`, `parent>name`, `@scope/name@range` -> the overridden package name.
export const overrideTarget = (key) => {
  const last = String(key).split('>').pop();
  const at = last.indexOf('@', 1);
  return at === -1 ? last : last.slice(0, at);
};
const same = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

async function ageChecks(items, { fetch, now, timeoutMs }) {
  if (items.length > 400) return ['AGE: too many new resolutions to age-check; split the PR'];
  // Registry documents contain all version times; one request per package.
  const groups = new Map();
  for (const item of items) groups.set(item.name, [...(groups.get(item.name) ?? []), item]);
  const work = [...groups];
  const results = new Array(work.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(8, work.length) }, async () => {
    while (cursor < work.length) {
      const index = cursor++;
      const [pkg, versions] = work[index];
      const controller = new AbortController();
      let timer;
      try {
        const doc = await Promise.race([
          (async () => {
            const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg)}`, { signal: controller.signal });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return response.json();
          })(),
          new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, timeoutMs); }),
        ]);
        results[index] = versions.flatMap((p) => {
          const published = Date.parse(doc.time?.[p.version]);
          const site = `${p.path}: ${pkg} ${p.from.join(', ') || '<absent>'} -> ${p.version}`;
          if (!Number.isFinite(published)) return [`AGE: ${site}: registry unreachable; fail closed for dependency changes (release time missing)`];
          return now - published < 3 * 86400_000 ? [`AGE: ${site}: release is younger than 3 days`] : [];
        });
      } catch {
        results[index] = versions.map((p) => `AGE: ${p.path}: ${pkg} ${p.from.join(', ') || '<absent>'} -> ${p.version}: registry unreachable; fail closed for dependency changes`);
      } finally { clearTimeout(timer); }
    }
  }));
  return results.flat();
}

async function inspect({ cwd, env, fetch, now, timeoutMs }) {
  const fails = [], warnings = [];
  if (!['pull_request', 'pull_request_target'].includes(env.GITHUB_EVENT_NAME) && env.PR_BODY === undefined)
    return { fails, warnings };
  // Explicit non-PR events always skip, even if a caller leaked PR_BODY.
  if (['push', 'merge_group'].includes(env.GITHUB_EVENT_NAME)) return { fails, warnings };
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 1 << 28 });
  let base, changed;
  try {
    base = env.SIZE_BASE_SHA;
    if (!base) {
      if (git('rev-list', '--parents', '-n', '1', 'HEAD').trim().split(' ').length < 3)
        throw new Error('HEAD is not a pull_request merge commit; need fetch-depth >= 2 or SIZE_BASE_SHA');
      base = 'HEAD^1';
    }
    changed = git('diff', '--name-only', '--no-renames', '-z', base, 'HEAD').split('\0').filter(Boolean);
  } catch { return { fails, warnings: ['base unavailable; need SIZE_BASE_SHA or the pull_request merge commit base (fetch-depth >= 2)'] }; }
  if (!changed.some((p) => isLock(p) || isManifest(p))) return { fails, warnings };
  const atBase = (path) => {
    try { return git('show', `${base}:${path}`); }
    catch { return null; }
  };
  const changes = new Set(changed);
  const paths = new Set(changed.filter(isLock));
  const nearest = (path) => {
    let dir = posix.dirname(path);
    for (;;) {
      const found = LOCKS.map((f) => posix.join(dir, f)).filter((f) => read(cwd, f) !== null);
      if (found.length) return found;
      if (dir === '.') return [];
      dir = posix.dirname(dir);
    }
  };
  for (const path of changed.filter((p) => posix.basename(p) === 'package.json'))
    for (const lock of nearest(path)) paths.add(lock);
  const pairs = [...paths].sort().map((path) => ({ path,
    base: parseLockfile(path, atBase(path)), head: parseLockfile(path, read(cwd, path)),
  }));
  const declared = declarations(env.PR_BODY);
  const matched = new Set();
  const gates = JSON.parse(readFileSync(gatesURL, 'utf8')).gates;
  const ages = new Map();
  const baseNames = new Set(pairs.flatMap((p) => Object.values(p.base.importers).flatMap(Object.keys)));
  const headNames = new Set(pairs.flatMap((p) => Object.values(p.head.importers).flatMap(Object.keys)));
  for (const { path, base: old, head } of pairs) {
    const { added, majors } = resolutionDiff(old.resolutions, head.resolutions);
    for (const p of added) {
      const from = old.resolutions.filter((q) => q.name === p.name).map((q) => q.version);
      ages.set(`${p.name}@${p.version}`, { ...p, from, path });
    }
    for (const p of majors) {
      const matches = declared.filter((d) => d.kind === 'Dependency-Upgrade' && d.name === p.name &&
        d.to === p.version && p.from.includes(d.from));
      matches.forEach((d) => matched.add(d));
      if (!matches.length) fails.push(`MAJOR: ${path}: ${p.name} ${p.from.join(', ')} -> ${p.version}: needs Dependency-Upgrade: ${p.name} <from> -> ${p.version}`);
      for (const gate of gates.filter((g) => g.package === p.name))
        warnings.push(`migration-gated: ${p.name} ${p.from.join(', ')} -> ${p.version} requires probe ${gate.probe.script} exit ${gate.requiredExit} (${gate.linear})`);
    }
    for (const p of newDirectDependencies(old.importers, head.importers)) {
      const matches = declared.filter((d) => d.kind === 'Dependency-Add' && d.name === p.name);
      matches.forEach((d) => matched.add(d));
      const site = `${path} (${p.importer}): ${p.name} <absent> -> ${p.version ?? p.specifier}`;
      if (!matches.length) fails.push(`NEW TOP-LEVEL: ${site}: needs Dependency-Add: ${p.name}`);
      else for (const existing of baseNames) {
        if (existing !== p.name && headNames.has(existing) && levenshtein(existing, p.name) <= 2)
          fails.push(`NEW TOP-LEVEL: ${site}: typosquat of existing direct dependency ${existing}`);
      }
    }
    // pnpm records an overridden direct dependency's specifier as the override value, so the
    // manifest specifier legitimately differs there (real Jovie lock: sharp ^0.35.5 vs 0.35.5).
    const overridden = new Set(Object.keys(head.overrides ?? {}).map(overrideTarget));
    for (const [importer, locked] of Object.entries(head.importers)) {
      if (posix.isAbsolute(importer) || importer.split('/').includes('..')) throw new Error('invalid importer path');
      const manifest = posix.join(posix.dirname(path), importer, 'package.json');
      const text = read(cwd, manifest);
      if (text === null) continue;
      const deps = depsOf(text);
      for (const pkg of new Set([...Object.keys(deps), ...Object.keys(locked)])) {
        if (!overridden.has(pkg) && deps[pkg] !== locked[pkg]?.specifier)
          fails.push(`LOCKFILE: ${path} (${manifest}): ${pkg} ${locked[pkg]?.specifier ?? '<absent>'} -> ${deps[pkg] ?? '<absent>'}: lockfile missing or out of date`);
      }
    }
  }
  for (const d of declared) if (!matched.has(d)) fails.push(`DECLARATION: stale/incorrect declaration: ${d.raw}`);
  for (const path of changed.filter(isManifest)) {
    const before = atBase(path), after = read(cwd, path);
    const oldSpecs = manifestSpecifiers(path, before);
    const diff = looseDiff(oldSpecs, manifestSpecifiers(path, after));
    warnings.push(`${path}: ${diff.count} remaining loose specifiers`);
    for (const [pkg, spec] of diff.added)
      fails.push(`LOOSE: ${path}: ${pkg} ${oldSpecs[pkg] ?? '<absent>'} -> ${spec}: new or changed loose specifier`);
    if (posix.basename(path) !== 'package.json' || after === null) continue;
    const deps = depsOf(after), oldDeps = depsOf(before), locks = nearest(path);
    if (!Object.keys(deps).length && !Object.keys(oldDeps).length) continue;
    const importerPresent = locks.some((lock) => pairs.find((p) => p.path === lock)?.head.importers[
      posix.relative(posix.dirname(lock), posix.dirname(path)) || '.']);
    if (!locks.length || (!same(deps, oldDeps) && !locks.some((p) => changes.has(p))) || (Object.keys(deps).length && !importerPresent))
      fails.push(`LOCKFILE: ${locks.join(', ') || path}: ${path} dependencies ${JSON.stringify(oldDeps)} -> ${JSON.stringify(deps)}: lockfile missing or out of date`);
  }
  const labels = JSON.parse(env.PR_LABELS || '[]');
  if (!labels.includes('security-advisory')) fails.push(...await ageChecks([...ages.values()], { fetch, now, timeoutMs }));
  return { fails, warnings };
}

export async function run({ cwd = '.', env = process.env, fetch = globalThis.fetch, now = Date.now(), timeoutMs = 10_000 } = {}) {
  try { return await inspect({ cwd, env, fetch, now, timeoutMs }); }
  catch (error) { return { fails: [], warnings: [`lockfile-majors: internal error ${error.message}`] }; }
}
