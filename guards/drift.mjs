#!/usr/bin/env node
// Pin drift: fail when the consumer's pinned ci SHA is more than MAX_AGE_H behind
// the newest commit that touched canon/ or guards/. API failure warns, never passes silently.
import { fileURLToPath } from 'node:url';

export const MAX_AGE_H = 72;

export function evaluate(pinned, commits, now = Date.now()) {
  // commits: newest-first list of {sha, date} touching canon/guards on main.
  const idx = commits.findIndex((c) => c.sha === pinned);
  const unpulled = idx < 0 ? commits : commits.slice(0, idx);
  if (!unpulled.length) return { ok: true };
  const oldest = unpulled[unpulled.length - 1];
  const ageH = (now - Date.parse(oldest.date)) / 3600_000;
  return ageH > MAX_AGE_H
    ? { ok: false, reason: `pin ${String(pinned).slice(0, 8)} is ${unpulled.length} canon/guard commit(s) behind; oldest unpulled is ${ageH.toFixed(0)}h old (limit ${MAX_AGE_H}h)` }
    : { ok: true };
}

async function api(path) {
  const r = await fetch(`https://api.github.com/repos/JovieInc/ci/${path}`, {
    headers: { accept: 'application/vnd.github+json', ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) },
  });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}

async function main() {
  const pinned = process.env.CI_PIN;
  if (!pinned) { console.error('drift: CI_PIN not set'); process.exit(2); }
  try {
    const seen = new Map();
    for (const p of ['canon', 'guards', '.github/workflows/company-guards.yml']) {
      for (const c of await api(`commits?sha=main&path=${encodeURIComponent(p)}&per_page=30`)) seen.set(c.sha, { sha: c.sha, date: c.commit.committer.date });
    }
    const commits = [...seen.values()].sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
    const r = evaluate(pinned, commits);
    if (!r.ok) { console.error(`pin-drift: ${r.reason}`); process.exit(1); }
    console.log('pin-drift: ok');
  } catch (e) {
    console.log(`::warning::pin-drift could not be evaluated (${e.message}); treat as unknown, not green`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
