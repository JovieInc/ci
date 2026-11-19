#!/usr/bin/env node
// Type registry guard (company-resource-registry/v2). One namespace for every named
// entity: agents, bots, rooms, the Eve agent, repos, Vercel projects, domains, webhooks.
//   validate                 -> registry is internally collision-free (CI, deterministic)
//   can-create --kind K --name N [--purpose-key P] [--family F] [--supersedes REF]
//                            -> refuse a create that would duplicate or confuse (creation flows)
//   drift --observed FILE    -> compare a live inventory with the registry (drift detectors)
// v1 callers keep working: canCreate(registry, { kind, name, purposeKey }) -> { ok, reason }.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REGISTRY = join(HERE, '..', 'canon', 'resources.json');

export const AGENT_KINDS = new Set(['grok-bot', 'room', 'eve-agent', 'hyperagent-agent', 'external-agent', 'codex-agent', 'cloud-agent']);
const NAMESPACED = new Set(['domain']); // domains only; webhooks share the cross-kind name namespace
// active_uncommissioned stays live: reserved resources still own their names and purposes.
export const INACTIVE = new Set(['retired', 'archived', 'duplicate', 'deleted', 'missing']);
const PLACEHOLDERS = new Set(['newbot', 'newagent', 'untitled', 'newproject', 'myproject', 'newroom', 'newchat']);

// Normalized identity key: case, punctuation, owner prefixes, retirement prefixes,
// "(copy)", version and random suffixes all collapse, so near-names collide.
export function keyOf(kind, name) {
  let s = String(name ?? '').normalize('NFKC').toLowerCase().trim();
  if (NAMESPACED.has(kind)) return `${kind}:${s.replace(/\.$/, '')}`;
  if (kind.endsWith('-repo')) s = s.split('/').pop();
  s = s.replace(/^(retired|parked|archived)\s*[·:\-|]\s*/g, '').replace(/^(retired|parked)\s*[·:\-|]\s*/g, '');
  s = s.replace(/[\s_-]*\(?copy( \d+)?\)?$/, '');
  s = s.replace(/[-_ ](?=[a-z0-9]*\d)[a-z0-9]{6,}$/, ''); // vercel random suffix: -1d2m0j, -2rn94pa9eiv
  s = s.replace(/[-_ .]v\d+(\.\d+)*$/, '');                   // -v1, -v2.0
  s = s.replace(/[-_ ](\d{1,3}|new|old|backup|bak|tmp|temp|test|final|clone|dup|duplicate|shadow|fork|alt)$/, ''); // dodge suffixes
  s = s.replace(/[^a-z0-9]+/g, '');
  return s;
}
const tokensOf = (name) => String(name ?? '').normalize('NFKC').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const live = (e) => !INACTIVE.has(e.status);
export const refOf = (e) => `${e.kind}:${e.id ?? e.name}`;

