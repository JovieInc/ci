import test from 'node:test';
import assert from 'node:assert/strict';
import { checkPr, prFilesFromGit } from '../guards/plugins/data-paths.mjs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const p = { data: [/^data\//], append: [/^events\.jsonl$/], label: 'data-exception' };
test('data additions fail while data-only removal is permitted', () => {
 assert.equal(checkPr([{filename:'data/x.json',status:'added'}],p).length,1);
 assert.deepEqual(checkPr([{filename:'data/x.json',status:'removed'}],p),[]);
});
test('append-only additions fail while deletion is permitted', () => {
 assert.equal(checkPr([{filename:'events.jsonl',status:'modified',deletions:0}],p).length,1);
 assert.deepEqual(checkPr([{filename:'events.jsonl',status:'removed',deletions:1}],p),[]);
});


// A pull_request checkout: HEAD is the merge commit, HEAD^1 the base.
function prCheckout(t) {
  const d = mkdtempSync(join(tmpdir(), 'data-paths-'));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  const git = (...a) => execFileSync('git', a, { cwd: d, encoding: 'utf8' });
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t.t'); git('config', 'user.name', 't');
  writeFileSync(join(d, 'events.jsonl'), 'a\n'); writeFileSync(join(d, 'old.json'), '{}\n');
  git('add', '-A'); git('commit', '-qm', 'base');
  git('checkout', '-qb', 'pr');
  writeFileSync(join(d, 'events.jsonl'), 'a\nb\n'); git('rm', '-q', 'old.json'); writeFileSync(join(d, 'new.json'), '{}\n');
  git('add', '-A'); git('commit', '-qm', 'pr');
  git('checkout', '-q', 'main'); git('merge', '-q', '--no-ff', '-m', 'merge', 'pr');
  return { d, git };
}

test('prFilesFromGit reads the PR diff from the merge commit, with no API call', (t) => {
  const { d } = prCheckout(t);
  const files = prFilesFromGit(d).sort((a, b) => a.filename.localeCompare(b.filename));
  assert.deepEqual(files, [
    { filename: 'events.jsonl', status: 'modified', additions: 1, deletions: 0 },
    { filename: 'new.json', status: 'added', additions: 1, deletions: 0 },
    { filename: 'old.json', status: 'removed', additions: 0, deletions: 1 },
  ]);
});

test('prFilesFromGit fails closed when HEAD is not a merge commit', (t) => {
  const { d, git } = prCheckout(t);
  git('checkout', '-q', 'pr');
  assert.throws(() => prFilesFromGit(d), /merge commit/);
});

test('prFilesFromGit uses an explicit base when the caller gives one', (t) => {
  const { d, git } = prCheckout(t);
  git('checkout', '-q', 'pr');
  const base = git('rev-parse', 'HEAD~1').trim();
  assert.deepEqual(prFilesFromGit(d, base).map((f) => f.filename).sort(), ['events.jsonl', 'new.json', 'old.json']);
});
