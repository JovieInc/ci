#!/usr/bin/env node
// Tooling registry guard. canon/tooling.json lists every skill, plugin, MCP server, CLI, hook and worker.
//   check                      validate registry shape (CI, runs everywhere)
//   inventory [--home DIR]     print installed inventory JSON from a machine (skills, plugins, mcp, hooks)
//   scan --inventory FILE      fail on installed-but-unregistered or registered-but-missing (non-retired)
//   versions --readback FILE --upstream FILE  compare version receipts offline
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
const VERSIONED = ['cli', 'mcp', 'worker'];
const RUNTIME_FIELDS = ['declaredVersion', 'pinSource', 'updateChannel'];
const DAY_MS = 86_400_000;

function versionParts(version) {
  if (typeof version !== 'string' || !/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) return null;
  const parts = version.replace(/^v/, '').split('.').map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}

function utcDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value ? timestamp : NaN;
}

export function versionReport(reg, readback, upstream, policy, now = new Date()) {
  return reg.entries.filter(e => VERSIONED.includes(e.kind) && e.status !== 'retired').map(e => {
    const { declaredVersion, pinSource, updateChannel } = e.runtime;
    const installed = readback[e.id];
    const observed = versionParts(installed?.version);
    const observedAt = utcDate(installed?.observedDate);
    const release = upstream[e.id];
    const latest = versionParts(release?.version);
    const releasedAt = utcDate(release?.releasedDate);
    const observedValid = observed && observedAt <= now.getTime();
    const upstreamValid = latest && releasedAt <= now.getTime() && typeof release.security === 'boolean';
    const result = {
      id: e.id, declaredVersion, pinSource, updateChannel,
      observedVersion: observedValid ? installed.version : null,
      observedDate: observedValid ? installed.observedDate : null,
      upstreamVersion: upstreamValid ? release.version : null,
    };
    if (!observedValid) return { ...result, status: 'unverified-readback' };
    if (!upstreamValid) return { ...result, status: 'unverified-upstream' };
    const firstDifference = latest.findIndex((part, index) => part !== observed[index]);
    if (firstDifference === -1) return { ...result, status: 'current' };
    if (latest[firstDifference] < observed[firstDifference]) return { ...result, status: 'ahead-of-source' };
    const breaking = firstDifference === 0 || (firstDifference === 1 && observed[0] === 0);
    let tier = firstDifference === 1 ? 'minor' : 'patch';
    if (breaking) tier = 'major';
    if (release.security) tier = 'security';
    const eligibleAt = releasedAt + policy.tiers[tier].minReleaseAgeDays * DAY_MS;
    if (now.getTime() < eligibleAt) return { ...result, status: 'cooldown', tier };
    if (observedAt < eligibleAt) return { ...result, status: 'readback-before-eligibility', tier };
    return { ...result, status: 'drift', tier };
  });
}

export function validate(reg) {
  const errs = [];
  const ids = new Set();
  for (const e of reg.entries || []) {
    for (const f of REQUIRED) if (!e[f]) errs.push(`${e.id || e.name}: missing ${f}`);
    if (!KINDS.includes(e.kind)) errs.push(`${e.id}: bad kind ${e.kind}`);
    if (!STATUS.includes(e.status)) errs.push(`${e.id}: bad status ${e.status}`);
    if (e.id !== `${e.kind}:${e.name}`) errs.push(`${e.id}: id must be kind:name`);
    if (VERSIONED.includes(e.kind) && RUNTIME_FIELDS.some(field => {
      const value = e.runtime?.[field];
      return value !== null && (typeof value !== 'string' || !value.trim());
    })) errs.push(`${e.id}: runtime must declare version, pin source and update channel (null when unknown)`);
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

// Inspect command words without expanding variables or executing shell input.
// Prefer the script operand over its interpreter, flags, or trailing arguments.
function hookName(command) {
  const words = (command.match(/(?:[^\s'"\\]|\\.|"(?:[^"\\]|\\.)*"|'[^']*')+/g) || [])
    .map(word => word.replace(/"((?:[^"\\]|\\.)*)"|'([^']*)'|\\(.)/g,
      (_, double, single, escaped) => double ?? single ?? escaped));
  const script = words.find(word => !word.startsWith('-') && /\.(sh|bash|py|mjs|cjs|js)$/.test(word));
  const executable = words.find(word => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
  return (script || executable || '').split('/').pop().replace(/\.(sh|bash|py|mjs|cjs|js)$/, '');
}

export function inventory(home) {
  const ls = (p) => (existsSync(p) ? readdirSync(p) : []);
  const json = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {});
  const settings = json(join(home, '.claude/settings.json'));
  const hooks = Object.values(settings.hooks || {}).flat().flatMap((g) => g.hooks || [])
    .map((h) => hookName(h.command || '')).filter(Boolean);
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
  } else if (argv[0] === 'versions') {
    const errs = validate(reg);
    if (errs.length) { console.error(errs.join('\n')); process.exit(1); }
    const read = flag => {
      const path = get(flag);
      if (!path) throw new Error(`Missing ${flag} FILE`);
      const receipt = JSON.parse(readFileSync(path, 'utf8'));
      if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
        throw new Error(`Expected a JSON object for ${flag}`);
      }
      return receipt;
    };
    const policy = JSON.parse(readFileSync(join(HERE, '..', 'canon', 'update-policy.json'), 'utf8'));
    const rows = versionReport(reg, read('--readback'), read('--upstream'), policy);
    console.log(JSON.stringify(rows, null, 2));
    if (rows.some(row => row.status === 'drift')) process.exitCode = 1;
  } else if (argv[0] === 'inventory') {
    console.log(JSON.stringify(inventory(get('--home') || process.env.HOME), null, 1));
  } else if (argv[0] === 'scan') {
    const d = diff(reg, JSON.parse(readFileSync(get('--inventory'), 'utf8')));
    for (const u of d.unregistered) console.error(`unregistered (add to canon/tooling.json): ${u}`);
    for (const m of d.missing) console.error(`registered but not installed (retire or fix): ${m}`);
    if (d.unregistered.length || d.missing.length) process.exit(1);
    console.log('ok: installed matches registry');
  } else { console.error('usage: tooling-drift.mjs check|inventory|scan|versions'); process.exit(2); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
