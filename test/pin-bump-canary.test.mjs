import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  parseArgs, applyWorkflowPins, canaryGuardEnv, parseCertifyResult, disablePush,
  canary, formatReport,
} from '../scripts/pin-bump-canary.mjs';

const SHA = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
function write(cwd, path, text) {
  mkdirSync(dirname(join(cwd, path)), { recursive: true });
  writeFileSync(join(cwd, path), text);
}
function repo(t, prefix) {
  const cwd = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  git(cwd, 'init', '-q', '-b', 'main');
  git(cwd, 'config', 'user.email', 'test@example.invalid');
  git(cwd, 'config', 'user.name', 'fixture');
  git(cwd, 'config', 'commit.gpgsign', 'false');
  return cwd;
}
function commit(cwd) {
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-qm', 'fixture');
  return git(cwd, 'rev-parse', 'HEAD');
}
const okGuards = { verified: true, status: 0, fails: [] };
const redGuards = { verified: true, status: 1, fails: ['size-500: grew'] };
const unverified = { verified: false, status: 1, fails: [] };
const okCertify = { verified: true, status: 0, errors: 0 };
const redCertify = { verified: true, status: 1, errors: 2 };

function workflow(pin) {
  return `name: Company Guards
on: { workflow_call: { inputs: { ci-ref: { type: string } } } }
jobs:
  guards:
    uses: JovieInc/ci/.github/workflows/company-guards.yml@${pin}
    with:
      ci-ref: ${pin}
`;
}

function fleet(t, repos = ['example']) {
  const checkout = repo(t, 'canary-ci-');
  write(checkout, 'canon/consumers.json', JSON.stringify({ repos, pinFile: '.github/workflows/company-guards.yml' }));
  write(checkout, 'canon/public-apps.json', JSON.stringify({ apps: [] }));
  const consumers = {};
  for (const name of repos) {
    const consumer = repo(t, `canary-${name}-`);
    write(consumer, '.github/workflows/company-guards.yml', workflow(SHA));
    commit(consumer);
    consumers[name] = consumer;
  }
  const cloned = [];
  const seenEnv = [];
  const clone = (name, dir, env) => {
    if (!consumers[name]) throw new Error(`unknown consumer ${name}`);
    cloned.push(name);
    seenEnv.push(env);
    mkdirSync(dirname(dir), { recursive: true });
    git(dirname(dir), '-c', 'protocol.file.allow=always', 'clone', '--depth', '2', '--branch', 'main', pathToFileURL(consumers[name]).href, dir);
  };
  return { checkout, consumers, clone, cloned, seenEnv };
}

test('parseArgs accepts only a full SHA and refuses skip flags', () => {
  assert.deepEqual(parseArgs(['--sha', SHA], {}), { sha: SHA });
  assert.deepEqual(parseArgs(['--sha=' + SHA], {}), { sha: SHA });
  assert.deepEqual(parseArgs([], { SHA }), { sha: SHA });
  assert.throws(() => parseArgs(['--sha', 'main']), /40-hex/);
  assert.throws(() => parseArgs(['--repos', 'Jovie']), /unknown argument/);
  assert.throws(() => parseArgs(['--allow-unreachable']), /unknown argument/);
});

test('applyWorkflowPins rewrites uses-line and ci-ref pins, leaves other SHAs alone', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pins-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  write(dir, '.github/workflows/company-guards.yml', workflow(SHA));
  write(dir, '.github/workflows/public-app-certification.yml', `uses: JovieInc/ci/.github/workflows/public-app-certification.yml@${SHA}\n# other ${SHA}\n`);
  write(dir, 'README.md', SHA);
  const updated = applyWorkflowPins(dir, NEW);
  assert.deepEqual(updated, [
    '.github/workflows/company-guards.yml',
    '.github/workflows/public-app-certification.yml',
  ]);
  const guards = readFileSync(join(dir, '.github/workflows/company-guards.yml'), 'utf8');
  assert.match(guards, new RegExp(`company-guards\\.yml@${NEW}`));
  assert.match(guards, new RegExp(`ci-ref: ${NEW}`));
  assert.doesNotMatch(guards, new RegExp(SHA));
  const cert = readFileSync(join(dir, '.github/workflows/public-app-certification.yml'), 'utf8');
  assert.match(cert, new RegExp(`public-app-certification\\.yml@${NEW}`));
  assert.match(cert, new RegExp(`# other ${SHA}`));
  assert.equal(readFileSync(join(dir, 'README.md'), 'utf8'), SHA);
  assert.deepEqual(applyWorkflowPins(join(dir, 'missing'), NEW), []);
});

