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
  const isData = (f) => any(p.data, f.filename) ||
    (any(p.append, f.filename) && f.deletions === 0 && f.status !== 'removed');
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

async function prFiles(repo, pr, token) {
  const out = [];
  for (let page = 1; page < 11; page++) {
    const r = await fetch(`https://api.github.com/repos/${repo}/pulls/${pr}/files?per_page=100&page=${page}`,
      { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' } });
    if (!r.ok) throw new Error(`pulls files ${r.status}`);
    const rows = await r.json(); out.push(...rows); if (rows.length < 100) break;
  }
  return out;
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
  if (process.env.PR_NUMBER && process.env.GH_TOKEN) {
    const labels = JSON.parse(process.env.PR_LABELS || '[]');
    fails.push(...checkPr(await prFiles(repoFull, process.env.PR_NUMBER, process.env.GH_TOKEN), p, labels));
  }
  return { fails };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const r = await run({ update: process.argv.includes('--update') });
  for (const f of r.fails) console.error(`data-paths: ${f}`);
  if (r.fails.length) process.exit(1);
}
