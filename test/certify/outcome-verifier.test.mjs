import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { acceptedNegativeControls, assertOutcome, detectFailureSurface, FAILURE_SURFACE_RULES,
  foldVerdict, NEGATIVE_CONTROLS, POSITIVE_CONTROLS, verifyOutcome } from '../../certify/lib/outcome-verifier.mjs';

for (const sample of NEGATIVE_CONTROLS) test(`rejects ${sample.id}`, () => {
  assert.ok(detectFailureSurface(sample.text));
  assert.equal(verifyOutcome(sample.text, { label: 'control' }).ok, false);
});
for (const sample of POSITIVE_CONTROLS) test(`accepts ${sample.id}`, () => {
  assert.equal(detectFailureSurface(sample.text), null);
  assert.equal(verifyOutcome(sample.text, { label: 'control' }).ok, true);
});
const sourceCopy = JSON.parse(readFileSync(new URL('./fixtures/outcome-source-copy.json', import.meta.url)));
test('frozen source-derived failure copy is detected (HTTP 200 is insufficient)', () => {
  assert.ok(sourceCopy.length > 20);
  assert.deepEqual(sourceCopy.filter(t => t !== 'messages array must include a user message' && !detectFailureSurface(t)), []);
});
test('every detector rule has a negative control', () => {
  const samples = [...NEGATIVE_CONTROLS.map(c => c.text), ...sourceCopy,
    'Service is paused', 'coming soon', 'no items found'];
  const hit = new Set(samples.map(t => detectFailureSurface(t)?.rule));
  assert.deepEqual(FAILURE_SURFACE_RULES.map(r => r.id).filter(id => !hit.has(id)), []);
});
test('legacy visible-reply predicate accepts error walls; verifier does not', () => {
  assert.ok(acceptedNegativeControls(t => t.trim().length > 0).length > NEGATIVE_CONTROLS.length - 2);
  assert.deepEqual(acceptedNegativeControls(t => verifyOutcome(t, { label: 'self' }).ok), []);
  assert.deepEqual(acceptedNegativeControls(() => { throw new Error('reject'); }), []);
  assert.throws(() => assertOutcome(NEGATIVE_CONTROLS[0].text, { label: 'reply' }), /quota surface/);
});
for (const text of [undefined, null, '', ' ', 'a']) test(`empty or short outcome: ${text}`, () => {
  assert.equal(verifyOutcome(text, { label: 'x' }).ok, false);
});
test('semantic oracles reject a plausible but wrong response', () => {
  const verdict = verifyOutcome('Here is a generic answer', { label: 'preview', expect: t => t.includes('canary'), expectDescription: 'this canary' });
  assert.equal(verdict.ok, false); assert.equal(verdict.failure, null);
  assert.match(verdict.reasons[0], /this canary/);
  assert.match(verifyOutcome('hello', { label: 'x', expect: /ok/ }).reasons[0], /\/ok\//);
  assert.equal(assertOutcome('  OK  ', { label: 'x', expect: /ok/i }), 'OK');
  assert.throws(() => assertOutcome('nope', { label: 'x', expect: /yes/, minChars: 10 }), /need at least 10.*expected outcome/);
});
test('global regex oracles and extra patterns are deterministic', () => {
  const expect = /ok/g;
  const extraFailurePatterns = [/custom outage/g];
  for (let n = 0; n < 3; n++) {
    assert.equal(verifyOutcome('ok ok', { label: 'x', expect }).ok, true);
    assert.equal(verifyOutcome('custom outage', { label: 'x', extraFailurePatterns }).ok, false);
  }
  assert.equal(verifyOutcome('BrandApp is asleep', { label: 'x', extraFailurePatterns: [{ id: 'offline', kind: 'unavailable', pattern: 'BrandApp is asleep' }] }).failure.rule, 'offline');
  assert.equal(verifyOutcome('custom outage', { label: 'x', extraFailurePatterns: ['custom outage'] }).ok, false);
});
test('allowKinds excuses only explicitly expected failure kinds', () => {
  const text = "You're out of messages";
  assert.equal(verifyOutcome(text, { label: 'quota', allowKinds: ['quota'], expect: /out of messages/ }).ok, true);
  assert.equal(verifyOutcome('Something went wrong', { label: 'x', allowKinds: ['quota'] }).ok, false);
  assert.equal(verifyOutcome('ok. Something went wrong.', { label: 'x', expect: /ok/ }).ok, false);
});
test('fold strictly requires a nonempty all-passed set', () => {
  assert.equal(foldVerdict(['passed', 'passed']), 'passed');
  assert.equal(foldVerdict([]), 'blocked');
  assert.equal(foldVerdict(['passed', 'failed', 'blocked']), 'failed');
  for (const s of ['skipped', 'blocked', 'pending', 'ok', '', null, undefined, 'error']) assert.equal(foldVerdict(['passed', s]), 'blocked');
});
test('sparse or malformed status collections never fold green', () => {
  assert.equal(foldVerdict(new Array(2)), 'blocked');
  assert.equal(foldVerdict(undefined), 'blocked');
});
