#!/usr/bin/env node
// Launch guard and freshness scan for public apps (canon/PUBLIC-APP-CERTIFICATION.md).
//
// 1. Classification: every canonical domain and company Vercel project in
//    canon/resources.json is either a surface of a registered app or listed in
//    notApps with a reason. A new public surface cannot appear unclassified.
// 2. Receipts: every app at stage "public" has a passing certification receipt
//    younger than maxReceiptAgeDays, read from its repo's GitHub deployments
//    (environment "certification"). Before an app's enforceFrom date a missing
//    receipt is a warning; after it, a failure. So moving an app to "public"
//    without a passing receipt fails this scan on the registry PR.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('..', import.meta.url);
const read = (p) => JSON.parse(readFileSync(new URL(p, root), 'utf8'));

export function classify(registry, resources, consumers = { repos: [] }) {
  const fails = [];
  // A registered app's repo must get pin bumps, or it never receives the scaffold and guards.
  for (const a of registry.apps) {
    const name = a.repo.split('/')[1];
    if (!consumers.repos.includes(name)) fails.push(`${a.id}: repo ${a.repo} is not in canon/consumers.json, so it never gets the certification scaffold`);
  }
  const covered = new Set();
  for (const a of registry.apps) for (const s of a.surfaces || []) if (s.name) covered.add(`${s.kind}:${s.name}`);
  for (const n of registry.notApps || []) {
    if (!n.reason) fails.push(`notApps ${n.kind}:${n.name} has no reason`);
    covered.add(`${n.kind}:${n.name}`);
  }
  for (const r of resources.resources) {
    const surface = (r.kind === 'domain' || (r.kind === 'vercel-project' && r.team === 'jovie')) && r.status === 'canonical';
    if (surface && !covered.has(`${r.kind}:${r.name}`)) {
      fails.push(`${r.kind} ${r.name} (${r.purpose}) is not classified in canon/public-apps.json: register it as an app surface or list it in notApps with a reason`);
    }
  }
  const ids = registry.apps.map((a) => a.id);
  for (const id of new Set(ids)) if (ids.filter((x) => x === id).length > 1) fails.push(`duplicate app id ${id}`);
  for (const a of registry.apps) {
    if (!['prelaunch', 'public', 'dormant'].includes(a.stage)) fails.push(`${a.id}: bad stage ${a.stage}`);
    if (!['standard', 'health'].includes(a.dataClass)) fails.push(`${a.id}: bad dataClass ${a.dataClass}`);
    if (a.stage !== 'dormant' && !a.enforceFrom) fails.push(`${a.id}: enforceFrom required (default: registration + ${registry.defaultEnforceDays} days)`);
  }
  return fails;
}

/**
 * Decide receipt freshness for one app from its latest certification deployment.
 * @param {{ app: any, latest: null | { state: string, createdAt: string, description?: string }, maxAgeDays: number, now?: number }} input
 */
export function receiptVerdict({ app, latest, maxAgeDays, now = Date.now() }) {
  if (app.stage !== 'public') return { ok: true, level: 'skip' };
  const grace = app.enforceFrom && Date.parse(app.enforceFrom) > now;
  const level = grace ? 'warn' : 'fail';
  if (!latest) return { ok: false, level, reason: `${app.id}: no certification receipt yet` };
  if (latest.state !== 'success') return { ok: false, level, reason: `${app.id}: latest certification is ${latest.state} (${latest.description ?? 'no detail'})` };
  const ageDays = (now - Date.parse(latest.createdAt)) / 86_400_000;
  if (!(ageDays <= maxAgeDays)) return { ok: false, level, reason: `${app.id}: last passing certification is ${ageDays.toFixed(1)} days old (max ${maxAgeDays})` };
  return { ok: true, level: 'ok' };
}

async function latestReceipt(repo, env, token) {
  const h = { Accept: 'application/vnd.github+json', 'User-Agent': 'public-app-scan', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  const deps = await fetch(`https://api.github.com/repos/${repo}/deployments?environment=${env}&per_page=1`, { headers: h });
  if (!deps.ok) throw new Error(`${repo}: deployments ${deps.status}`);
  const [d] = await deps.json();
  if (!d) return null;
  const st = await fetch(`https://api.github.com/repos/${repo}/deployments/${d.id}/statuses?per_page=1`, { headers: h });
  if (!st.ok) throw new Error(`${repo}: statuses ${st.status}`);
  const [s] = await st.json();
  return s ? { state: s.state, createdAt: s.created_at, description: s.description } : { state: 'pending', createdAt: d.created_at };
}

async function main() {
  const registry = read('canon/public-apps.json');
  const fails = classify(registry, read('canon/resources.json'), read('canon/consumers.json'));
  const warns = [];
  for (const app of registry.apps.filter((a) => a.stage === 'public')) {
    let latest;
    try {
      latest = await latestReceipt(app.repo, registry.receiptEnvironment, process.env.GITHUB_TOKEN);
    } catch (err) {
      // Cannot read the store: not green. Strict fold.
      fails.push(`${app.id}: cannot read certification receipts (${err.message})`);
      continue;
    }
    const v = receiptVerdict({ app, latest, maxAgeDays: registry.maxReceiptAgeDays });
    if (!v.ok) (v.level === 'warn' ? warns : fails).push(v.reason + (v.level === 'warn' ? ` (enforced from ${app.enforceFrom})` : ''));
  }
  for (const w of warns) console.log(`::warning::${w}`);
  for (const f of fails) console.error(`::error::${f}`);
  console.log(`public-app-scan: ${fails.length ? 'FAIL' : 'ok'} (${fails.length} failing, ${warns.length} warnings)`);
  if (fails.length) process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
