import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parsePin, parseGuardResult, compareResults, guardEnv, gitEnv, parseArgs,
  cloneConsumer, selftest, formatReport } from '../scripts/consumer-selftest.mjs';

const SHA = 'a'.repeat(40);
const good = (fails = []) => ({ verified: true, fails });
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
function write(cwd, path, text) {
  mkdirSync(dirname(join(cwd, path)), { recursive: true }); writeFileSync(join(cwd, path), text);
}
function repo(t, prefix) {
  const cwd = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  git(cwd, 'init', '-q', '-b', 'main');
  git(cwd, 'config', 'user.email', 'test@example.invalid'); git(cwd, 'config', 'user.name', 'fixture');
  git(cwd, 'config', 'commit.gpgsign', 'false');
  return cwd;
}
function commit(cwd) { git(cwd, 'add', '-A'); git(cwd, 'commit', '-qm', 'fixture'); return git(cwd, 'rev-parse', 'HEAD'); }
const runner = (findings, warning = '') => `
import { readFileSync } from 'node:fs';
const env = process.env;
if ('PR_BODY' in env || 'SIZE_BASE_SHA' in env || 'GITHUB_EVENT_NAME' in env || 'GH_TOKEN' in env || 'GITHUB_TOKEN' in env) throw Error('PR env leaked');
const fails = ${JSON.stringify(findings)};
console.log('::warning::${warning}');
for (const f of fails) console.error('::error::' + f);
console.log('company-guards: ' + (fails.length ? 'FAIL' : 'ok') + ' (' + fails.length + ')');
process.exitCode = fails.length ? 1 : 0;
`;
function fleet(t, before = [], after = [], warning = '') {
  const checkout = repo(t, 'selftest-ci-');
  write(checkout, 'canon/consumers.json', JSON.stringify({ repos: ['example'], pinFile: '.github/workflows/company-guards.yml' }));
  write(checkout, 'guards/drift.mjs', "throw Error('drift must never run');\n");
  write(checkout, 'guards/run.mjs', runner(before));
  const pin = commit(checkout);
  write(checkout, 'guards/run.mjs', runner(after, warning));
  const consumer = repo(t, 'selftest-consumer-');
  write(consumer, '.github/workflows/company-guards.yml', `jobs:\n  guards:\n    with:\n      ci-ref: '${pin}'\n`);
  commit(consumer);
  const cloned = [];
  const clone = (name, dir, env) => {
    cloned.push(dir);
    git(dirname(dir), '-c', 'protocol.file.allow=always', 'clone', '--depth', '2', '--branch', 'main', pathToFileURL(consumer).href, dir);
    assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  };
  return { checkout, consumer, pin, clone, cloned };
}

