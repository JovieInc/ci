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
    // An app whose config exists is set up; only repo-level files (the workflow) are still added.
    const configured = existsSync(join(target, app.config));
    // Repos with several apps namespace every per-app file (<app>-personas.json, flows/<app>.mjs).
    // Per-app files live next to the config (default certification/, or e.g. canon/certification/
    // in a repo whose root is allowlisted).
    const dir = dirname(app.config);
    const single = app.config === 'certification/app.json';
    const renames = single ? {} : {
      'certification/personas.json': `${dir}/${app.id}-personas.json`,
      'certification/calibration.json': `${dir}/${app.id}-calibration.json`,
      'certification/tracker-registry.json': `${dir}/${app.id}-tracker-registry.json`,
      'certification/flows/web.mjs': `${dir}/flows/${app.id}.mjs`,
      'certification/README.md': `${dir}/README.md`,
    };
    for (const src of walk(SKELETON)) {
      let rel = relative(SKELETON, src);
      const perApp = rel.startsWith('certification/');
      if (perApp && configured) continue;
      if (rel === 'certification/app.json') rel = app.config;
      rel = renames[rel] ?? rel;
      const dest = join(target, rel);
      if (existsSync(dest) || writes.some((w) => w.dest === dest)) continue;
      let body = readFileSync(src, 'utf8').replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? `{{${k}}}`);
      for (const [from, to] of Object.entries(renames)) body = body.split(from).join(to);
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
