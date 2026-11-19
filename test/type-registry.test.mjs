// Behavior tests for the type registry (guards/resources.mjs, company-resource-registry/v2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { keyOf, validate, canCreate, drift } from '../guards/resources.mjs';

const fx = () => ({
  people: [{ id: 'tim' }],
  reservedNames: [{ token: 'summer', family: 'summer', allowedKinds: ['eve-agent', 'github-repo', 'vercel-project', 'domain'] }],
  knownViolations: [],
  resources: [
    { kind: 'eve-agent', id: 'summer.jov.ie', name: 'Summer', family: 'summer', status: 'active', owner: 'person:tim' },
    { kind: 'grok-bot', id: 'b1', name: 'Eve Runtime Owner', retiredNames: ['Summer Owner'], status: 'active', owner: 'person:tim' },
    { kind: 'grok-bot', id: 'b2', name: 'Retired · Rush', status: 'retired', owner: 'person:tim' },
    { kind: 'github-repo', name: 'JovieInc/Jovie', family: 'jovie', purposeKey: 'jovie-product', status: 'canonical', owner: 'person:tim' },
    { kind: 'github-repo', name: 'JovieInc/summer-config', family: 'summer', status: 'canonical', owner: 'person:tim' },
    { kind: 'vercel-project', id: 'p1', name: 'jovie', family: 'jovie', purposeKey: 'jovie-web-app', status: 'canonical', owner: 'person:tim' },
    { kind: 'vercel-project', id: 'p2', name: 'jovie-v1', family: 'jovie', purposeKey: 'jovie-web-app', status: 'duplicate', duplicateOf: 'vercel-project:p1', owner: 'person:tim' },
    { kind: 'domain', name: 'jov.ie', status: 'canonical', owner: 'person:tim' },
    { kind: 'webhook', name: 'registry-create-github-org', purposeKey: 'registry-create-github', provider: 'github', scope: 'org:JovieInc', events: ['repository'], target: 'https://jov.ie/api/webhooks/registry-create', secretEnv: 'REGISTRY_GITHUB_WEBHOOK_SECRET', owner: 'person:tim', linear: 'JOV-13083', family: 'ci', status: 'active_uncommissioned' },
    { kind: 'webhook', name: 'registry-create-vercel-team', purposeKey: 'registry-create-vercel', provider: 'vercel', scope: 'team:jovie', events: ['project.created'], target: 'https://jov.ie/api/webhooks/registry-create', secretEnv: 'REGISTRY_VERCEL_WEBHOOK_SECRET', owner: 'person:tim', linear: 'JOV-13083', family: 'ci', status: 'active_uncommissioned' },
  ],
});

test('normalized keys collapse case, punctuation, copies, versions and dodge suffixes', () => {
  assert.equal(keyOf('vercel-project', 'Jovie_V1'), 'jovie');
  assert.equal(keyOf('github-repo', 'meetjovie/Jovie'), 'jovie');
  assert.equal(keyOf('hyperagent-agent', 'GLM 5.3 Developer (copy)'), keyOf('hyperagent-agent', 'GLM 5.3 Developer'));
  assert.equal(keyOf('vercel-project', 'lyb-vercel-scope-1d2m0j'), 'lybvercelscope');
  assert.equal(keyOf('grok-bot', 'Retired · Rush'), 'rush');
  assert.equal(keyOf('domain', 'Jov.ie'), 'domain:jov.ie');
});

test('a clean fixture validates; known duplicates pointing at canon are allowed', () => {
  assert.deepEqual(validate(fx()).fails, []);
});

test('webhook entries validate and use normal, non-namespaced keys', () => {
  const r = fx();
  assert.equal(r.resources.filter((e) => e.kind === 'webhook').length, 2);
  assert.deepEqual(validate(r).fails, []);
  assert.equal(keyOf('webhook', 'Registry_Create-Github-Org-2'), 'registrycreategithuborg');
  assert.equal(canCreate(r, { kind: 'webhook', name: 'linear-issue-events', purposeKey: 'linear-issue-events' }).ok, true);
});

test('can-create refuses existing and normalized twin webhooks before commissioning', () => {
  for (const name of ['registry-create-github-org', 'Registry_Create-Github-Org-2']) {
    const result = canCreate(fx(), { kind: 'webhook', name, family: 'ci' });
    assert.equal(result.ok, false, name);
    assert.match(result.reason, /webhook "registry-create-github-org" \(active_uncommissioned\) already owns "registrycreategithuborg"/);
  }
});

test('two live webhooks cannot serve the same purposeKey', () => {
  const r = fx();
  const webhook = r.resources.find((e) => e.kind === 'webhook');
  const duplicate = { ...webhook, name: 'github-inventory-events' };
  const result = canCreate(r, duplicate);
  assert.equal(result.ok, false);
  assert.match(result.reason, /purpose "registry-create-github" already served by webhook/);
  r.resources.push(duplicate);
  assert.match(validate(r).fails.join('\n'), /purpose "registry-create-github" served twice: webhook:registry-create-github-org and webhook:github-inventory-events/);
});

