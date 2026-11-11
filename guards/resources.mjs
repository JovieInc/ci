#!/usr/bin/env node
// Creation guard: refuse creating a resource when the registry already has an
// entry with the same purposeKey (or the name is a known alias or legacy name).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REGISTRY = join(HERE, '..', 'canon', 'resources.json');

export function canCreate(registry, { kind, name, purposeKey }) {
  const n = String(name).toLowerCase();
  for (const e of registry.resources) {
    if (e.kind !== kind) continue;
    if (purposeKey && e.purposeKey === purposeKey && e.status !== 'retired') {
      return { ok: false, reason: `purpose "${purposeKey}" already served by ${e.kind} ${e.name} (owner ${e.owner}); reuse or merge it` };
    }
    if (e.name.toLowerCase() === n || (e.aliases || []).some((a) => a.toLowerCase() === n)) {
      return { ok: false, reason: `${e.kind} ${e.name} already exists in the registry (status ${e.status})` };
    }
  }
  return { ok: true };
}

function main(argv) {
  const get = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  if (argv[0] !== 'can-create') { console.error('usage: resources.mjs can-create --kind K --name N --purpose-key P'); process.exit(2); }
  const registry = JSON.parse(readFileSync(get('--registry') || DEFAULT_REGISTRY, 'utf8'));
  const r = canCreate(registry, { kind: get('--kind'), name: get('--name'), purposeKey: get('--purpose-key') });
  if (!r.ok) { console.error(`resource-guard: refusing create: ${r.reason}`); process.exit(1); }
  console.log('ok: no existing entry; add one to canon/resources.json in the same change');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