test('canaryGuardEnv simulates a pin-bump PR and does not forward the app token', () => {
  const env = canaryGuardEnv({ GH_TOKEN: 'secret', PATH: '/bin', GITHUB_TOKEN: 'ci' }, 'Jovie', SHA);
  assert.equal(env.GITHUB_EVENT_NAME, 'pull_request');
  assert.equal(env.SIZE_BASE_SHA, SHA);
  assert.equal(env.GITHUB_REPOSITORY, 'JovieInc/Jovie');
  assert.match(env.PR_BODY, /Refs JOV-13114/);
  assert.equal(env.PATH, '/bin');
  assert.equal(env.GITHUB_TOKEN, 'ci');
  assert.equal('GH_TOKEN' in env, false);
});

test('parseCertifyResult accepts a single verdict and rejects contradictory ones', () => {
  assert.deepEqual(parseCertifyResult({ status: 0, stdout: 'certify validate: ok (2 app(s), 0 error(s), 1 warning(s))\n' }),
    { verified: true, status: 0, errors: 0 });
  assert.deepEqual(parseCertifyResult({ status: 1, stdout: 'certify validate: FAIL (1 app(s), 3 error(s), 0 warning(s))\n' }),
    { verified: true, status: 1, errors: 3 });
  for (const result of [
    { status: 0, stdout: '' },
    { status: null, error: Error('timeout') },
    { status: 0, stdout: 'certify validate: FAIL (1 app(s), 1 error(s), 0 warning(s))\n' },
    { status: 1, stdout: 'certify validate: ok (1 app(s), 0 error(s), 0 warning(s))\n' },
    { status: 0, stdout: 'certify validate: ok (1 app(s), 0 error(s), 0 warning(s))\ncertify validate: ok (1 app(s), 0 error(s), 0 warning(s))\n' },
  ]) assert.equal(parseCertifyResult(result).verified, false);
});

