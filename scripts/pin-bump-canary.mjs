#!/usr/bin/env node
// Read-only consumer canary for pin bumps (JOV-13114).
// Applies the candidate pin in a scratch checkout of each consumer's main and
// runs the reusable workflow entrypoints (company-guards, and public-app
// certification validate when that workflow is present). Never pushes, never
// opens a PR. A missing, skipped, unverified or red consumer fails closed.
import { mkdirSync, readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGuardResult, cloneConsumer, gitEnv } from './consumer-selftest.mjs';
import { plan } from '../templates/public-app/bootstrap.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SHA = /^[a-f\d]{40}$/i;
const PIN_RE = /(company-guards\.yml@|public-app-certification\.yml@|ci-ref: )[0-9a-f]{40}/gi;
const PIN_FILES = [
  '.github/workflows/company-guards.yml',
  '.github/workflows/public-app-certification.yml',
];

export function parseArgs(args, env = process.env) {
  let sha = env.SHA || env.GITHUB_SHA;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--sha' || args[i].startsWith('--sha=')) {
      sha = args[i] === '--sha' ? args[++i] : args[i].slice(6);
    } else {
      throw new Error(`unknown argument: ${args[i]} (only --sha is accepted; skipping consumers is not allowed)`);
    }
  }
  if (!SHA.test(sha || '')) throw new Error('--sha requires a full 40-hex commit SHA');
  return { sha };
}

export function applyWorkflowPins(target, sha) {
  if (!SHA.test(sha || '')) throw new Error('applyWorkflowPins requires a full 40-hex commit SHA');
  const updated = [];
  for (const rel of PIN_FILES) {
    const path = join(target, rel);
    if (!existsSync(path)) continue;
    const before = readFileSync(path, 'utf8');
    const after = before.replace(PIN_RE, `$1${sha}`);
    if (after !== before) {
      writeFileSync(path, after);
      updated.push(rel);
    }
  }
  return updated;
}

export function scaffoldPublicApps({ target, sha, repo, checkout = ROOT }) {
  const registryPath = join(checkout, 'canon/public-apps.json');
  if (!existsSync(registryPath)) return [];
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  const writes = plan({ registry, repo: repo.includes('/') ? repo : `JovieInc/${repo}`, target, sha });
  for (const w of writes) {
    mkdirSync(dirname(w.dest), { recursive: true });
    writeFileSync(w.dest, w.body);
  }
  return writes;
}

export function applyPin({ target, sha, repo, checkout = ROOT }) {
  const pins = applyWorkflowPins(target, sha);
  const scaffolded = scaffoldPublicApps({ target, sha, repo, checkout });
  return { pins, scaffolded };
}

export function disablePush(dir, execFile) {
  execFile('git', ['config', 'remote.origin.pushurl', 'DISABLED'], { cwd: dir });
}

export function canaryGuardEnv(env, repo, baseSha, prBody) {
  const clean = { ...env };
  delete clean.GH_TOKEN;
  return {
    ...clean,
    GITHUB_REPOSITORY: `JovieInc/${repo}`,
    GITHUB_EVENT_NAME: 'pull_request',
    SIZE_BASE_SHA: baseSha,
    PR_BODY: prBody ?? `Automated pin bump canary (dry run, no consumer push).\n\nRefs JOV-13114\n`,
  };
}

export function parseCertifyResult(result) {
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const summaries = [...output.matchAll(/^certify validate: (ok|FAIL) \((\d+) app\(s\), (\d+) error\(s\), (\d+) warning\(s\)\)\r?$/gm)];
  const summary = summaries[0];
  const errors = Number(summary?.[3] ?? NaN);
  const verified = !result.error && summaries.length === 1 && [0, 1].includes(result.status)
    && (result.status === 0 ? summary[1] === 'ok' && errors === 0 : summary[1] === 'FAIL' && errors > 0);
  return { verified, status: result.status, errors: Number.isFinite(errors) ? errors : null };
}

function command(file, args, options) {
  const r = spawnSync(file, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8', timeout: 120_000, maxBuffer: 1 << 28 });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    const err = new Error(`${file} exited ${r.status}`);
    err.result = r;
    throw err;
  }
  return r;
}

