#!/usr/bin/env node
// Refuse @login mentions that are not on the allowlist; limit agent mentions to
// one per person per hour. Pure functions plus a small CLI.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ALLOWLIST = join(HERE, '..', 'canon', 'mention-allowlist.json');

export function extractMentions(text) {
  const stripped = String(text)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ');
  const out = [];
  const re = /(?<![\w@./`-])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}[A-Za-z0-9])?(?:\[bot\])?)(?![\w-]*\/|\w*\.\w)/g;
  for (const m of stripped.matchAll(re)) out.push(m[1]);
  return [...new Set(out)];
}

export function checkMentions(text, allowlist, { state = {}, now = Date.now() } = {}) {
  const people = new Set(allowlist.people.map((s) => s.toLowerCase()));
  const bots = new Set(allowlist.bots.map((s) => s.toLowerCase()));
  const windowMs = 3600_000;
  const violations = [];
  for (const login of extractMentions(text)) {
    const l = login.toLowerCase();
    if (bots.has(l)) continue;
    if (!people.has(l)) {
      violations.push({ login, reason: 'not-allowlisted' });
      continue;
    }
    const last = state[l];
    if (typeof last === 'number' && now - last < windowMs) {
      violations.push({ login, reason: 'rate-limited', retryInMs: windowMs - (now - last) });
    }
  }
  return violations;
}

export function recordMentions(text, allowlist, state, now = Date.now()) {
  const people = new Set(allowlist.people.map((s) => s.toLowerCase()));
  for (const login of extractMentions(text)) {
    if (people.has(login.toLowerCase())) state[login.toLowerCase()] = now;
  }
  return state;
}

function main(argv) {
  const get = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  const file = get('--file');
  const text = file ? readFileSync(file, 'utf8') : readFileSync(0, 'utf8');
  const allowlist = JSON.parse(readFileSync(get('--allowlist') || DEFAULT_ALLOWLIST, 'utf8'));
  const statePath = get('--state');
  const state = statePath && existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
  const bad = checkMentions(text, allowlist, { state });
  for (const v of bad) console.error(`mention-guard: refusing @${v.login} (${v.reason})`);
  if (bad.length) process.exit(1);
  if (statePath && argv.includes('--record')) writeFileSync(statePath, JSON.stringify(recordMentions(text, allowlist, state)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
