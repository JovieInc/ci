#!/usr/bin/env node
// Tooling registry guard. canon/tooling.json lists every skill, plugin, MCP server, CLI, hook and worker.
//   check                      validate registry shape (CI, runs everywhere)
//   inventory [--home DIR]     print installed inventory JSON from a machine (skills, plugins, mcp, hooks)
//   scan --inventory FILE      fail on installed-but-unregistered or registered-but-missing (non-retired)
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REGISTRY = join(HERE, '..', 'canon', 'tooling.json');
const KINDS = ['skill', 'plugin', 'mcp', 'cli', 'hook', 'worker'];
const STATUS = ['active', 'candidate-slim', 'proposed-removal', 'retired'];
const REQUIRED = ['id', 'kind', 'name', 'purpose', 'whenToUse', 'owner', 'status'];
// A machine scan only covers entries whose source is a ~/ path; repo, claude.ai, cli and worker entries are registry-only.
const SCANNED = ['skill', 'plugin', 'mcp', 'hook'];

export function validate(reg) {
  const errs = [];
  const ids = new Set();
  for (const e of reg.entries || []) {
    for (const f of REQUIRED) if (!e[f]) errs.push(`${e.id || e.name}: missing ${f}`);
    if (!KINDS.includes(e.kind)) errs.push(`${e.id}: bad kind ${e.kind}`);
    if (!STATUS.includes(e.status)) errs.push(`${e.id}: bad status ${e.status}`);
    if (e.id !== `${e.kind}:${e.name}`) errs.push(`${e.id}: id must be kind:name`);
    if (ids.has(e.id)) errs.push(`${e.id}: duplicate`);
    ids.add(e.id);
  }
  return errs;
}

export function diff(reg, inventory) {
  const reg_ = new Set((reg.entries || []).filter((e) => SCANNED.includes(e.kind) && e.status !== 'retired' && /^~\//.test(e.source || '')).map((e) => e.id));
  const inst = new Set(Object.entries(inventory).flatMap(([kind, names]) => names.map((n) => `${kind}:${n}`)));
  return {
    unregistered: [...inst].filter((i) => !reg_.has(i)).sort(),
    missing: [...reg_].filter((i) => !inst.has(i)).sort(),
  };
}

export function inventory(home) {
  const ls = (p) => (existsSync(p) ? readdirSync(p) : []);
  const json = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {});
  const settings = json(join(home, '.claude/settings.json'));
  const hooks = Object.values(settings.hooks || {}).flat().flatMap((g) => g.hooks || [])
    .map((h) => (h.command || '').split(/\s+/).pop().split('/').pop().replace(/\.(sh|py|mjs)$/, '')).filter(Boolean);
  return {
    skill: ls(join(home, '.claude/skills')).filter((d) => existsSync(join(home, '.claude/skills', d, 'SKILL.md'))),
    plugin: Object.keys(settings.enabledPlugins || {}).map((k) => k.split('@')[0]),
    mcp: Object.keys(json(join(home, '.claude.json')).mcpServers || {}),
    hook: [...new Set(hooks)],
  };
}

function main(argv) {
  const get = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  const reg = JSON.parse(readFileSync(get('--registry') || DEFAULT_REGISTRY, 'utf8'));
  if (argv[0] === 'check') {
    const errs = validate(reg);
    if (errs.length) { console.error(errs.join('\n')); process.exit(1); }
    console.log(`ok: ${reg.entries.length} entries`);
  } else if (argv[0] === 'inventory') {
    console.log(JSON.stringify(inventory(get('--home') || process.env.HOME), null, 1));
  } else if (argv[0] === 'scan') {
    const d = diff(reg, JSON.parse(readFileSync(get('--inventory'), 'utf8')));
    for (const u of d.unregistered) console.error(`unregistered (add to canon/tooling.json): ${u}`);
    for (const m of d.missing) console.error(`registered but not installed (retire or fix): ${m}`);
    if (d.unregistered.length || d.missing.length) process.exit(1);
    console.log('ok: installed matches registry');
  } else { console.error('usage: tooling-drift.mjs check|inventory|scan'); process.exit(2); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
