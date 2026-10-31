#!/usr/bin/env node
// Scaffold the public-app certification layer into an app repo (on by default).
//
//   node templates/public-app/bootstrap.mjs --repo JovieInc/X --target <checkout> --sha <ci sha> [--app id]
//
// For every app canon/public-apps.json registers to --repo (or just --app),
// copy each skeleton file that does not exist yet. Existing files are never
// overwritten, so the pin bump can run this on every consumer every time.
// Stubs carry TODO markers; certify/config.mjs rejects any TODO, so a scaffolded
// app cannot pass until a person or agent fills it in.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKELETON = join(HERE, 'skeleton');

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

export function plan({ registry, repo, app: only, target, sha }) {
  const apps = registry.apps.filter((a) => a.repo.toLowerCase() === repo.toLowerCase() && (!only || a.id === only));
  const writes = [];
  for (const app of apps) {
    const vars = { APP_ID: app.id, STAGE: app.stage, DATA_CLASS: app.dataClass, CI_SHA: sha };
    for (const src of walk(SKELETON)) {
      let rel = relative(SKELETON, src);
      // Repos with several apps keep one config per app at the registry path; shared files stay shared.
      if (rel === 'certification/app.json') rel = app.config;
      const dest = join(target, rel);
      if (existsSync(dest) || writes.some((w) => w.dest === dest)) continue;
      const body = readFileSync(src, 'utf8').replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? `{{${k}}}`);
      writes.push({ app: app.id, rel, dest, body });
    }
  }
  return writes;
}

function main(argv) {
  const get = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  const repo = get('--repo');
  const target = get('--target') || '.';
  const sha = get('--sha');
  if (!repo || !/^[0-9a-f]{40}$/.test(sha || '')) { console.error('usage: bootstrap.mjs --repo JovieInc/X --target DIR --sha <40-hex ci sha> [--app id]'); process.exit(2); }
  const registry = JSON.parse(readFileSync(join(HERE, '..', '..', 'canon', 'public-apps.json'), 'utf8'));
  const writes = plan({ registry, repo, app: get('--app'), target, sha });
  for (const w of writes) {
    mkdirSync(dirname(w.dest), { recursive: true });
    writeFileSync(w.dest, w.body);
    console.log(`scaffolded ${w.rel} (${w.app})`);
  }
  if (!writes.length) console.log('nothing to scaffold');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