test('webhook names cannot collide with a repository in a different family', () => {
  const r = fx();
  const webhook = { ...r.resources.find((e) => e.kind === 'webhook'), name: 'JOVIE' };
  const result = canCreate(r, webhook);
  assert.equal(result.ok, false);
  assert.match(result.reason, /github-repo "JovieInc\/Jovie"/);
  r.resources.push(webhook);
  assert.match(validate(r).fails.join('\n'), /name collision "jovie": github-repo:JovieInc\/Jovie .* vs webhook:JOVIE/);
});

test('two live entries with the same normalized name fail, across kinds too', () => {
  const r = fx();
  r.resources.push({ kind: 'room', id: 'r1', name: 'jovie', status: 'active', owner: 'person:tim' });
  r.resources.push({ kind: 'vercel-project', id: 'p3', name: 'Jovie-Web', status: 'canonical', owner: 'person:tim' });
  r.resources.push({ kind: 'vercel-project', id: 'p4', name: 'jovie_web', status: 'canonical', owner: 'person:tim' });
  const f = validate(r).fails.join('\n');
  assert.match(f, /room:r1/);
  assert.match(f, /name collision "jovieweb"/);
});

test('reserved name: only the Eve family may use "summer"', () => {
  const r = fx();
  r.resources.push({ kind: 'room', id: 'r2', name: 'Summer, Ops', status: 'active', owner: 'person:tim' });
  assert.match(validate(r).fails.join('\n'), /reserved name "summer"/);
  assert.equal(canCreate(fx(), { kind: 'grok-bot', name: 'Summer Owner' }).ok, false);
  assert.equal(canCreate(fx(), { kind: 'vercel-project', name: 'summer', family: 'summer', purposeKey: 'summer-app' }).ok, true);
});

test('free-text or dangling owners and links fail', () => {
  const r = fx();
  r.resources[3].owner = 'Summer';
  r.resources[6].duplicateOf = 'vercel-project:nope';
  const f = validate(r).fails.join('\n');
  assert.match(f, /owner "Summer" is not a registry ref/);
  assert.match(f, /unknown ref vercel-project:nope/);
});

test('can-create refuses duplicates, renames-to-dodge, placeholders and retired names', () => {
  const r = fx();
  for (const name of ['jovie', 'JOVIE', 'jovie-2', 'jovie-new', 'jovie_v3']) assert.equal(canCreate(r, { kind: 'vercel-project', name }).ok, false, name);
  assert.equal(canCreate(r, { kind: 'vercel-project', name: 'j0vie' }).ok, false);
  assert.equal(canCreate(r, { kind: 'grok-bot', name: 'New Bot' }).ok, false);
  assert.equal(canCreate(r, { kind: 'grok-bot', name: 'Rush' }).ok, false);
  assert.equal(canCreate(r, { kind: 'grok-bot', name: 'Rush', supersedes: 'grok-bot:b2' }).ok, true);
  assert.equal(canCreate(r, { kind: 'vercel-project', name: 'anything', purposeKey: 'jovie-web-app' }).ok, false);
});

test('legit monorepo second project passes with its own purpose', () => {
  assert.equal(canCreate(fx(), { kind: 'vercel-project', name: 'jovie-docs', purposeKey: 'jovie-docs', family: 'jovie' }).ok, true);
});

test('knownViolations ratchet: needs a tracker id and expiry, and is removed once fixed', () => {
  const r = fx();
  r.resources.push({ kind: 'vercel-project', id: 'p5', name: 'v0-a-1d2m0j', status: 'unregistered', owner: 'person:tim' });
  r.resources.push({ kind: 'vercel-project', id: 'p6', name: 'v0-a-9x8y7z', status: 'unregistered', owner: 'person:tim' });
  r.knownViolations = [{ match: '"v0a"', issue: 'JOV-1', until: '2999-01-01' }];
  assert.deepEqual(validate(r).fails, []);
  r.knownViolations[0].issue = 'TBD';
  assert.equal(validate(r).fails.length, 1);
  r.resources.pop(); r.knownViolations[0].issue = 'JOV-1';
  assert.match(validate(r).fails.join(), /no longer matches/);
});

test('drift flags unregistered live resources, renames and live collisions', () => {
  const f = drift(fx(), [
    { kind: 'vercel-project', id: 'p1', name: 'jovie' },
    { kind: 'vercel-project', id: 'p9', name: 'jovie-web' },
    { kind: 'grok-bot', id: 'b1', name: 'Summer Owner' },
  ], { completeKinds: ['vercel-project'] });
  const types = f.map((x) => x.type);
  assert.ok(types.includes('unregistered'));
  assert.ok(types.includes('name-drift'));
  assert.ok(types.includes('live-collision'));
});

test('the committed canon validates', () => {
  const canon = JSON.parse(readFileSync(new URL('../canon/resources.json', import.meta.url), 'utf8'));
  assert.deepEqual(validate(canon).fails, []);
});
