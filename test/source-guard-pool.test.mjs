import assert from 'node:assert/strict';
import test from 'node:test';
import {
  runSourceGuards,
  sourceGuardBlock,
  sourceGuardConcurrency,
  sourceGuardLocks,
} from '../lib/source-guard-pool.mjs';

test('SOURCE_GUARD_CONCURRENCY=1 restores serial bound', () => {
  assert.equal(sourceGuardConcurrency('1'), 1);
  assert.equal(sourceGuardConcurrency('8'), 8);
  assert.ok(sourceGuardConcurrency('') <= 3);
});

test('git mutating commands share the git lock', () => {
  assert.deepEqual(sourceGuardLocks('git worktree add /tmp/x'), ['git']);
  assert.deepEqual(sourceGuardLocks('echo hi'), []);
  assert.deepEqual(
    sourceGuardLocks('pnpm test', () => ['coverage:scripts']),
    ['coverage:scripts']
  );
});

test('sourceGuardBlock wraps stop-commands and annotates failures', () => {
  const ok = sourceGuardBlock('g1', { code: 0, output: 'hi\n', durationMs: 12 });
  assert.match(ok, /::stop-commands::/);
  assert.match(ok, /\[source-guards\] g1: exit 0; duration_ms=12/);
  assert.doesNotMatch(ok, /::error title=/);
  const bad = sourceGuardBlock('g2', { code: 3, output: '', durationMs: 1 });
  assert.match(bad, /::error title=source guard g2::/);
});

test('runSourceGuards runs all, first failure wins, empty skips', async () => {
  const empty = await runSourceGuards([]);
  assert.equal(empty.skipped, true);
  assert.equal(empty.code, 0);

  const logs = [];
  const { code } = await runSourceGuards(
    [
      { id: 'a', command: 'a' },
      { id: 'b', command: 'b' },
      { id: 'c', command: 'c' },
    ],
    {
      concurrency: 2,
      longPoles: ['b'],
      log: line => logs.push(line),
      execute: command => ({
        code: command === 'b' ? 9 : 0,
        output: `${command}\n`,
      }),
    }
  );
  assert.equal(code, 9);
  assert.equal(logs.length, 3);
  assert.match(logs[0], /\[source-guards\] a:/);
  assert.match(logs[1], /\[source-guards\] b:/);
  assert.match(logs[2], /\[source-guards\] c:/);
});
