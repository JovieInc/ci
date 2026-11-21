import assert from 'node:assert/strict';
import test from 'node:test';
import { runCommandPool } from '../lib/command-pool.mjs';

test('concurrency 1 keepGoing false matches serial first-failure stop', async () => {
  const started = [];
  const results = await runCommandPool(['a', 'b', 'c'], {
    concurrency: 1,
    keepGoing: false,
    execute: command => {
      started.push(command);
      return { code: command === 'a' ? 1 : 0, output: command };
    },
  });
  assert.deepEqual(started, ['a']);
  assert.equal(results[0].code, 1);
  assert.equal(results[1], undefined);
  assert.equal(results[2], undefined);
});

test('keepGoing true runs every command; first failure decides list-order code', async () => {
  const results = await runCommandPool(['ok', 'fail', 'ok2'], {
    concurrency: 2,
    keepGoing: true,
    execute: command => ({
      code: command === 'fail' ? 7 : 0,
      output: command,
    }),
  });
  assert.equal(results.length, 3);
  assert.equal(results.every(Boolean), true);
  assert.equal(results[1].code, 7);
  assert.equal(results[0].code, 0);
});

test('shared locks serialize and long poles may start first', async () => {
  /** @type {string[]} */
  const order = [];
  let clock = 0;
  const results = await runCommandPool(['slow', 'fast', 'locked-a', 'locked-b'], {
    concurrency: 3,
    keepGoing: true,
    locks: [[], [], ['x'], ['x']],
    first: [0],
    now: () => ++clock,
    execute: command => {
      order.push(command);
      return { code: 0, output: command };
    },
  });
  assert.equal(order[0], 'slow');
  assert.equal(results.every(r => r.code === 0), true);
  const lockedStarts = order.filter(c => c.startsWith('locked'));
  assert.deepEqual(lockedStarts, ['locked-a', 'locked-b']);
});
