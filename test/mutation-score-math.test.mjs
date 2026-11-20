import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreMutants } from '../lib/mutation-score-math.mjs';

test('scoreMutants: kill ratio over valid mutants', () => {
  const scored = scoreMutants([
    { status: 'Killed' },
    { status: 'Killed' },
    { status: 'Survived' },
  ]);
  assert.equal(scored.score, 66.7);
  assert.equal(scored.complete, true);
  assert.equal(scored.invalid, 0);
});

test('scoreMutants: excludes CompileError from the denominator', () => {
  const scored = scoreMutants([
    { status: 'Killed' },
    { status: 'CompileError' },
  ]);
  assert.equal(scored.score, 100);
  assert.equal(scored.invalid, 1);
  assert.equal(scored.valid, 1);
});

test('scoreMutants: withholds incomplete statuses', () => {
  for (const status of ['Timeout', 'Ignored', 'Pending']) {
    const scored = scoreMutants([{ status: 'Killed' }, { status }]);
    assert.equal(scored.score, null, status);
    assert.equal(scored.complete, false, status);
    assert.equal(scored.unknown, 1, status);
  }
});
