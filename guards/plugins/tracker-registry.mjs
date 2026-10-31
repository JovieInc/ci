// Tracker registry guard (compliance loop, change gate).
//
// Every third-party tracker, pixel, session replay or chat widget referenced
// in source must be approved in the consumer's canon/privacy/tracker-registry.json
// (vendor with the same id or an overlapping host, plus a rationale). Privacy
// claims that cannot be literally true ("we don't track you") fail.
// Ratchet: existing findings live in .company-guards/tracker-registry-baseline.json
// and only new ones fail. Shadow: a repo with no registry gets notices, not
// fails, until it adds one. Canon: gbrain
// decisions/company/privacy-tracking-compliance-guidelines-2026-10-31.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'tracker-registry';
export const REGISTRY = 'canon/privacy/tracker-registry.json';
const HERE = dirname(fileURLToPath(import.meta.url));
const CATALOG = join(HERE, '..', '..', 'canon', 'trackers.json');
const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|html|vue|svelte|swift|kt)$/;
const COPY = /\.(md|mdx|tsx|ts|html|json)$/;
const COPY_PATH = /(legal|privacy|cookie|terms|marketing|landing|content|copy|messages)/i;
const SKIP = /(^|\/)(node_modules|vendor|dist|build|\.next|Pods|fixtures?|__fixtures__|__mocks__)\/|\.(test|spec|stories)\.|\.min\.|lock|(^|\/)canon\/(privacy\/tracker-registry|trackers)\.json$|(^|\/)\.company-guards\//;

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function compileCatalog(catalog) {
  return catalog.signatures.map((s) => ({
    ...s,
    res: [...(s.hosts ?? []).map((h) => new RegExp(escape(h), 'i')), ...(s.code ?? []).map((c) => new RegExp(c))],
  }));
}

function hostCovered(sigHost, vendorHosts) {
  const h = sigHost.split('/')[0];
  return vendorHosts.some((v) => h === v || h.endsWith(`.${v}`) || v.endsWith(`.${h}`));
}

export function approved(sig, registry) {
  return (registry?.vendors ?? []).some(
    (v) => v.rationale && (v.id === sig.id || (sig.hosts ?? []).some((h) => hostCovered(h, v.hosts ?? []))),
  );
}

/** Findings for one file: [{key, message}] */
export function scanFile(path, text, sigs, registry, claims) {
  const out = [];
  if (CODE.test(path) || path.endsWith('package.json')) {
    for (const sig of sigs) {
      if (approved(sig, registry)) continue;
      if (sig.res.some((re) => re.test(text))) {
        out.push({ key: `tracker:${sig.id}:${path}`, message: `${path}: ${sig.category} "${sig.id}" is not approved in ${REGISTRY} (add a vendor entry with a rationale)` });
      }
    }
  }
  if (COPY.test(path) && COPY_PATH.test(path)) {
    for (const source of claims) {
      if (new RegExp(source, 'i').test(text)) {
        out.push({ key: `claim:${source}:${path}`, message: `${path}: privacy claim /${source}/ cannot be literally true while any pixel runs` });
      }
    }
  }
  return out;
}

export function invalidEntries(registry) {
  return (registry?.vendors ?? [])
    .filter((v) => !v.id || !v.category || !(v.hosts ?? []).length || !v.rationale)
    .map((v) => `${REGISTRY}: vendor "${v.id ?? '?'}" needs id, category, hosts and rationale`);
}

export async function run({ cwd = '.', baselineDir = '.company-guards', update = false } = {}) {
  const catalog = JSON.parse(readFileSync(CATALOG, 'utf8'));
  const regPath = join(cwd, REGISTRY);
  const registry = existsSync(regPath) ? JSON.parse(readFileSync(regPath, 'utf8')) : null;
  const sigs = compileCatalog(catalog);
  const claims = [...new Set([...catalog.banned_claims, ...(registry?.banned_claims ?? [])])];
  const files = execFileSync('git', ['ls-files'], { cwd, encoding: 'utf8' }).split('\n').filter((f) => f && !SKIP.test(f));
  const findings = [];
  for (const f of files) {
    if (!CODE.test(f) && !COPY.test(f)) continue;
    let text;
    try { text = readFileSync(join(cwd, f), 'utf8'); } catch { continue; }
    if (text.length > 2_000_000) continue;
    findings.push(...scanFile(f, text, sigs, registry, claims));
  }
  const basePath = join(cwd, baselineDir, `${name}-baseline.json`);
  if (update) {
    mkdirSync(join(cwd, baselineDir), { recursive: true });
    writeFileSync(basePath, `${JSON.stringify([...new Set(findings.map((x) => x.key))].sort(), null, 2)}\n`);
    return { fails: [], count: findings.length };
  }
  const baseline = new Set(existsSync(basePath) ? JSON.parse(readFileSync(basePath, 'utf8')) : []);
  const fresh = findings.filter((x) => !baseline.has(x.key)).map((x) => x.message);
  if (!registry) {
    for (const m of fresh) console.log(`::notice::${name} (shadow, no ${REGISTRY}): ${m}`);
    return { fails: [], count: findings.length };
  }
  return { fails: [...invalidEntries(registry), ...fresh], count: findings.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const r = await run({ update: process.argv.includes('--update') });
  for (const f of r.fails) console.error(`${name}: ${f}`);
  console.log(`${name}: ${r.count} finding(s) seen, ${r.fails.length} new`);
  if (r.fails.length) process.exit(1);
}
