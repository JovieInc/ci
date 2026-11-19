import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { decide, run, upsertLinearIssue } from '../scripts/registry-create-check.mjs';

const fixture = () => ({
  reservedNames: [{ token: 'summer', family: 'summer', allowedKinds: ['vercel-project'] }],
  resources: [
    { kind: 'vercel-project', id: 'p1', name: 'jovie', aliases: ['jovie-production'],
      retiredNames: ['jovie-web'], status: 'canonical', purposeKey: 'web-app' },
    { kind: 'github-repo', name: 'JovieInc/Jovie', aliases: ['meetjovie/Jovie'], status: 'active' },
    { kind: 'vercel-project', id: 'p2', name: 'past-app', status: 'retired' },
    { kind: 'vercel-project', id: 'p3', name: 'renamed-app', retiredNames: ['former-app'], status: 'active' },
  ],
});
const payload = { kind: 'vercel-project', name: 'jovie-v2' };
const marker = 'registry-duplicate: vercel-project:jovie';
const runUrl = 'https://github.com/JovieInc/ci/actions/runs/123';
const options = () => ({ apiKey: 'linear-test-key', teamId: 'test-team',
  decision: decide(fixture(), payload), ...payload, runUrl });
const response = (json, status = 200) => ({ json, status });
const found = (nodes = []) => response({ data: { issues: { nodes } } });
const created = () => response({ data: { issueCreate: { success: true, issue: { identifier: 'JOV-9' } } } });
const commented = () => response({ data: { commentCreate: { success: true } } });
const existing = (title = `${marker} — previous name`) => ({ id: 'issue-id', identifier: 'JOV-9', title });
const githubCreate = () => [response([]), response({ name: 'registry-duplicate' }), response({ number: 42 })];

function mockFetch(replies = []) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, ...init, body: init.body ? JSON.parse(init.body) : undefined });
    assert.ok(init.signal instanceof AbortSignal, 'all requests have a bounded abort signal');
    const next = replies[calls.length - 1];
    assert.ok(next, `unexpected fetch: ${url}`);
    if (next instanceof Error) throw next;
    return { ok: next.status >= 200 && next.status < 300, status: next.status, json: async () => next.json };
  };
  return { fetch, calls };
}
const linearWrites = (calls) => calls.filter((call) => call.body?.query?.startsWith('mutation'));

