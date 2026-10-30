#!/usr/bin/env node
// Daily resource drift scan. Lists actual GitHub repos (JovieInc, meetjovie, personal),
// Vercel projects and Doppler projects, compares with canon/resources.json and emits a
// report of duplicates / unregistered / orphaned resources with a PROPOSED action.
// Never deletes anything. Sources without credentials are reported as skipped.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function classify(registry, actual) {
  const findings = [];
  const byKey = new Map(registry.resources.map((r) => [`${r.kind}:${r.name.toLowerCase()}`, r]));
  const seen = new Set();
  for (const [kind, names] of Object.entries(actual)) {
    for (const name of names) {
      const key = `${kind}:${name.toLowerCase()}`;
      seen.add(key);
      const e = byKey.get(key);
      if (!e) {
        const nonCanon = kind === 'github-repo' && registry.nonCanonicalGithubOwners.includes(name.split('/')[0]);
        findings.push({ kind, name, type: 'unregistered', proposedAction: nonCanon ? 'migrate to JovieInc if needed, else archive (needs Tim\'s yes)' : 'register with owner and purpose, or delete (needs Tim\'s yes)' });
      } else if (['duplicate', 'unregistered', 'dormant', 'shadow'].includes(e.status)) {
        findings.push({ kind, name, type: e.status, proposedAction: e.proposedAction || 'review (needs Tim\'s yes)' });
      }
    }
  }
  for (const r of registry.resources) {
    if (r.status === 'canonical' && actual[r.kind] && !seen.has(`${r.kind}:${r.name.toLowerCase()}`)) {
      findings.push({ kind: r.kind, name: r.name, type: 'orphaned', proposedAction: 'registry entry has no live resource: remove entry or recreate' });
    }
  }
  return findings;
}

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });

export function collect(registry) {
  const actual = {}; const skipped = [];
  try {
    const repos = [];
    for (const o of ['JovieInc', ...registry.nonCanonicalGithubOwners]) {
      for (const r of JSON.parse(sh('gh', ['repo', 'list', o, '--limit', '200', '--json', 'name,isArchived']))) if (!r.isArchived) repos.push(`${o}/${r.name}`);
    }
    actual['github-repo'] = repos;
  } catch (e) { skipped.push(`github: ${e.message.split('\n')[0]}`); }
  try {
    const names = [];
    for (const scope of ['jovie', 'tim-white-s-team']) {
      const out = sh('vercel', ['project', 'ls', '--scope', scope]);
      let on = false;
      for (const l of out.split('\n')) { if (/^\s*Project Name/.test(l)) { on = true; continue; } if (on && l.trim()) { const n = l.trim().split(/\s+/)[0]; if (/^[a-z0-9][\w.-]*$/i.test(n)) names.push(n); } }
    }
    actual['vercel-project'] = [...new Set(names)];
  } catch (e) { skipped.push(`vercel: ${e.message.split('\n')[0]}`); }
  try { actual['doppler-project'] = JSON.parse(sh('doppler', ['projects', '--json'])).map((p) => p.name); }
  catch (e) { skipped.push(`doppler: ${e.message.split('\n')[0]}`); }
  return { actual, skipped };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const registry = JSON.parse(readFileSync(new URL('../canon/resources.json', import.meta.url), 'utf8'));
  const { actual, skipped } = collect(registry);
  const findings = classify(registry, actual);
  console.log(JSON.stringify({ scannedAt: new Date().toISOString(), skipped, counts: Object.fromEntries(Object.entries(actual).map(([k, v]) => [k, v.length])), findings }, null, 1));
}
