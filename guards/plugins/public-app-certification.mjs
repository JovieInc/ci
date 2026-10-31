// Company guard: public app certification config (canon/PUBLIC-APP-CERTIFICATION.md).
//
// In every consumer, for each app canon/public-apps.json registers to this
// repo: the certification config exists, parses, and is filled (no TODO stub,
// every referenced file exists, stage and data class agree with the registry).
// A certification config in the repo that the registry does not know about
// also fails: registration is the company layer, not a per-repo opt-in.
//
// Receipt freshness (stage public needs a passing receipt) is checked by the
// launch scan in JovieInc/ci (scripts/public-app-scan.mjs), which has the
// token to read each app repo's certification deployments.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, validateConfig } from '../../certify/config.mjs';

export const name = 'public-app-certification';
const HERE = dirname(fileURLToPath(import.meta.url));
export const REGISTRY_PATH = join(HERE, '..', '..', 'canon', 'public-apps.json');

export function repoSlug(cwd, env = process.env) {
  if (env.GITHUB_REPOSITORY) return env.GITHUB_REPOSITORY;
  try {
    const url = execFileSync('git', ['-C', cwd, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
    const m = url.match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** Pure check over a registry and a repo view, for tests. */
export function check({ registry, repo, cwd, listCertFiles = () => [], now = Date.now() }) {
  const fails = [];
  const warnings = [];
  if (!repo) return { fails: ['cannot tell which repo this is (set GITHUB_REPOSITORY)'] };
  const mine = registry.apps.filter((a) => a.repo.toLowerCase() === repo.toLowerCase());
  for (const app of mine) {
    // Before an app's enforceFrom date its problems are warnings (default with a deadline).
    // Dormant apps (not serving) only warn; they must certify before serving again.
    const grace = app.stage === 'dormant' || (app.enforceFrom && Date.parse(app.enforceFrom) > now);
    const sink = grace ? warnings : fails;
    const tag = !grace ? app.id : app.stage === 'dormant' ? `${app.id} (dormant)` : `${app.id} (enforced from ${app.enforceFrom})`;
    const { config, errors } = loadConfig(cwd, app.config);
    if (errors.length) { sink.push(...errors.map((x) => `${tag}: ${x}`)); continue; }
    sink.push(...validateConfig(config, { cwd, registryEntry: app }).errors.map((x) => `${tag}: ${x}`));
  }
  const known = new Set(mine.map((a) => a.config));
  for (const rel of listCertFiles()) {
    if (!known.has(rel)) fails.push(`${rel}: certification config not registered in JovieInc/ci canon/public-apps.json`);
  }
  return { fails, warnings };
}

function listCertFiles(cwd) {
  const dir = join(cwd, 'certification');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => `certification/${f}`)
    .filter((rel) => {
      try { return JSON.parse(readFileSync(join(cwd, rel), 'utf8')).schema === 'company.public-app-cert/v1'; } catch { return false; }
    });
}

export async function run({ cwd = '.' } = {}) {
  const registry = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
  return check({ registry, repo: repoSlug(cwd), cwd, listCertFiles: () => listCertFiles(cwd) });
}
