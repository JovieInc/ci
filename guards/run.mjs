#!/usr/bin/env node
// Runs the shared guard suite in a consumer checkout (cwd).
import { readdirSync, readFileSync, existsSync, lstatSync, readlinkSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { run as size, scopeFor } from './size.mjs';
import { checkMentions, DEFAULT_ALLOWLIST } from './mention.mjs';

export const POINTER = 'JovieInc/ci canon/COMPANY.md';
const HERE = dirname(fileURLToPath(import.meta.url));
const fails = [];

// 1. AGENTS.md is the canonical file and points at the company canon.
//    CLAUDE.md, if present, must be a symlink to AGENTS.md (never the reverse).
const isLink = (f) => lstatSync(f, { throwIfNoEntry: false })?.isSymbolicLink() ?? false;
if (!existsSync('AGENTS.md')) {
  fails.push('agents-pointer: AGENTS.md is missing (it is the canonical agent doc)');
} else {
  if (isLink('AGENTS.md')) {
    fails.push('agents-pointer: AGENTS.md must be the real file; make CLAUDE.md the symlink to it');
  } else if (!readFileSync('AGENTS.md', 'utf8').includes(POINTER)) {
    fails.push(`agents-pointer: AGENTS.md does not contain "${POINTER}"`);
  }
}
if (existsSync('CLAUDE.md') || isLink('CLAUDE.md')) {
  if (!isLink('CLAUDE.md') || readlinkSync('CLAUDE.md') !== 'AGENTS.md') {
    fails.push('agents-pointer: CLAUDE.md must be a symlink to AGENTS.md (ln -s AGENTS.md CLAUDE.md)');
  }
}

// 2. PR body mentions.
if (process.env.PR_BODY) {
  const al = JSON.parse(readFileSync(DEFAULT_ALLOWLIST, 'utf8'));
  for (const v of checkMentions(process.env.PR_BODY, al)) {
    if (v.reason === 'not-allowlisted') fails.push(`mention: PR body mentions @${v.login}, who is not on the allowlist (wrap in backticks or remove)`);
  }
}

// 3. Size ratchet.
// PR / merge_group: only files changed against SIZE_BASE_SHA fail; the rest warn.
// push to main (or a missing/unusable base): repo-wide, red.
const sizeResult = size({ cwd: '.', scope: scopeFor() });
fails.push(...sizeResult.fails.map((f) => `size-500: ${f}`));
const sizeWarnings = sizeResult.warnings.map((f) => `size-500 (pre-existing, not in this change): ${f}`);

// 4. Plugins (JOV-9975 and later).
// A plugin registered with mode "shadow" in canon/guards.json reports as
// warnings while it qualifies (no consumer goes red on a pin bump); flip the
// registry entry to "ratchet" to enforce.
const pdir = join(HERE, 'plugins');
const registry = JSON.parse(readFileSync(join(HERE, '..', 'canon', 'guards.json'), 'utf8'));
const modeOf = (id) => registry.guards.find((g) => g.id === id)?.mode ?? 'ratchet';
const warnings = [...sizeWarnings];
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
