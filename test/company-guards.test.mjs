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

import { policyFor, checkPr, ratchet } from '../guards/plugins/data-paths.mjs';
const dp = policyFor(JSON.parse(readFileSync(new URL('../canon/data-paths.json', import.meta.url))), 'Jovie');
const f = (filename, additions = 1, deletions = 0, status = 'modified') => ({ filename, additions, deletions, status });
test('data-paths: wins-only PR fails, mixed passes, label waives', () => {
  assert.equal(checkPr([f('canon/wins/wins.jsonl'), f('docs/metrics/wins-latest.json')], dp).length, 1);
  assert.equal(checkPr([f('canon/wins/wins.jsonl'), f('scripts/x.mjs')], dp).length, 0);
  assert.equal(checkPr([f('canon/wins/wins.jsonl')], dp, ['data-exception']).length, 0);
});
test('data-paths: append-only registry row alone fails, edits to rows pass', () => {
  assert.equal(checkPr([f('canon/automation-registry.jsonl')], dp).length, 1);
  assert.equal(checkPr([f('canon/automation-registry.jsonl', 1, 1)], dp).length, 0);
});
test('data-paths: ratchet only shrinks', () => {
  assert.equal(ratchet(['canon/wins/a.jsonl'], dp, { files: [] }).fails.length, 1);
  assert.equal(ratchet(['canon/wins/a.jsonl'], dp, { files: ['canon/wins/a.jsonl'] }).fails.length, 0);
  assert.equal(ratchet([], dp, { files: ['canon/wins/a.jsonl'] }).fails.length, 0);
});
