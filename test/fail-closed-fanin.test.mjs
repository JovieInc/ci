import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertShardsSuccess,
  describeFanInPair,
  evaluateShardFanIn,
  fanInGateShell,
  NON_SUCCESS_SHARD_RESULTS,
} from '../lib/fail-closed-fanin.mjs';

test('only success greens the fan-in', () => {
  assert.equal(evaluateShardFanIn('success').ok, true);
  for (const result of NON_SUCCESS_SHARD_RESULTS) {
    assert.equal(evaluateShardFanIn(result).ok, false, result);
  }
  assert.equal(evaluateShardFanIn(null).ok, false);
});

test('assertShardsSuccess exits non-zero off the success path', () => {
  const exits = [];
  const errors = [];
  assert.equal(
    assertShardsSuccess('success', {
      error: msg => errors.push(msg),
      exit: code => exits.push(code),
    }),
    0
  );
  assert.deepEqual(exits, []);
  assertShardsSuccess('cancelled', {
    error: msg => errors.push(msg),
    exit: code => exits.push(code),
  });
  assert.deepEqual(exits, [1]);
  assert.match(errors[0], /failed closed/);
});

test('fanInGateShell and describeFanInPair keep fail-closed contract', () => {
  const shell = fanInGateShell('ci-fast shards');
  assert.match(shell, /SHARDS_RESULT/);
  assert.match(shell, /failed closed/);
  assert.doesNotMatch(shell, /continue-on-error/);
  const pair = describeFanInPair({
    faninJob: 'ci-fast-remaining',
    workerJob: 'ci-fast-remaining-shards',
    requiredName: 'ci-fast (remaining)',
    matrix: { shard: [1, 2, 3] },
  });
  assert.equal(pair.failFast, false);
  assert.equal(pair.fanInIfAlways, true);
  assert.ok(pair.gateFailsOn.includes('skipped'));
});
