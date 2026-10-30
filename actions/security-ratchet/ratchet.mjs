// Security ratchet. "Never add, baseline shrinks only."
//   pr:       fail when the PR ref has code-scanning alerts that the base ref does not, at critical/high.
//   baseline: fail when open alerts on the default branch exceed .github/security-baseline.json; --write lowers it.
// Pure helpers are exported for tests. Secret values are never read or printed.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

export const BLOCKING = new Set(['critical', 'high']);

export function severityOf(alert) {
  const s = alert.rule?.security_severity_level;
  if (s) return s;
  return alert.rule?.severity === 'error' ? 'high' : alert.rule?.severity || 'note';
}

export const keyOf = (a) => `${a.rule?.id}|${a.most_recent_instance?.location?.path}|${a.tool?.name}`;

export function newBlocking(prAlerts, baseAlerts) {
  const base = new Set(baseAlerts.map(keyOf));
  return prAlerts.filter((a) => !base.has(keyOf(a)) && BLOCKING.has(severityOf(a)));
}

export function countBySeverity(alerts) {
  const c = { critical: 0, high: 0, medium: 0, low: 0, total: 0 };
  for (const a of alerts) {
    const s = severityOf(a);
    c[s] = (c[s] || 0) + 1;
    c.total += 1;
  }
  return c;
}

export function baselineVerdict(current, baseline) {
  const grew = [];
  for (const k of ['critical', 'high', 'total']) {
    if (current[k] > (baseline[k] ?? Infinity)) grew.push(`${k}: ${baseline[k]} -> ${current[k]}`);
  }
  const lowered = { ...baseline };
  for (const k of ['critical', 'high', 'medium', 'low', 'total']) lowered[k] = Math.min(baseline[k] ?? Infinity, current[k]);
  return { ok: grew.length === 0, grew, lowered };
}

async function api(path) {
  const out = [];
  for (let p = 1; p < 30; p++) {
    const r = await fetch(`https://api.github.com/${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${p}`, {
      headers: { authorization: `Bearer ${process.env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json' },
    });
    if (!r.ok) throw Object.assign(new Error(`${r.status} ${path}`), { status: r.status });
    const page = JSON.parse(await r.text());
    out.push(...page);
    if (page.length < 100) break;
  }
  return out;
}

async function main() {
  const [mode, ...rest] = process.argv.slice(2);
  const repo = process.env.GITHUB_REPOSITORY;
  const file = process.env.BASELINE_FILE || '.github/security-baseline.json';
  const blind = (why) => {
    // A source we cannot read is recorded blind and never blocks a merge.
    console.log(`::warning::security-ratchet blind: ${why}`);
    process.exit(0);
  };
  try {
    if (mode === 'pr') {
      const pr = process.env.PR_NUMBER, base = process.env.BASE_REF || 'main';
      const ref = encodeURIComponent(`refs/pull/${pr}/merge`);
      const deadline = Date.now() + Number(process.env.WAIT_MINUTES || 20) * 60000;
      let ready = false;
      while (Date.now() < deadline && !ready) {
        ready = (await api(`repos/${repo}/code-scanning/analyses?ref=${ref}`)).length > 0;
        if (!ready) await new Promise((r) => setTimeout(r, 30000));
      }
      if (!ready) return blind('no code-scanning analysis for the PR ref before timeout');
      const prA = await api(`repos/${repo}/code-scanning/alerts?state=open&ref=${ref}`);
      const baseA = await api(`repos/${repo}/code-scanning/alerts?state=open&ref=${encodeURIComponent('refs/heads/' + base)}`);
      const added = newBlocking(prA, baseA);
      for (const a of added) console.log(`::error file=${a.most_recent_instance?.location?.path}::new ${severityOf(a)} ${a.rule?.id} (${a.html_url})`);
      process.exit(added.length ? 1 : 0);
    }
    if (mode === 'baseline') {
      const alerts = await api(`repos/${repo}/code-scanning/alerts?state=open`);
      const cur = countBySeverity(alerts);
      if (!existsSync(file)) { writeFileSync(file, JSON.stringify(cur, null, 2) + '\n'); console.log('baseline created', cur); return; }
      const v = baselineVerdict(cur, JSON.parse(readFileSync(file, 'utf8')));
      if (rest.includes('--write')) writeFileSync(file, JSON.stringify(v.lowered, null, 2) + '\n');
      console.log(JSON.stringify({ current: cur, ok: v.ok }));
      if (!v.ok) { console.log(`::error::open alerts grew past baseline: ${v.grew.join(', ')}`); process.exit(1); }
      return;
    }
    console.error('usage: ratchet.mjs pr|baseline [--write]'); process.exit(2);
  } catch (e) {
    if ([403, 404].includes(e.status)) return blind(`${e.message} (code scanning unreadable or disabled)`);
    throw e;
  }
}
if (import.meta.url === `file://${process.argv[1]}`) await main();