async function runPayload(t, clientPayload, mock, env = {}, registry = fixture()) {
  const dir = mkdtempSync(join(tmpdir(), 'registry-create-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const eventPath = join(dir, 'event.json'), summary = join(dir, 'summary.md');
  writeFileSync(eventPath, JSON.stringify({ client_payload: clientPayload }));
  const result = await run({ registry, fetch: mock.fetch, env: {
    GITHUB_EVENT_PATH: eventPath, GITHUB_STEP_SUMMARY: summary,
    GITHUB_REPOSITORY: 'JovieInc/ci', GITHUB_TOKEN: 'github-test-key',
    LINEAR_API_KEY: 'linear-test-key', RUN_URL: runUrl, ...env,
  } });
  return { result, summary: readFileSync(summary, 'utf8') };
}

test('registered names and live aliases compare case-insensitively with no fetch', async (t) => {
  for (const item of [
    { kind: 'vercel-project', name: 'JOVIE' },
    { kind: 'vercel-project', name: 'Jovie-Production' },
    { kind: 'github-repo', name: 'jovieinc/JOVIE' },
    { kind: 'github-repo', name: 'MEETJOVIE/jovie' },
  ]) {
    assert.deepEqual(decide(fixture(), item), { action: 'registered' });
    const mock = mockFetch();
    const { result, summary } = await runPayload(t, item, mock);
    assert.equal(result.action, 'registered');
    assert.equal(mock.calls.length, 0);
    assert.match(summary, /Registry create: registered/);
  }
});

test('normalized twins share a key and include conflicting registry refs', () => {
  for (const name of ['jovie-v2', 'Jovie_v3', 'jovie-2']) {
    const decision = decide(fixture(), { kind: 'vercel-project', name });
    assert.equal(decision.action, 'duplicate');
    assert.equal(decision.key, 'vercel-project:jovie');
    assert.ok(decision.conflicts.includes('vercel-project:p1'));
    assert.ok(decision.conflicts.includes('github-repo:JovieInc/Jovie'));
    assert.match(decision.reason, /already owns/);
  }
  const web = decide(fixture(), { kind: 'vercel-project', name: 'Jovie_Web' });
  assert.equal(web.key, 'vercel-project:jovieweb');
  assert.ok(web.conflicts.includes('vercel-project:p1'), 'retired jovie-web name remains reserved');
  const plain = { resources: [{ kind: 'vercel-project', name: 'jovie', status: 'active' }] };
  assert.equal(decide(plain, { kind: 'vercel-project', name: 'Jovie_Web' }).action, 'unregistered',
    'the canonical guard does not strip a web suffix');
});

test('near-name, retired, placeholder, reserved token and cross-owner duplicates use the guard', () => {
  for (const [item, reason, ref] of [
    [{ kind: 'vercel-project', name: 'j0vie' }, /one edit away/, 'vercel-project:p1'],
    [{ kind: 'vercel-project', name: 'past-app' }, /retired names stay reserved/, 'vercel-project:p2'],
    [{ kind: 'vercel-project', name: 'former-app' }, /already owns/, 'vercel-project:p3'],
    [{ kind: 'vercel-project', name: 'newproject' }, /placeholder/, undefined],
    [{ kind: 'vercel-project', name: 'summer-dashboard' }, /reserved name/, undefined],
    [{ kind: 'github-repo', name: 'OtherOwner/Jovie' }, /already owns/, 'github-repo:JovieInc/Jovie'],
  ]) {
    const decision = decide(fixture(), item);
    assert.equal(decision.action, 'duplicate');
    assert.match(decision.reason, reason);
    if (ref) assert.ok(decision.conflicts.includes(ref));
    else assert.deepEqual(decision.conflicts, [], 'generic refusals must not implicate every entry');
  }
});

test('unique names are unregistered and do not fetch or supply a purposeKey', async (t) => {
  const mock = mockFetch();
  const { result } = await runPayload(t, { kind: 'vercel-project', name: 'wholly-distinct-service', purposeKey: 'web-app' }, mock);
  assert.deepEqual(result, { action: 'unregistered' });
  assert.equal(mock.calls.length, 0);
});

test('invalid payload shapes, bad kinds, spaces, newlines and repo names are ignored without fetching', async (t) => {
  const log = t.mock.method(console, 'log', () => {});
  for (const item of [undefined, null, [], 42, {}, { kind: 'domain', name: 'jovie' },
    { kind: 'vercel-project' }, { name: 'jovie' }, { kind: 'vercel-project', name: 1 },
    { kind: {}, name: 'jovie' }, { kind: 'vercel-project', name: '' },
    ...['bad name', 'bad\nname', 'jovie\n', 'jovie\r', 'a'.repeat(202), '$(echo-pwned)', 'jovié']
      .map((name) => ({ kind: 'vercel-project', name })),
    ...['repo', '/repo', 'owner/', 'owner/repo/extra'].map((name) => ({ kind: 'github-repo', name }))]) {
    const mock = mockFetch();
    const { result, summary } = await runPayload(t, item, mock);
    assert.deepEqual(result, { action: 'ignored' });
    assert.match(summary, /Registry create: ignored/);
    assert.equal(mock.calls.length, 0);
    assert.match(log.mock.calls.at(-1).arguments[0], /^::warning::.*ignored invalid payload/);
  }
});

test('CLI rejects malformed event JSON with exit zero and a step summary', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'registry-create-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const event = join(dir, 'event.json'), summary = join(dir, 'summary.md');
  writeFileSync(event, '{malformed');
  const result = spawnSync(process.execPath, ['scripts/registry-create-check.mjs'], {
    encoding: 'utf8', env: { ...process.env, GITHUB_EVENT_PATH: event, GITHUB_STEP_SUMMARY: summary },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /::warning::.*ignored invalid payload/);
  assert.match(readFileSync(summary, 'utf8'), /Registry create: ignored/);
});

test('Linear creates exactly one issue with the stable title and policy context', async () => {
  const mock = mockFetch([found(), created()]);
  assert.deepEqual(await upsertLinearIssue({ ...options(), fetch: mock.fetch }), { mode: 'created', identifier: 'JOV-9' });
  assert.equal(mock.calls.length, 2);
  const [search, create] = mock.calls;
  assert.equal(search.url, 'https://api.linear.app/graphql');
  assert.equal(search.headers.Authorization, 'linear-test-key');
  assert.deepEqual(search.body.variables, { teamId: 'test-team', marker });
  assert.match(search.body.query, /first: 1/);
  assert.match(search.body.query, /nin: \["completed", "canceled"\]/);
  assert.match(create.body.query, /issueCreate/);
  assert.match(create.body.variables.title, /^registry-duplicate: vercel-project:jovie — vercel-project "jovie-v2" collides with /);
  for (const expected of ['Kind: vercel-project', 'Name: jovie-v2', 'Reason:', 'vercel-project:p1',
    'registry-check can-create; exit 1 = reuse, never auto-delete', 'deletion/rename is a Tim per-item yes',
    runUrl, 'Linear parent: JOV-13051 / JOV-13083']) assert.ok(create.body.variables.body.includes(expected));
  assert.equal(linearWrites(mock.calls).length, 1);
});

test('Linear reuses an open normalized-key issue with exactly one comment', async () => {
  const mock = mockFetch([found([existing()]), commented()]);
  const opts = { ...options(), name: 'Jovie_v3' };
  assert.deepEqual(await upsertLinearIssue({ ...opts, fetch: mock.fetch }), { mode: 'reused', identifier: 'JOV-9' });
  assert.equal(mock.calls.length, 2);
  const [comment] = linearWrites(mock.calls);
  assert.match(comment.body.query, /commentCreate/);
  assert.equal(comment.body.variables.issueId, 'issue-id');
  for (const text of ['vercel-project', 'Jovie_v3', opts.decision.reason, runUrl]) {
    assert.ok(comment.body.variables.body.includes(text));
  }
  assert.equal(mock.calls.filter((call) => call.body?.query?.includes('issueCreate')).length, 0);
});

test('Linear reuses the filtered search result without requiring a returned title', async () => {
  const mock = mockFetch([found([{ id: 'issue-id', identifier: 'JOV-9' }]), commented()]);
  assert.equal((await upsertLinearIssue({ ...options(), fetch: mock.fetch })).mode, 'reused');
  assert.equal(linearWrites(mock.calls).length, 1);
  assert.match(linearWrites(mock.calls)[0].body.query, /commentCreate/);
});

for (const [label, failure] of [
  ['429', response({}, 429)], ['503', response({}, 503)],
  ['GraphQL error', response({ errors: [{ message: 'denied' }] })],
  ['network error', new Error('network unavailable')], ['missing data', response({ data: {} })],
]) {
  test(`Linear ${label} falls back to a labeled GitHub issue without throwing`, async (t) => {
    const mock = mockFetch([failure, ...githubCreate()]);
    const { result, summary } = await runPayload(t, payload, mock);
    assert.equal(result.linear.mode, 'fallback');
    assert.deepEqual(result.github, { mode: 'created', identifier: '#42' });
    assert.equal(mock.calls.length, 4);
    assert.equal(linearWrites(mock.calls).length, 0);
    const issue = mock.calls.at(-1);
    assert.equal(issue.url, 'https://api.github.com/repos/JovieInc/ci/issues');
    assert.equal(issue.method, 'POST');
    assert.equal(issue.headers.Authorization, 'Bearer github-test-key');
    assert.ok(issue.body.title.startsWith(`${marker} — `));
    assert.deepEqual(issue.body.labels, ['registry-duplicate']);
    assert.ok(issue.body.body.includes(runUrl));
    assert.match(summary, /Linear fallback; GitHub created/);
  });
}

test('failed Linear mutations are never retried and fall back with at most one Linear write', async (t) => {
  for (const node of [[], [existing()]]) {
    for (const failure of [response({}, 429), response({}, 500), response({ errors: [{ message: 'denied' }] }),
      response({ data: { issueCreate: { success: false }, commentCreate: { success: false } } })]) {
      const mock = mockFetch([found(node), failure, ...githubCreate()]);
      const { result } = await runPayload(t, payload, mock);
      assert.equal(result.linear.mode, 'fallback');
      assert.equal(result.github.mode, 'created');
      assert.equal(linearWrites(mock.calls).length, 1);
      assert.equal(mock.calls.length, 5);
    }
  }
});

test('Linear timeout aborts after ten seconds and returns fallback', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  const pending = upsertLinearIssue({ ...options(), fetch: async (_url, init) => {
    signal = init.signal;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true }));
  } });
  t.mock.timers.tick(9_999);
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(1);
  assert.deepEqual(await pending, { mode: 'fallback' });
  assert.equal(signal.aborted, true);
});