test('disablePush sets a disabled pushurl so the canary cannot push', (t) => {
  const cwd = repo(t, 'canary-push-');
  git(cwd, 'remote', 'add', 'origin', 'https://example.invalid/repo.git');
  disablePush(cwd, (file, args, options) => {
    execFileSync(file, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
  });
  assert.equal(git(cwd, 'config', '--get', 'remote.origin.pushurl'), 'DISABLED');
});

test('green canary on every consumer allows the bump', async (t) => {
  const { checkout, clone, cloned } = fleet(t, ['alpha', 'beta']);
  const applied = [];
  const result = await canary({
    repos: ['alpha', 'beta'], sha: NEW, checkout, clone,
    runGuards: async (ci, consumer, env) => {
      applied.push(readFileSync(join(consumer, '.github/workflows/company-guards.yml'), 'utf8'));
      assert.equal(env.GITHUB_EVENT_NAME, 'pull_request');
      assert.equal(env.SIZE_BASE_SHA.length, 40);
      assert.equal('GH_TOKEN' in env, false);
      return okGuards;
    },
    runCertify: async () => { throw new Error('certify should not run without a certification workflow'); },
  });
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(cloned, ['alpha', 'beta']);
  assert.equal(applied.length, 2);
  assert.ok(applied.every((body) => body.includes(NEW) && !body.includes(SHA)));
  assert.deepEqual(result.reports.map((r) => formatReport(r)), ['alpha: ok', 'beta: ok']);
});

test('one red consumer blocks the whole bump and still runs the others', async (t) => {
  const { checkout, clone } = fleet(t, ['ok-repo', 'red-repo']);
  const ran = [];
  const result = await canary({
    repos: ['ok-repo', 'red-repo'], sha: NEW, checkout, clone,
    runGuards: async (_ci, _consumer, env) => {
      ran.push(env.GITHUB_REPOSITORY);
      return env.GITHUB_REPOSITORY.endsWith('red-repo') ? redGuards : okGuards;
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 1);
  assert.deepEqual(ran.sort(), ['JovieInc/ok-repo', 'JovieInc/red-repo']);
  assert.match(formatReport(result.reports.find((r) => r.repo === 'red-repo')), /FAIL \(company-guards red/);
});

test('clone failure fails closed (the consumer is not skipped)', async (t) => {
  const { checkout } = fleet(t, ['missing']);
  const result = await canary({
    repos: ['missing'], sha: NEW, checkout,
    clone: async () => { throw new Error('denied'); },
    runGuards: async () => okGuards,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reports[0].reason, 'consumer clone unavailable');
});

test('unverified guard execution fails closed, never counts as green', async (t) => {
  const { checkout, clone } = fleet(t, ['example']);
  const result = await canary({
    repos: ['example'], sha: NEW, checkout, clone,
    runGuards: async () => unverified,
  });
  assert.equal(result.ok, false);
  assert.match(result.reports[0].reason, /unavailable or incomplete/);
});

test('a consumer absent from the reports is recorded as skipped and fails closed', async (t) => {
  const { checkout, clone } = fleet(t, ['kept', 'dropped']);
  const result = await canary({
    repos: ['kept', 'dropped'], sha: NEW, checkout,
    clone: async (name, dir, env) => {
      if (name === 'dropped') return;
      return clone(name, dir, env);
    },
    runGuards: async () => okGuards,
  });
  assert.equal(result.ok, false);
  const dropped = result.reports.find((r) => r.repo === 'dropped');
  assert.equal(dropped.ok, false);
  assert.match(dropped.reason, /unavailable|skipped/);
});

test('certify validate red fails the canary; missing certification workflow is ok', async (t) => {
  const { checkout, clone, consumers } = fleet(t, ['plain', 'app']);
  write(consumers.app, '.github/workflows/public-app-certification.yml', `uses: JovieInc/ci/.github/workflows/public-app-certification.yml@${SHA}\n`);
  commit(consumers.app);
  const certified = [];
  const result = await canary({
    repos: ['plain', 'app'], sha: NEW, checkout, clone,
    runGuards: async () => okGuards,
    runCertify: async (_ci, consumer) => {
      certified.push(consumer);
      const pin = readFileSync(join(consumer, '.github/workflows/public-app-certification.yml'), 'utf8');
      assert.match(pin, new RegExp(NEW));
      return redCertify;
    },
  });
  assert.equal(certified.length, 1);
  assert.equal(result.ok, false);
  assert.match(result.reports.find((r) => r.repo === 'app').reason, /certify validate red/);
  assert.equal(result.reports.find((r) => r.repo === 'plain').ok, true);
});

test('canary source never pushes or opens consumer PRs', () => {
  const src = readFileSync(new URL('../scripts/pin-bump-canary.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /\bgit\b[^`'"]*\bpush\b/);
  assert.doesNotMatch(src, /gh\s+pr\b/);
  assert.doesNotMatch(src, /gh\s+api\b/);
  assert.doesNotMatch(src, /allow-unreachable/);
});

function pinBumpYaml() {
  return readFileSync(new URL('../.github/workflows/pin-bump.yml', import.meta.url), 'utf8');
}

test('pin-bump.yml requires a green canary before any consumer write and fails closed on skip', () => {
  const yml = pinBumpYaml();
  assert.match(yml, /needs:\s*canary/);
  assert.match(yml, /needs\.canary\.result\s*==\s*'success'/);
  assert.match(yml, /node scripts\/pin-bump-canary\.mjs --sha/);
  assert.match(yml, /\[ "\$CANARY_VERDICT" = "green" \]/);
  assert.match(yml, /permission-contents:\s*read/);
  assert.match(yml, /verdict=no-bump/);
  assert.doesNotMatch(yml, /continue-on-error:\s*true/);
  assert.doesNotMatch(yml, /if:\s*always\(\)/);
  assert.doesNotMatch(yml, /JOVIE_[A-Z0-9_]*TOKEN/);
  const secretRefs = [...yml.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(secretRefs)], ['JOVIE_BOT_PRIVATE_KEY']);
  const runs = [...yml.matchAll(/runs-on:\s*(\S+)/g)].map((m) => m[1]);
  assert.ok(runs.length >= 2 && runs.every((r) => r === 'ubuntu-24.04'));
  const bump = yml.split('\n  bump:')[1] || '';
  assert.match(bump, /\[ "\$CANARY_VERDICT" = "green" \]/);
  assert.match(bump, /gh pr create/);
  const prIndex = bump.indexOf('gh pr create');
  const gateIndex = bump.indexOf('[ "$CANARY_VERDICT" = "green" ]');
  assert.ok(gateIndex >= 0 && prIndex > gateIndex, 'verdict gate must precede gh pr create');
});
