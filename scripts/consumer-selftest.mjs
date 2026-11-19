#!/usr/bin/env node
// Read-only fleet qualification: pinned vs candidate guards, never drift.mjs.
// Mission: expose new enforcing failures before a pin bump. Audience: CI owners.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SHA = /^[a-f\d]{40}$/i;

export function parsePin(workflow) {
  // `ci-ref: <sha>` (workflow input) or `# ci-ref: <sha>` (Jovie's comment pin).
  const refs = [...workflow.matchAll(/^\s*(?:#\s*)?ci-ref:\s*([^\n#]+)(?:#.*)?$/gm)]
    .map((m) => m[1].trim().replace(/^(['"])(.*)\1$/, '$2'));
  if (!refs.length || refs.some((r) => !SHA.test(r)) || new Set(refs).size !== 1)
    throw new Error('missing, ambiguous or non-full-SHA ci-ref');
  return refs[0];
}

export function parseGuardResult(result) {
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const errors = [...output.matchAll(/^::error::(.*)$/gm)].map((m) => m[1].trim());
  const fails = [...new Set(errors)].sort();
  const summaries = [...output.matchAll(/^company-guards: (ok|FAIL) \((\d+)\)\r?$/gm)];
  const summary = summaries[0];
  const verified = !result.error && summaries.length === 1 && [0, 1].includes(result.status) &&
    Number(summary[2]) === errors.length &&
    (result.status === 0 ? !errors.length && summary[1] === 'ok' : errors.length > 0 && summary[1] === 'FAIL');
  return { verified, fails, status: result.status };
}

// Inputs contain only non-shadow ::error:: findings. Missing executions never
// count as green, even when both executions are missing in the same way.
export function compareResults(pinned, candidate) {
  if (!pinned?.verified || !candidate?.verified) return { verified: false, newFailures: [] };
  const previous = new Set(pinned.fails);
  return { verified: true, newFailures: [...new Set(candidate.fails.filter((f) => !previous.has(f)))].sort() };
}

export function guardEnv(env, repo) {
  const clean = Object.fromEntries(Object.entries(env).filter(([k]) =>
    !/^(GITHUB_|PR_|SIZE_BASE_SHA$|GH_TOKEN$|GIT_CONFIG_)/.test(k)));
  return { ...clean, GITHUB_REPOSITORY: `JovieInc/${repo}` };
}

export function gitEnv(env) {
  const clean = Object.fromEntries(Object.entries(env).filter(([k]) =>
    !/^GIT_(CONFIG_|TRACE|CURL_VERBOSE)/.test(k)));
  const token = env.GH_TOKEN || env.GITHUB_TOKEN;
  // Environment-only config: credentials never enter argv, logs or .git/config.
  return { ...clean, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: token ? '2' : '1',
    GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '',
    ...(token ? { GIT_CONFIG_KEY_1: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_1: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}` } : {}),
  };
}

export function parseArgs(args, defaults) {
  let repos = defaults, allowUnreachable = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--allow-unreachable') allowUnreachable = true;
    else if (args[i] === '--repos' || args[i].startsWith('--repos=')) {
      const value = args[i] === '--repos' ? args[++i] : args[i].slice(8);
      repos = value?.split(',');
    } else throw new Error(`unknown argument: ${args[i]}`);
  }
  if (!repos?.length || repos.some((r) => !/^[a-z\d_.-]+$/i.test(r) || r === '.' || r === '..'))
    throw new Error('--repos requires comma-separated repository names');
  return { repos: [...new Set(repos)], allowUnreachable };
}

function command(file, args, options) {
  return execFileSync(file, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'], timeout: 120_000, maxBuffer: 1 << 28 });
}
export function cloneConsumer(repo, dir, env, exec = command) {
  return exec('git', ['clone', '--depth', '2', '--branch', 'main', '--single-branch',
    `https://github.com/JovieInc/${repo}.git`, dir], { env });
}
function exportPin(checkout, pin, destination, env) {
  const archive = () => command('git', ['archive', '--format=tar', pin], { cwd: checkout, env });
  let data;
  try { data = archive(); }
  catch {
    // A shallow candidate checkout may not contain the consumer's old SHA.
    // Fetch into scratch history, never the candidate checkout or a consumer.
    const history = join(destination, 'history');
    mkdirSync(history);
    command('git', ['init', '-q'], { cwd: history, env });
    command('git', ['fetch', '--depth', '1', 'https://github.com/JovieInc/ci.git', pin], { cwd: history, env });
    data = command('git', ['archive', '--format=tar', pin], { cwd: history, env });
  }
  const tree = join(destination, 'pinned');
  mkdirSync(tree);
  command('tar', ['-xf', '-', '-C', tree], { input: data, env });
  return tree;
}

export function executeGuards(checkout, consumer, env) {
  return parseGuardResult(spawnSync(process.execPath, [join(checkout, 'guards/run.mjs')], {
    cwd: consumer, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 1 << 28,
  }));
}

export async function selftest({ repos, allowUnreachable = false, checkout = ROOT, env = process.env,
  clone = cloneConsumer,
  pinnedTree = exportPin, runGuards = executeGuards,
} = {}) {
  const config = JSON.parse(readFileSync(join(checkout, 'canon/consumers.json'), 'utf8'));
  if (!(repos ?? config.repos)?.length) throw new Error('no consumers selected');
  const reports = [];
  for (const repo of repos ?? config.repos) {
    if (!/^[a-z\d_.-]+$/i.test(repo) || repo === '.' || repo === '..') throw new Error('invalid repository name');
    const scratch = mkdtempSync(join(tmpdir(), 'consumer-selftest-'));
    let pinned, candidate, pin, stage = 'consumer clone';
    try {
      const consumer = join(scratch, 'consumer');
      const auth = gitEnv(env);
      await clone(repo, consumer, auth);
      stage = 'candidate guard run';
      const runtime = guardEnv(env, repo);
      candidate = await runGuards(checkout, consumer, runtime);
      stage = 'consumer ci-ref';
      pin = parsePin(readFileSync(join(consumer, config.pinFile), 'utf8'));
      stage = 'pinned ci archive';
      const tree = await pinnedTree(checkout, pin, scratch, auth);
      stage = 'pinned guard run';
      pinned = await runGuards(tree, consumer, runtime);
      const comparison = compareResults(pinned, candidate);
      reports.push({ repo, pin, pinned, candidate, ...comparison,
        ...(comparison.verified ? {} : { reason: 'guard execution unavailable or incomplete' }) });
    } catch {
      // Never print subprocess errors: they can contain auth headers or URLs.
      reports.push({ repo, pin, pinned, candidate, verified: false, unreachable: stage === 'consumer clone',
        newFailures: [], reason: `${stage} unavailable` });
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  }
  return { reports, exitCode: reports.some((r) => r.verified ? r.newFailures.length > 0 :
    !(allowUnreachable && r.unreachable)) ? 1 : 0 };
}

export function formatReport(report) {
  const label = (r) => !r?.verified ? 'unverified' : r.fails.length ? `FAIL (${r.fails.length})` : 'ok (0)';
  return [`${report.repo}: pinned-result=${label(report.pinned)} candidate-result=${label(report.candidate)} ` +
    (report.verified ? `NEW failures=${report.newFailures.length}` : `unverified (${report.reason})`),
  ...report.newFailures.map((f) => `  NEW: ${f}`)].join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const config = JSON.parse(readFileSync(join(ROOT, 'canon/consumers.json'), 'utf8'));
    const result = await selftest(parseArgs(process.argv.slice(2), config.repos));
    for (const report of result.reports) console.log(formatReport(report));
    process.exitCode = result.exitCode;
  } catch (error) { console.error(`consumer-selftest: ${error.message}`); process.exitCode = 1; }
}