for (const [label, env] of [
  ['kill switch off', { REGISTRY_CREATE_LINEAR: 'off' }],
  ['empty API key', { LINEAR_API_KEY: '' }],
]) {
  test(`${label} skips Linear and creates a GitHub issue`, async (t) => {
    const mock = mockFetch(githubCreate());
    const { result } = await runPayload(t, payload, mock, env);
    assert.equal(result.linear.mode, 'fallback');
    assert.equal(result.github.mode, 'created');
    assert.ok(mock.calls.every((call) => call.url.startsWith('https://api.github.com/')));
    assert.equal(mock.calls.length, 3);
  });
}

test('GitHub fallback reuses an open marker issue, ignores prefix matches and pull requests', async (t) => {
  const mock = mockFetch([response([
    { number: 10, title: 'registry-duplicate: vercel-project:jovieweb — other' },
    { number: 11, title: `${marker} — PR`, pull_request: {} },
    { number: 42, title: `${marker} — original` },
  ]), response({ id: 88 })]);
  const { result } = await runPayload(t, { ...payload, name: 'Jovie_v3' }, mock, { LINEAR_API_KEY: '' });
  assert.deepEqual(result.github, { mode: 'reused', identifier: '#42' });
  assert.equal(mock.calls.length, 2);
  assert.equal(mock.calls[1].url, 'https://api.github.com/repos/JovieInc/ci/issues/42/comments');
  assert.ok(mock.calls[1].body.body.includes('Name: Jovie_v3'));
});

