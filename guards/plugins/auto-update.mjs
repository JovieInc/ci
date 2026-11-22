// Company guard: every repo updates itself on the company policy.
// Policy: canon/update-policy.json (rules + limits), prose policy/UPDATE-POLICY.md.
// Checks the consumer checkout (tracked files only, no network):
//   1. an update config exists (.github/dependabot.yml or a Renovate config),
//   2. each shipped ecosystem (npm, pip, docker, github-actions) has an entry,
//      and each package.json with dependencies sits under an npm directory,
//   3. npm/pip entries that open version PRs set a cooldown (min release age),
//   4. third-party `uses:` refs are full 40-char SHAs,
//   5. a workflow lands Dependabot PRs (fetch-metadata or the shared wrapper),
//   6. each ignore (hold) cites a date or a Linear key; dated holds expire,
//   7. .nvmrc / .node-version major is the Active LTS major,
//   8. wrangler compatibility_date is not stale.
// Registered in shadow (warnings) until consumers are clean, then ratchet.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { posix, join } from 'node:path';

export const name = 'auto-update';
const POLICY = new URL('../../canon/update-policy.json', import.meta.url);
const DAY = 86_400_000;
const SHA = /^[0-9a-f]{40}$/;
const RENOVATE = ['renovate.json', 'renovate.json5', '.renovaterc', '.renovaterc.json', '.github/renovate.json', '.github/renovate.json5'];

export const loadPolicy = () => JSON.parse(readFileSync(POLICY, 'utf8'));

