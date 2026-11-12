// Data is not shipped as PRs. Policy: canon/data-paths.json (ci only).
//  1. PR check: fail when every changed file is a data path, or an append-only
//     file receiving only added lines. Label `data-exception` waives it.
//  2. Ratchet: tracked data-path files may only shrink. Baseline:
//     .company-guards/data-paths-baseline.json ({files:[...]}); missing = warn.
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const name = 'data-paths';
const HERE = dirname(fileURLToPath(import.meta.url));
export const POLICY = join(HERE, '../../canon/data-paths.json');

export function globToRe(g) {
  let s = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') { s += '.*'; i++; if (g[i + 1] === '/') i++; }
    else if (c === '*') s += '[^/]*';
    else s += c.replace(/[.+^${}()|[\]\\?]/g, '\\$&');
  }
  return new RegExp(`^${s}$`);
}
export function policyFor(policy, repo) {
  const r = policy.repos?.[repo] ?? {};
  const cat = (k) => [...(policy.default?.[k] ?? []), ...(r[k] ?? [])].map(globToRe);
  return { data: cat('dataPaths'), append: cat('appendOnly'), label: policy.exceptionLabel };
}
const any = (res, f) => res.some((re) => re.test(f));

/** files: [{filename,status,additions,deletions}] */
export function checkPr(files, p, labels = []) {
  if (labels.includes(p.label) || !files.length) return [];
  const isData = (f) => f.status !== 'removed' && (any(p.data, f.filename) ||
    (any(p.append, f.filename) && f.deletions === 0));
  if (files.every(isData)) {
    return [`PR changes only data (${files.map((f) => f.filename).slice(0, 3).join(', ')}${files.length > 3 ? ', ...' : ''}). ` +
      'Write it to the runtime store instead of opening a PR (see canon/COMPANY.md "Data vs behaviour"), or label the PR data-exception.'];
  }
  return [];
}
export function ratchet(tracked, p, baseline) {
  const cur = tracked.filter((f) => any(p.data, f));
  if (!baseline) return { fails: [], warn: `no baseline; run with --update (${cur.length} data files tracked)`, cur };
  const base = new Set(baseline.files);
  return { fails: cur.filter((f) => !base.has(f)).map((f) => `${f}: new data file in git (baseline may only shrink)`), cur };
}

// Hermetic: the PR's changed files come from local git, never from the GitHub API,
// so the guard needs no pull-requests permission and no network. The base is
// SIZE_BASE_SHA when the caller sets it (same base as the size ratchet), else the
// pull_request merge commit's first parent (needs checkout fetch-depth >= 2).
const STATUS = { A: 'added', M: 'modified', D: 'removed', T: 'modified' };
export function prFilesFromGit(cwd = '.', baseSha = '') {
  const git = (args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28 });
  if (!baseSha) {
    const parents = git(['rev-list', '--parents', '-n', '1', 'HEAD']).trim().split(' ').slice(1);
    if (parents.length < 2) throw new Error('HEAD is not the pull_request merge commit with its base parent (checkout fetch-depth must be >= 2)');
  }
  const range = [baseSha || 'HEAD^1', 'HEAD'];
  const files = new Map();
  const status = git(['diff', '--no-renames', '--name-status', '-z', ...range]).split('\0');
  for (let i = 0; i + 1 < status.length; i += 2) {
    const [code, filename] = [status[i], status[i + 1]];
    files.set(filename, { filename, status: STATUS[code[0]] ?? 'modified', additions: 0, deletions: 0 });
  }
  for (const row of git(['diff', '--no-renames', '--numstat', '-z', ...range]).split('\0').filter(Boolean)) {
    const [add, del, filename] = row.split('\t');
    const f = files.get(filename);
    if (f) { f.additions = add === '-' ? 1 : Number(add); f.deletions = del === '-' ? 1 : Number(del); }
  }
  return [...files.values()];
}

export async function run({ cwd = '.', update = false } = {}) {
  const repoFull = process.env.GITHUB_REPOSITORY ?? '';
  const p = policyFor(JSON.parse(readFileSync(POLICY, 'utf8')), repoFull.split('/')[1] ?? '');
  const fails = [];
  const bpath = join(cwd, '.company-guards/data-paths-baseline.json');
  const tracked = execFileSync('git', ['ls-files'], { cwd, encoding: 'utf8' }).split('\n').filter(Boolean);
  const baseline = existsSync(bpath) ? JSON.parse(readFileSync(bpath, 'utf8')) : null;
  const r = ratchet(tracked, p, baseline);
  if (update) {
    mkdirSync(join(cwd, '.company-guards'), { recursive: true });
    const keep = baseline ? r.cur.filter((f) => baseline.files.includes(f)) : r.cur;
    writeFileSync(bpath, JSON.stringify({ files: keep }, null, 2) + '\n');
    return { fails: [] };
  }
  fails.push(...r.fails);
  if (r.warn) console.warn(`::warning::data-paths: ${r.warn}`);
  if (process.env.GITHUB_EVENT_NAME === 'pull_request') {
    const labels = JSON.parse(process.env.PR_LABELS || '[]');
    try {
      fails.push(...checkPr(prFilesFromGit(cwd, process.env.SIZE_BASE_SHA), p, labels));
    } catch (error) {
      fails.push(`PR file validation unavailable: ${error.message}; no PR verdict was produced.`);
    }
  }
  return { fails };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const r = await run({ update: process.argv.includes('--update') });
  for (const f of r.fails) console.error(`data-paths: ${f}`);
  if (r.fails.length) process.exit(1);
}