function lev(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

function names(e) { return [e.name, ...(e.aliases || []), ...(e.retiredNames || [])]; }

// Two entries may share a key only when the registry says why.
const pointsAway = (x) => !live(x) && (x.supersededBy || x.duplicateOf);
function pairAllowed(a, b) {
  const ra = refOf(a), rb = refOf(b);
  const links = (x, r) => [x.supersededBy, x.duplicateOf, x.mirrorOf, x.supersedes].includes(r);
  if (pointsAway(a) || pointsAway(b)) return true;                            // retired/dup names stay reserved for can-create only
  if ((!live(a) && links(a, rb)) || (!live(b) && links(b, ra))) return true;
  if (links(a, rb) && a.kind !== b.kind) return true;                         // origin mirror of github repo
  if (a.kind === b.kind) return false;                                        // same type, same name: never
  if (AGENT_KINDS.has(a.kind) || AGENT_KINDS.has(b.kind)) return !!a.family && a.family === b.family && (a.kind === 'eve-agent' || b.kind === 'eve-agent');
  return !!a.family && a.family === b.family;                                 // repo "Jovie" + vercel "jovie"
}

function reservedViolation(reg, e, nm) {
  for (const r of reg.reservedNames || []) {
    if (!tokensOf(nm).includes(r.token)) continue;
    if (e.family !== r.family || !(r.allowedKinds || []).includes(e.kind)) {
      return `"${nm}" uses reserved name "${r.token}" (only ${r.family} family kinds ${r.allowedKinds.join('/')}: ${r.note || ''})`.trim();
    }
  }
  return null;
}

export function validate(reg) {
  const fails = [], warnings = [];
  const ents = reg.resources || [];
  const ids = new Map(), byKey = new Map(), refs = new Set(ents.map(refOf));
  const people = new Set((reg.people || []).map((p) => `person:${p.id}`));
  for (const e of ents) {
    if (!e.kind || !e.name || !e.status) { fails.push(`entry missing kind/name/status: ${JSON.stringify(e).slice(0, 80)}`); continue; }
    if (e.id) { const k = `${e.kind}:${e.id}`; if (ids.has(k)) fails.push(`duplicate id ${k}`); ids.set(k, e); }
    const isPh = PLACEHOLDERS.has(keyOf(e.kind, e.name));
    if (isPh && live(e)) fails.push(`${refOf(e)} has placeholder name "${e.name}"; give it a unique canonical name`);
    for (const nm of names(e)) {
      const current = nm === e.name || (e.aliases || []).includes(nm);
      const why = current ? reservedViolation(reg, e, nm) : null;
      if (why && live(e)) fails.push(`${refOf(e)}: ${why}`); else if (why) warnings.push(`${refOf(e)} (inactive): ${why}`);
      const k = keyOf(e.kind, nm);
      if (!k || PLACEHOLDERS.has(k)) continue;
      const bucket = NAMESPACED.has(e.kind) ? k : `name:${k}`;
      for (const o of byKey.get(bucket) || []) {
        if (o === e || pairAllowed(e, o)) continue;
        fails.push(`name collision "${k}": ${refOf(o)} ("${o.name}") vs ${refOf(e)} ("${nm}")`);
      }
      byKey.set(bucket, [...(byKey.get(bucket) || []), e]);
    }
    if (e.owner && !refs.has(e.owner) && !people.has(e.owner)) fails.push(`${refOf(e)} owner "${e.owner}" is not a registry ref (use person:<id> or <kind>:<id>)`);
    for (const f of ['supersededBy', 'duplicateOf', 'mirrorOf', 'supersedes']) if (e[f] && !refs.has(e[f])) fails.push(`${refOf(e)} ${f} -> unknown ref ${e[f]}`);
    if (e.purposeKey && live(e)) {
      const pk = `${e.kind}|${e.purposeKey}`;
      if (ids.has(pk)) fails.push(`purpose "${e.purposeKey}" served twice: ${refOf(ids.get(pk))} and ${refOf(e)}`); else ids.set(pk, e);
    }
    if (e.status === 'duplicate' && !e.duplicateOf) fails.push(`${refOf(e)} status duplicate needs duplicateOf`);
  }
  for (const k of new Set([...byKey.keys()].filter((b) => b.startsWith('name:')))) {
    for (const k2 of byKey.keys()) {
      if (!k2.startsWith('name:') || k2 <= k) continue;
      const a = k.slice(5), b = k2.slice(5);
      if (a.length >= 5 && lev(a, b) <= 1) warnings.push(`near-name: "${a}" ~ "${b}" (${byKey.get(k).map(refOf)} / ${byKey.get(k2).map(refOf)})`);
    }
  }
  // Ratchet: pre-existing violations listed in knownViolations (with a Linear issue and an
  // expiry) warn instead of failing; new ones fail; an expired or unused entry fails.
  const today = new Date().toISOString().slice(0, 10);
  const kv = (reg.knownViolations || []).map((v) => ({ ...v, used: false }));
  const out = [];
  for (const f of new Set(fails)) {
    const v = kv.find((x) => f.includes(x.match));
    if (!v) { out.push(f); continue; }
    v.used = true;
    if (!/^[A-Z]+-\d+$/.test(v.issue || '') || !v.until || v.until < today) out.push(`${f} [knownViolation expired or missing issue/until]`);
    else warnings.push(`known (${v.issue}, until ${v.until}): ${f}`);
  }
  for (const v of kv) if (!v.used) out.push(`knownViolations entry "${v.match}" no longer matches anything; delete it (ratchet)`);
  return { fails: out, warnings: [...new Set(warnings)] };
}

export function canCreate(reg, { kind, name, purposeKey, family, supersedes }) {
  const cand = { kind, name, status: 'canonical', family, supersedes, purposeKey };
  const k = keyOf(kind, name);
  if (!kind || !name) return { ok: false, reason: 'kind and name are required' };
  if (PLACEHOLDERS.has(k)) return { ok: false, reason: `"${name}" is a placeholder name; pick a unique canonical name` };
  const rv = reservedViolation(reg, cand, name);
  if (rv) return { ok: false, reason: rv };
  const warnings = [];
  for (const e of reg.resources || []) {
    if (purposeKey && e.kind === kind && e.purposeKey === purposeKey && live(e)) {
      return { ok: false, reason: `purpose "${purposeKey}" already served by ${e.kind} ${e.name} (owner ${e.owner}); reuse or merge it` };
    }
    for (const nm of names(e)) {
      const ek = keyOf(e.kind, nm);
      if (NAMESPACED.has(kind) !== NAMESPACED.has(e.kind)) continue;
      if (ek === k) {
        if (!live(e) && supersedes === refOf(e)) continue;
        if (live(e) && pairAllowed(cand, e)) continue;
        return { ok: false, reason: `${e.kind} "${e.name}" (${e.status}${live(e) ? '' : '; retired names stay reserved, pass --supersedes ' + refOf(e)}) already owns "${k}"` };
      }
      if (k.length >= 5 && lev(ek, k) <= 1) {
        if (e.kind === kind && live(e)) return { ok: false, reason: `"${name}" is one edit away from ${refOf(e)} "${e.name}" ("${ek}"); pick a clearly different name` };
        warnings.push(`close to ${refOf(e)} "${e.name}"`);
      }
    }
  }
  return { ok: true, warnings };
}

// observed: [{ kind, id?, name }] from a live inventory (GitHub/Vercel/Origin lists, box profiles).
export function drift(reg, observed, { completeKinds = [] } = {}) {
  const findings = [];
  const byId = new Map((reg.resources || []).filter((e) => e.id).map((e) => [`${e.kind}:${e.id}`, e]));
  const byName = new Map((reg.resources || []).flatMap((e) => names(e).map((n) => [`${e.kind}:${String(n).toLowerCase()}`, e])));
  const seen = new Set();
  for (const o of observed) {
    const e = (o.id && byId.get(`${o.kind}:${o.id}`)) || byName.get(`${o.kind}:${String(o.name).toLowerCase()}`);
    if (!e) { findings.push({ type: 'unregistered', kind: o.kind, name: o.name, id: o.id }); continue; }
    seen.add(e);
    if (e.name !== o.name && !(e.aliases || []).includes(o.name)) findings.push({ type: 'name-drift', ref: refOf(e), registry: e.name, live: o.name });
    if (['duplicate', 'unregistered', 'shadow'].includes(e.status)) findings.push({ type: e.status, ref: refOf(e), name: e.name, proposedAction: e.proposedAction });
  }
  for (const e of reg.resources || []) {
    if (completeKinds.includes(e.kind) && live(e) && !seen.has(e)) findings.push({ type: 'orphaned', ref: refOf(e), name: e.name });
  }
  const shadowReg = { ...reg, knownViolations: [], resources: observed.map((o) => { const k = byId.get(`${o.kind}:${o.id}`) || {}; return { ...k, kind: o.kind, id: o.id, name: o.name, aliases: [], retiredNames: [], status: k.status || 'canonical', owner: undefined }; }) };
  for (const f of validate(shadowReg).fails.filter((x) => x.startsWith('name collision') || x.includes('reserved') || x.includes('placeholder'))) findings.push({ type: 'live-collision', detail: f });
  return findings;
}

function main(argv) {
  const get = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  const reg = JSON.parse(readFileSync(get('--registry') || DEFAULT_REGISTRY, 'utf8'));
  const cmd = argv[0];
  if (cmd === 'validate') {
    const { fails, warnings } = validate(reg);
    for (const w of warnings) console.log(`::warning::type-registry: ${w}`);
    for (const f of fails) console.error(`::error::type-registry: ${f}`);
    console.log(`type-registry: ${fails.length ? 'FAIL' : 'ok'} (${reg.resources.length} entries, ${fails.length} fails, ${warnings.length} warnings)`);
    process.exit(fails.length ? 1 : 0);
  }
  if (cmd === 'can-create') {
    const r = canCreate(reg, { kind: get('--kind'), name: get('--name'), purposeKey: get('--purpose-key'), family: get('--family'), supersedes: get('--supersedes') });
    if (!r.ok) { console.error(`resource-guard: refusing create: ${r.reason}`); process.exit(1); }
    for (const w of r.warnings || []) console.log(`warning: ${w}`);
    console.log('ok: no conflicting entry; add the new entry to canon/resources.json in the same change');
    return;
  }
  if (cmd === 'drift') {
    const obs = JSON.parse(readFileSync(get('--observed'), 'utf8'));
    const f = drift(reg, obs.observed || obs, { completeKinds: (get('--complete') || '').split(',').filter(Boolean) });
    console.log(JSON.stringify({ findings: f }, null, 1));
    process.exit(f.length ? 3 : 0);
  }
  console.error('usage: resources.mjs validate | can-create --kind K --name N [--purpose-key P] [--family F] [--supersedes REF] | drift --observed FILE [--complete k1,k2]');
  process.exit(2);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