test('pure comparison: red on new enforcing finding, green on pre-existing/removals', () => {
  assert.deepEqual(compareResults(good(['existing']), good(['existing', 'new', 'new'])), { verified: true, newFailures: ['new'] });
  assert.deepEqual(compareResults(good(['existing', 'removed']), good(['existing'])), { verified: true, newFailures: [] });
  assert.deepEqual(compareResults(good(), good()), { verified: true, newFailures: [] });
  for (const [a, b] of [[undefined, undefined], [good(), { verified: false }], [{ verified: false }, good()]])
    assert.deepEqual(compareResults(a, b), { verified: false, newFailures: [] });
});
test('result parsing ignores shadow warnings and rejects missing/contradictory verdicts (deliberate red)', () => {
  assert.deepEqual(parseGuardResult({ status: 0, stdout: '::warning::lockfile-majors: MAJOR: alpha\ncompany-guards: ok (0)\n' }),
    { verified: true, fails: [], status: 0 });
  const red = parseGuardResult({ status: 1, stdout: 'company-guards: FAIL (1)\n', stderr: '::error::size-500: grew\n' });
  assert.deepEqual(red, { verified: true, fails: ['size-500: grew'], status: 1 });
  for (const result of [
    { status: 0, stdout: '' }, { status: null, error: Error('timeout') }, { status: 2, stdout: 'company-guards: FAIL (0)\n' },
    { status: 1, stdout: '::warning::only warnings\ncompany-guards: FAIL (0)\n' },
    { status: 0, stdout: 'company-guards: ok (0)\n', stderr: '::error::actual failure\n' },
    { status: 1, stdout: 'company-guards: ok (1)\n', stderr: '::error::failure\n' },
    { status: 1, stdout: 'company-guards: FAIL (2)\n', stderr: '::error::one failure\n' },
    { status: 0, stdout: 'company-guards: ok (0)\ncompany-guards: ok (0)\n' },
  ]) assert.equal(parseGuardResult(result).verified, false);
});
test('pin extraction accepts full SHA quotes/comments, refuses moving and ambiguous refs', () => {
  for (const value of [SHA, `'${SHA}'`, `"${SHA}" # comment`]) assert.equal(parsePin(`  ci-ref: ${value}\n`), SHA);
  for (const body of ['', 'ci-ref: main', 'ci-ref: abcdef0', `ci-ref: ${SHA}\nci-ref: ${'b'.repeat(40)}`])
    assert.throws(() => parsePin(body), /ci-ref/);
});
test('argument parsing covers fleet defaults, repo subsets and explicit unreachable opt-out', () => {
  assert.deepEqual(parseArgs([], ['one', 'two']), { repos: ['one', 'two'], allowUnreachable: false });
  assert.deepEqual(parseArgs(['--repos', 'one,two,one', '--allow-unreachable'], []), { repos: ['one', 'two'], allowUnreachable: true });
  assert.deepEqual(parseArgs(['--repos=one'], []), { repos: ['one'], allowUnreachable: false });
  for (const args of [['--repos'], ['--repos='], ['--repos=../escape'], ['--repos=..'], ['--unknown']])
    assert.throws(() => parseArgs(args, ['one']));
});
test('guard environment removes PR context and credentials; git auth uses memory-only extraheader', () => {
  const env = { PATH: '/bin', PR_BODY: 'body', PR_LABELS: '[]', PR_NUMBER: '1', SIZE_BASE_SHA: SHA, GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_TOKEN: 'secret-token', GH_TOKEN: 'preferred-token', GITHUB_REPOSITORY: 'wrong/repo', GITHUB_BASE_REF: 'main',
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'secret', GIT_CONFIG_VALUE_0: 'secret' };
  assert.deepEqual(guardEnv(env, 'example'), { PATH: '/bin', GITHUB_REPOSITORY: 'JovieInc/example' });
  const auth = gitEnv({ ...env, GIT_TRACE: '1', GIT_TRACE_CURL: '1', GIT_CURL_VERBOSE: '1' });
  assert.equal(auth.GIT_CONFIG_KEY_1, 'http.https://github.com/.extraheader');
  assert.equal(auth.GIT_CONFIG_VALUE_1, `AUTHORIZATION: basic ${Buffer.from('x-access-token:preferred-token').toString('base64')}`);
  assert.equal(auth.GIT_TRACE, undefined); assert.equal(auth.GIT_TRACE_CURL, undefined); assert.equal(auth.GIT_CURL_VERBOSE, undefined);
  assert.equal(gitEnv({ GITHUB_TOKEN: 'fallback' }).GIT_CONFIG_COUNT, '2');
  assert.equal(gitEnv({}).GIT_CONFIG_COUNT, '1');
});
test('production clone uses HTTPS main with depth 2; auth never appears in arguments', () => {
  let call;
  cloneConsumer('example', '/tmp/consumer', gitEnv({ GH_TOKEN: 'secret' }), (...args) => { call = args; });
  assert.deepEqual(call.slice(0, 2), ['git', ['clone', '--depth', '2', '--branch', 'main', '--single-branch', 'https://github.com/JovieInc/example.git', '/tmp/consumer']]);
  assert.doesNotMatch(JSON.stringify(call[1]), /secret|AUTHORIZATION/);
});
test('real temp git archives compare pinned failures with uncommitted candidate; no drift or PR env', async (t) => {
  const f = fleet(t, ['existing'], ['existing', 'new candidate violation']);
  const originalHead = git(f.checkout, 'rev-parse', 'HEAD');
  const result = await selftest({ ...f, env: { PATH: process.env.PATH, PR_BODY: 'leaked', GITHUB_EVENT_NAME: 'pull_request',
    SIZE_BASE_SHA: SHA, GH_TOKEN: 'must-not-leak', GITHUB_TOKEN: 'also-secret' } });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.reports[0].newFailures, ['new candidate violation']);
  assert.equal(result.reports[0].pin, f.pin);
  assert.equal(result.reports[0].pinned.verified, true);
  assert.equal(result.reports[0].candidate.verified, true);
  assert.match(formatReport(result.reports[0]), /pinned-result=FAIL \(1\) candidate-result=FAIL \(2\) NEW failures=1/);
  assert.equal(git(f.checkout, 'rev-parse', 'HEAD'), originalHead);
  assert.match(git(f.checkout, 'status', '--short'), /M guards\/run.mjs/);
  for (const path of f.cloned) assert.equal(existsSync(path), false, 'scratch checkout cleaned');
});
test('pre-existing failures and new shadow warnings do not red a consumer', async (t) => {
  const f = fleet(t, ['existing'], ['existing'], 'lockfile-majors: new shadow finding');
  const r = await selftest(f);
  assert.equal(r.exitCode, 0); assert.deepEqual(r.reports[0].newFailures, []); assert.equal(r.reports[0].verified, true);
});
test('unreachable consumer reported unverified, fails closed unless explicitly allowed, no secrets printed', async (t) => {
  const f = fleet(t);
  for (const allowUnreachable of [false, true]) {
    const r = await selftest({ ...f, allowUnreachable, clone: () => { throw Error('TOKEN secret-123'); } });
    assert.equal(r.exitCode, allowUnreachable ? 0 : 1); assert.equal(r.reports[0].verified, false);
    assert.match(formatReport(r.reports[0]), /pinned-result=unverified candidate-result=unverified.*unverified/);
    assert.doesNotMatch(JSON.stringify(r), /TOKEN|secret-123/);
  }
});
test('missing consumer pin, unavailable archive and incomplete runner all fail closed', async (t) => {
  for (const broken of ['pin', 'archive', 'runner']) {
    const f = fleet(t);
    if (broken === 'pin') { write(f.consumer, '.github/workflows/company-guards.yml', 'ci-ref: main\n'); commit(f.consumer); }
    const r = await selftest({ ...f, allowUnreachable: true,
      ...(broken === 'archive' ? { pinnedTree: () => { throw Error('archive absent'); } } : {}),
      ...(broken === 'runner' ? { runGuards: () => parseGuardResult({ status: 0, stdout: '' }) } : {}),
    });
    assert.equal(r.exitCode, 1, broken); assert.equal(r.reports[0].verified, false);
    assert.deepEqual(r.reports[0].newFailures, []);
  }
});
test('allow-unreachable never waives a verified new failure; one unreachable repo does not stop others', async (t) => {
  const f = fleet(t, [], ['new']);
  const seen = [];
  const r = await selftest({ ...f, repos: ['unreachable', 'example'], allowUnreachable: true, clone: (repo, ...args) => {
    seen.push(repo); if (repo === 'unreachable') throw Error('unreachable'); return f.clone(repo, ...args);
  } });
  assert.deepEqual(seen, ['unreachable', 'example']); assert.equal(r.exitCode, 1);
  assert.equal(r.reports[0].verified, false); assert.deepEqual(r.reports[1].newFailures, ['new']);
});
test('empty consumer selection refuses a vacuous pass; source registry still covers six consumers', async (t) => {
  const f = fleet(t);
  await assert.rejects(selftest({ ...f, repos: [] }), /no consumers selected/);
  const config = JSON.parse(readFileSync(new URL('../canon/consumers.json', import.meta.url), 'utf8'));
  assert.equal(config.repos.length, 6);
});

test('parsePin reads Jovie\'s comment pin form', async () => {
  const { parsePin } = await import('../scripts/consumer-selftest.mjs');
  const sha = '6b3f0077d9d0ad0b2d9547c5848e006084f94056';
  assert.equal(parsePin(`# Shared suite\n# ci-ref: ${sha}\n  run: sha=$(sed -n 's/^# ci-ref: x/p')\n`), sha);
});

test('a consumer without Company guards wiring is reported, not failed', async () => {
  const { selftest } = await import('../scripts/consumer-selftest.mjs');
  const result = await selftest({ repos: ['symphony'], clone: (_repo, dir) => mkdirSync(dir, { recursive: true }),
    runGuards: () => { throw new Error('must not run guards for an unwired consumer'); } });
  assert.equal(result.exitCode, 0);
  assert.equal(result.reports[0].notWired, true);
});