test('GitHub fallback paginates labeled issues to find an older open duplicate', async (t) => {
  const mock = mockFetch([response(Array.from({ length: 100 }, (_, number) => ({ number, title: 'unrelated' }))),
    response([{ number: 42, title: `${marker} — original` }]), response({ id: 88 })]);
  const { result } = await runPayload(t, payload, mock, { LINEAR_API_KEY: '' });
  assert.equal(result.github.mode, 'reused');
  assert.ok(mock.calls[1].url.endsWith('page=2'));
  assert.equal(mock.calls.length, 3);
});

test('GitHub fallback creates its label if missing and tolerates a concurrent label create', async (t) => {
  for (const status of [201, 422]) {
    const mock = mockFetch([response([]), response({}, 404), response({}, status), response({ number: 42 })]);
    const { result } = await runPayload(t, payload, mock, { LINEAR_API_KEY: '' });
    assert.equal(result.github.mode, 'created');
    assert.ok(mock.calls[2].url.endsWith('/labels'));
    assert.deepEqual(mock.calls[2].body, { name: 'registry-duplicate', color: 'B60205' });
  }
});

test('GitHub errors also warn and leave the job successful', async (t) => {
  const mock = mockFetch([response({}, 503)]);
  const { result, summary } = await runPayload(t, payload, mock, { REGISTRY_CREATE_LINEAR: 'off' });
  assert.equal(result.github.mode, 'unavailable');
  assert.match(summary, /GitHub unavailable/);
  assert.equal(mock.calls.length, 1);
});

test('extra relay fields are ignored, including issue destinations, key, reason and purpose', async (t) => {
  const mock = mockFetch([found(), created()]);
  const { result } = await runPayload(t, { ...payload, apiKey: 'injected-key', teamId: 'injected-team',
    key: 'injected', reason: 'injected', purposeKey: 'injected', runUrl: 'injected', conflicts: ['injected'] }, mock,
  { LINEAR_TEAM_ID: 'override-team' });
  assert.equal(result.linear.mode, 'created');
  assert.equal(mock.calls[0].body.variables.teamId, 'override-team');
  assert.equal(mock.calls[0].body.variables.marker, marker);
  assert.equal(mock.calls[1].body.variables.teamId, 'override-team');
  assert.ok(!JSON.stringify(mock.calls).includes('injected'));
});

test('the JOV team is the default and a successful Linear upsert never calls GitHub', async (t) => {
  const mock = mockFetch([found(), created()]);
  const { result } = await runPayload(t, payload, mock);
  assert.equal(mock.calls[0].body.variables.teamId, 'bdc09edc-f91c-4a06-b308-74b4fcf093f8');
  assert.equal(result.github, undefined);
  assert.equal(mock.calls.length, 2);
});