export function headSha(dir, execFile = command) {
  return execFile('git', ['rev-parse', 'HEAD'], { cwd: dir }).stdout.trim();
}

export function executeGuards(ciRoot, consumer, env) {
  return parseGuardResult(spawnSync(process.execPath, [join(ciRoot, 'guards/run.mjs')], {
    cwd: consumer, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 1 << 28,
  }));
}

export function executeCertify(ciRoot, consumer, env) {
  return parseCertifyResult(spawnSync(process.execPath, [join(ciRoot, 'certify/cli.mjs'), 'validate'], {
    cwd: consumer, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 1 << 28,
  }));
}

export function formatReport(report) {
  if (!report.ok) {
    const detail = report.reason || (report.guards && !report.guards.verified ? 'guard execution unavailable or incomplete'
      : report.certify && !report.certify.verified ? 'certify execution unavailable or incomplete'
        : 'red');
    return `${report.repo}: FAIL (${detail})`;
  }
  return `${report.repo}: ok`;
}

function consumerOk(report) {
  if (!report?.guards?.verified || report.guards.status !== 0) return false;
  if (report.certify) {
    if (!report.certify.verified || report.certify.status !== 0) return false;
  }
  return true;
}

export async function canary({
  repos,
  sha,
  checkout = ROOT,
  env = process.env,
  clone = cloneConsumer,
  execFile = command,
  runGuards = executeGuards,
  runCertify = executeCertify,
} = {}) {
  if (!SHA.test(sha || '')) throw new Error('canary requires a full 40-hex commit SHA');
  const config = JSON.parse(readFileSync(join(checkout, 'canon/consumers.json'), 'utf8'));
  const expected = repos ?? config.repos;
  if (!expected?.length) throw new Error('no consumers selected');
  const reports = [];
  for (const repo of expected) {
    if (!/^[a-z\d_.-]+$/i.test(repo) || repo === '.' || repo === '..') throw new Error(`invalid repository name: ${repo}`);
    const scratch = mkdtempSync(join(tmpdir(), `pin-bump-canary-${repo}-`));
    const dir = join(scratch, 'consumer');
    let stage = 'consumer clone';
    try {
      await clone(repo, dir, gitEnv(env));
      stage = 'disable push';
      disablePush(dir, execFile);
      stage = 'consumer HEAD';
      const baseSha = headSha(dir, execFile);
      stage = 'apply pin';
      applyPin({ target: dir, sha, repo, checkout });
      stage = 'company-guards';
      const guards = await runGuards(checkout, dir, canaryGuardEnv(env, repo, baseSha));
      const certifyPath = join(dir, '.github/workflows/public-app-certification.yml');
      let certify = null;
      if (existsSync(certifyPath)) {
        stage = 'public-app-certification validate';
        certify = await runCertify(checkout, dir, canaryGuardEnv(env, repo, baseSha));
      }
      const report = { repo, baseSha, guards, certify, ok: consumerOk({ guards, certify }) };
      if (!report.ok) {
        report.reason = !guards?.verified ? 'guard execution unavailable or incomplete'
          : guards.status !== 0 ? `company-guards red (${(guards.fails || []).join('; ') || 'FAIL'})`
            : !certify?.verified ? 'certify execution unavailable or incomplete'
              : `certify validate red (${certify.errors} error(s))`;
      }
      reports.push(report);
    } catch {
      reports.push({ repo, ok: false, reason: `${stage} unavailable`, guards: null, certify: null });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  const missing = expected.filter((repo) => !reports.some((r) => r.repo === repo));
  for (const repo of missing) reports.push({ repo, ok: false, reason: 'consumer skipped', guards: null, certify: null });
  const ok = reports.length === expected.length && reports.every((r) => r.ok);
  return { reports, ok, exitCode: ok ? 0 : 1 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await canary(parseArgs(process.argv.slice(2)));
    for (const report of result.reports) console.log(formatReport(report));
    console.log(`pin-bump-canary: ${result.ok ? 'ok' : 'FAIL'} (${result.reports.length} consumer(s))`);
    process.exitCode = result.exitCode;
  } catch (error) {
    console.error(`pin-bump-canary: ${error.message}`);
    process.exitCode = 1;
  }
}
