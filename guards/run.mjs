#!/usr/bin/env node
// Runs the shared guard suite in a consumer checkout (cwd).
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { run as size } from './size.mjs';
import { checkMentions, DEFAULT_ALLOWLIST } from './mention.mjs';

export const POINTER = 'JovieInc/ci canon/COMPANY.md';
const HERE = dirname(fileURLToPath(import.meta.url));
const fails = [];

// 1. AGENTS.md (or CLAUDE.md) points at the company canon.
const docs = ['AGENTS.md', 'CLAUDE.md'].filter((f) => existsSync(f));
if (!docs.some((f) => readFileSync(f, 'utf8').includes(POINTER))) {
  fails.push(`agents-pointer: no AGENTS.md/CLAUDE.md contains "${POINTER}"`);
}

// 2. PR body mentions.
if (process.env.PR_BODY) {
  const al = JSON.parse(readFileSync(DEFAULT_ALLOWLIST, 'utf8'));
  for (const v of checkMentions(process.env.PR_BODY, al)) {
    if (v.reason === 'not-allowlisted') fails.push(`mention: PR body mentions @${v.login}, who is not on the allowlist (wrap in backticks or remove)`);
  }
}

// 3. Size ratchet.
fails.push(...size({ cwd: '.' }).fails.map((f) => `size-500: ${f}`));

// 4. Plugins (JOV-9975 and later).
// A plugin registered with mode "shadow" in canon/guards.json reports as
// warnings while it qualifies (no consumer goes red on a pin bump); flip the
// registry entry to "ratchet" to enforce.
const pdir = join(HERE, 'plugins');
const registry = JSON.parse(readFileSync(join(HERE, '..', 'canon', 'guards.json'), 'utf8'));
const modeOf = (id) => registry.guards.find((g) => g.id === id)?.mode ?? 'ratchet';
const warnings = [];
for (const f of readdirSync(pdir).filter((x) => x.endsWith('.mjs'))) {
  const m = await import(pathToFileURL(join(pdir, f)).href);
  const r = await m.run({ cwd: '.', baselineDir: '.company-guards' });
  const sink = modeOf(m.name) === 'shadow' ? warnings : fails;
  sink.push(...(r.fails || []).map((x) => `${m.name}: ${x}`));
  warnings.push(...(r.warnings || []).map((x) => `${m.name}: ${x}`));
}

for (const w of warnings) console.log(`::warning::${w}`);
for (const f of fails) console.error(`::error::${f}`);
console.log(`company-guards: ${fails.length ? 'FAIL' : 'ok'} (${fails.length})`);
if (fails.length) process.exit(1);