/** Minimal line parser for .github/dependabot.yml update entries. */
export function parseDependabot(text) {
  const entries = [];
  let cur = null;
  let list = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '');
    let m;
    if ((m = line.match(/^\s*-\s*package-ecosystem:\s*['"]?([\w-]+)['"]?/))) {
      cur = { ecosystem: m[1], directories: [], cooldown: false, limit: null };
      entries.push(cur); list = null; continue;
    }
    if (!cur) continue;
    if ((m = line.match(/^\s*directory:\s*['"]?([^'"\s]+)['"]?/))) { cur.directories.push(m[1]); list = null; continue; }
    if (/^\s*directories:\s*$/.test(line)) { list = 'dirs'; continue; }
    if (list === 'dirs' && (m = line.match(/^\s*-\s*['"]?([^'"\s]+)['"]?\s*$/))) { cur.directories.push(m[1]); continue; }
    if (/^\s*cooldown:/.test(line)) cur.cooldown = true;
    if ((m = line.match(/^\s*open-pull-requests-limit:\s*(\d+)/))) cur.limit = Number(m[1]);
    if (/^\s*[\w-]+:/.test(line)) list = null;
  }
  return entries;
}

const norm = (d) => posix.normalize(`/${d}`).replace(/\/+$/, '') || '/';
const dirGlob = (g) => new RegExp(`^${norm(g).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]+').replace(/\u0000/g, '.*')}$`);
const covers = (entryDir, dir, isWorkspace) => {
  const e = norm(entryDir);
  if (dirGlob(e).test(dir)) return true;
  return isWorkspace(e) && (e === '/' ? true : dir.startsWith(`${e}/`));
};

/** Holds: each `dependency-name` under ignore needs a date or Linear key nearby. */
export function holdFindings(text, { now, maxAgeDays }) {
  const lines = text.split('\n');
  const out = [];
  lines.forEach((line, i) => {
    const m = line.match(/^\s*-\s*dependency-name:\s*['"]?([^'"\s]+)/);
    if (!m) return;
    let date = null;
    let linear = false;
    for (let j = i; j >= Math.max(0, i - 40); j--) {
      const l = lines[j];
      if (j < i && /^\s*(ignore:|-\s*package-ecosystem:)/.test(l)) break;
      if (!/#/.test(l)) continue;
      const comment = l.slice(l.indexOf('#'));
      if (/\bJOV-\d+\b|linear\.app\//.test(comment)) linear = true;
      const d = comment.match(/\b(20\d\d-\d\d-\d\d)\b/);
      if (d && !date) date = d[1];
    }
    if (date) {
      const age = Math.floor((now - Date.parse(`${date}T00:00:00Z`)) / DAY);
      if (age > maxAgeDays) out.push(`hold on ${m[1]} dated ${date} is ${age} days old (limit ${maxAgeDays}); re-evaluate and drop or re-date it`);
    } else if (!linear) {
      out.push(`hold on ${m[1]} has no dated re-evaluate note or Linear key`);
    }
  });
  return out;
}

/** Third-party action refs that are not full commit SHAs. */
export function unpinnedActions(path, text) {
  const out = [];
  for (const m of text.matchAll(/^\s*(?:-\s*)?uses:\s*['"]?([^'"\s#]+)/gm)) {
    const ref = m[1];
    if (ref.startsWith('./') || ref.startsWith('docker://')) continue;
    const at = ref.lastIndexOf('@');
    const pin = at === -1 ? '' : ref.slice(at + 1);
    if (pin.startsWith('<') || pin.startsWith('${{')) continue; // template placeholder
    if (!SHA.test(pin)) out.push(`${path}: ${ref} is not pinned to a full commit SHA`);
  }
  return out;
}

const tracked = (cwd) => {
  try { return execFileSync('git', ['ls-files'], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n').filter(Boolean); }
  catch { return []; }
};

export async function run({ cwd = '.', now = Date.now(), files } = {}) {
  const policy = loadPolicy();
  const { maxHoldAgeDays, wranglerMaxAgeDays, nodeActiveLtsMajor } = policy.limits;
  const list = (files ?? tracked(cwd)).filter((f) => !f.startsWith('.company-ci/') && !f.includes('node_modules/'));
  const read = (f) => readFileSync(join(cwd, f), 'utf8');
  const fails = [];

  const workflows = list.filter((f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f));
  const actionFiles = list.filter((f) => /(^|\/)action\.ya?ml$/.test(f) && !f.startsWith('templates/'));
  for (const f of [...workflows, ...actionFiles]) fails.push(...unpinnedActions(f, read(f)));

  const hasRenovate = RENOVATE.some((f) => list.includes(f));
  const depPath = ['.github/dependabot.yml', '.github/dependabot.yaml'].find((f) => list.includes(f));
  if (!depPath && !hasRenovate) {
    fails.push('no auto-update config: add .github/dependabot.yml covering every ecosystem (policy/UPDATE-POLICY.md)');
  } else if (depPath) {
    const text = read(depPath);
    const entries = parseDependabot(text);
    const isWorkspace = (dir) => {
      const base = dir === '/' ? '' : dir.slice(1) + '/';
      if (list.includes(`${base}pnpm-workspace.yaml`)) return true;
      const pkg = `${base}package.json`;
      try { return list.includes(pkg) && Boolean(JSON.parse(read(pkg)).workspaces); } catch { return false; }
    };
    const need = new Map(); // ecosystem -> [dirs]
    const add = (eco, f) => need.set(eco, [...(need.get(eco) ?? []), norm(posix.dirname(f))]);
    for (const f of list) {
      const b = posix.basename(f);
      if (b === 'package.json') {
        let pkg = {};
        try { pkg = JSON.parse(read(f)); } catch { continue; }
        if (Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies }).length) add('npm', f);
      } else if (/^requirements[\w.-]*\.txt$/.test(b) || b === 'pyproject.toml') add('pip', f);
      else if (/^Dockerfile/.test(b)) add('docker', f);
    }
    if (workflows.length || actionFiles.length) need.set('github-actions', ['/', ...actionFiles.map((f) => norm(posix.dirname(f)))]);
    for (const [eco, dirs] of need) {
      const mine = entries.filter((e) => e.ecosystem === eco);
      if (!mine.length) { fails.push(`${depPath}: no ${eco} entry, but the repo ships ${eco} manifests (${dirs[0]})`); continue; }
      for (const d of new Set(dirs)) {
        const ws = eco === 'github-actions' ? () => false : isWorkspace;
        if (!mine.some((e) => e.directories.some((x) => covers(x, d, ws)))) fails.push(`${depPath}: ${eco} manifest in ${d} is not covered by any update directory`);
      }
    }
    for (const e of entries) {
      if (['npm', 'pip'].includes(e.ecosystem) && e.limit !== 0 && !e.cooldown) fails.push(`${depPath}: ${e.ecosystem} ${e.directories.join(',')} has no cooldown (minimum release age)`);
    }
    fails.push(...holdFindings(text, { now, maxAgeDays: maxHoldAgeDays }).map((x) => `${depPath}: ${x}`));
    const lane = workflows.some((f) => /dependabot\/fetch-metadata|JovieInc\/ci\/\.github\/workflows\/dependabot-auto-merge\.yml/.test(read(f)));
    if (!lane) fails.push('no Dependabot auto-merge lane: add a workflow that lands patch/minor PRs on green (see JovieInc/ci dependabot-auto-merge.yml)');
  }

  for (const f of ['.nvmrc', '.node-version'].filter((x) => list.includes(x))) {
    const major = Number(read(f).trim().replace(/^v/, '').split('.')[0]);
    if (Number.isFinite(major) && major < nodeActiveLtsMajor) fails.push(`${f}: Node ${major} is behind the Active LTS major ${nodeActiveLtsMajor}`);
  }
  for (const f of list.filter((x) => /(^|\/)wrangler\.toml$/.test(x))) {
    const m = read(f).match(/^\s*compatibility_date\s*=\s*"(\d{4}-\d\d-\d\d)"/m);
    if (!m) continue;
    const age = Math.floor((now - Date.parse(`${m[1]}T00:00:00Z`)) / DAY);
    if (age > wranglerMaxAgeDays) fails.push(`${f}: compatibility_date ${m[1]} is ${age} days old (limit ${wranglerMaxAgeDays})`);
  }
  return { fails };
}
