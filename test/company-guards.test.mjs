import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractMentions, checkMentions, recordMentions } from '../guards/mention.mjs';
import { canCreate } from '../guards/resources.mjs';
import { measure, compare } from '../guards/size.mjs';
import { evaluate } from '../guards/drift.mjs';
import { classify } from '../scripts/resource-drift.mjs';

const al = JSON.parse(readFileSync(new URL('../canon/mention-allowlist.json', import.meta.url)));
const reg = JSON.parse(readFileSync(new URL('../canon/resources.json', import.meta.url)));

test('mentions: extracts logins, skips code, scopes, emails', () => {
  assert.deepEqual(extractMentions('hi @timwhite and `@foo` and @types/node a@b.com ```\n@bar\n```'), ['timwhite']);
});
test('mentions: stranger refused, Tim allowed once per hour, bots ok', () => {
  assert.equal(checkMentions('@timwhite ping', al)[0].reason, 'not-allowlisted');
  assert.equal(checkMentions('@itstimwhite @dependabot[bot]', al).length, 0);
  const st = recordMentions('@itstimwhite', al, {}, 1000);
  assert.equal(checkMentions('@itstimwhite', al, { state: st, now: 2000 })[0].reason, 'rate-limited');
  assert.equal(checkMentions('@itstimwhite', al, { state: st, now: 1000 + 3600_001 }).length, 0);
});
test('resources: same purpose or alias refused, new purpose ok', () => {
  assert.equal(canCreate(reg, { kind: 'vercel-project', name: 'summer-2', purposeKey: 'summer-agent-app' }).ok, false);
  assert.equal(canCreate(reg, { kind: 'vercel-project', name: 'web', purposeKey: 'x' }).ok, false);
  assert.equal(canCreate(reg, { kind: 'vercel-project', name: 'brand-new', purposeKey: 'brand-new' }).ok, true);
});
test('size: new over-limit fails, growth fails, shrink ok', () => {
  const big = 'x\n'.repeat(600);
  const cur = measure(['a.ts', 'b.ts', 'c.md'], () => big);
  assert.deepEqual(Object.keys(cur), ['a.ts', 'b.ts']);
  assert.equal(compare(cur, { 'a.ts': 600 }).length, 1);
  assert.equal(compare(cur, { 'a.ts': 600, 'b.ts': 700 }).length, 0);
  assert.equal(compare(cur, { 'a.ts': 500, 'b.ts': 700 }).length, 1);
});
test('drift: within grace ok, stale fails', () => {
  const now = Date.parse('2026-10-29T00:00:00Z');
  const c = [{ sha: 'n', date: '2026-10-28T00:00:00Z' }, { sha: 'p', date: '2026-10-01T00:00:00Z' }];
  assert.equal(evaluate('n', c, now).ok, true);
  assert.equal(evaluate('p', c, now).ok, true);
  assert.equal(evaluate('p', c, Date.parse('2026-11-05T00:00:00Z')).ok, false);
});
test('drift scan: flags unregistered, duplicate, orphaned', () => {
  const f = classify(reg, { 'vercel-project': ['jovie', 'web', 'mystery'], 'github-repo': ['meetjovie/x'] });
  const types = f.map((x) => `${x.name}:${x.type}`);
  assert.ok(types.includes('web:duplicate') && types.includes('mystery:unregistered') && types.includes('summer:orphaned') && types.includes('meetjovie/x:unregistered'));
});

import { validate as validateTooling, diff as diffTooling } from '../scripts/tooling-drift.mjs';
const tooling = JSON.parse(readFileSync(new URL('../canon/tooling.json', import.meta.url)));
test('tooling: registry valid; drift flags unregistered and missing', () => {
  assert.deepEqual(validateTooling(tooling), []);
  const e = tooling.entries.find((x) => x.kind === 'mcp' && x.status === 'active');
  assert.deepEqual(diffTooling(tooling, { mcp: ['brand-new'] }).unregistered, ['mcp:brand-new']);
  assert.ok(diffTooling(tooling, { mcp: [] }).missing.includes(e.id));
});
