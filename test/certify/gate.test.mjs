import test from 'node:test';
import assert from 'node:assert/strict';
import { buyerReady } from '../../certify/buyer/gate.mjs';
import { calibrate } from '../../certify/buyer/calibrate.mjs';
import { sealReceipt } from '../../certify/buyer/store.mjs';
import { fixture, APPS, gateFixture, NOW, SHA, strong } from './fixtures/support.mjs';

for (const app of APPS) test(`${app.app}: ready is own-walk pay plus calibration, certification and Tim yes`, t => {
  const f = fixture(t, app, { paths: true });
  const input = { ...gateFixture(f.config), cwd: f.cwd };
  assert.equal(buyerReady(input).ready, true);
  const waiting = buyerReady({ ...input, timYes: false });
  assert.equal(waiting.ready, false); assert.equal(waiting.machineReady, true);
  assert.equal(waiting.next, 'ask-tim'); assert.ok(waiting.reasons.includes('tim-approval-required'));
  assert.equal(buyerReady({ ...input, timYes: 'yes' }).ready, false);
});

const mutations = [
  ['no SHA', input => { input.sha = null; }],
  ['no subject', input => { input.subject = null; }],
  ['no certification', input => { input.cert = null; }],
  ['cert blocked', input => { input.cert.allow = false; }],
  ['cert SHA missing', input => { delete input.cert.sourceSha; }],
  ['cert SHA mismatch', input => { input.cert.sourceSha = 'other'; }],
  ['cert app mismatch', input => { input.cert.app = 'other'; }],
  ['cert invalid date', input => { input.cert.judgedAt = 'invalid'; }],
  ['cert future date', input => { input.cert.judgedAt = new Date(NOW + 1).toISOString(); }],
  ['cert stale', input => { input.cert.judgedAt = new Date(NOW - 4 * 86_400_000).toISOString(); }],
  ['missing own walk', input => { input.receipts.pop(); }],
  ['stand-in own walk', input => { input.receipts.at(-1).walkSubject = null; }],
  ['own wrong SHA', input => { input.receipts.at(-1).sha = 'other'; }],
  ['own no strong tier', input => { input.receipts.at(-1).strong = null; }],
  ['own abstain', input => { input.receipts.at(-1).verdict = 'abstain'; }],
  ['own no-pay', input => { input.receipts.at(-1).verdict = 'no_pay'; }],
  ['own stale', input => { input.receipts.at(-1).at = new Date(NOW - 4 * 86_400_000).toISOString(); }],
  ['own future', input => { input.receipts.at(-1).at = new Date(NOW + 1).toISOString(); }],
  ['own invalid time', input => { input.receipts.at(-1).at = 'invalid'; }],
  ['own outdated rubric', input => { input.receipts.at(-1).rubric = 'old'; }],
  ['own NaN p', input => { input.receipts.at(-1).pPay = NaN; }],
  ['own below entry hysteresis', input => { const row = input.receipts.at(-1); row.pPay = 0.62; row.strong = strong(0.62); }],
  ['own low coherent sample', input => { input.receipts.at(-1).strong.sampleP[0].p = 0.49; }],
  ['own incoherent sample', input => { input.receipts.at(-1).strong.sampleP[0].coherent = false; }],
  ['own error sample', input => { input.receipts.at(-1).strong.failures.push('offline'); }],
  ['own vacuous samples', input => { input.receipts.at(-1).strong.sampleP = []; }],
  ['own null sample p', input => { input.receipts.at(-1).strong.sampleP[0].p = null; }],
  ['own inflated median', input => { input.receipts.at(-1).strong.sampleP.forEach(row => { row.p = 0.5; }); }],
  ['own missing coherent count', input => { delete input.receipts.at(-1).strong.coherentSamples; }],
  ['own company-config drift', input => { input.receipts.at(-1).configDigest = 'old'; }],
  ['own receipt app mismatch', input => { input.receipts.at(-1).app = 'other'; }],
  ['missing positive', input => { input.receipts.splice(3, 1); }],
  ['failed positive', input => { input.receipts[3].verdict = 'no_pay'; }],
  ['positive without strong', input => { input.receipts[3].strong = null; }],
  ['positive stale', input => { input.receipts[3].at = new Date(NOW - 4 * 86_400_000).toISOString(); }],
  ['missing holdout', input => { input.receipts.shift(); }],
  ['failed holdout', input => { input.receipts[0].verdict = 'pay'; input.receipts[0].holdoutHolds = true; }],
  ['abstaining holdout', input => { input.receipts[0].verdict = 'abstain'; }],
  ['stale holdout', input => { input.receipts[0].at = new Date(NOW - 4 * 86_400_000).toISOString(); }],
  ['missing control', input => { input.receipts.splice(4, 1); }],
  ['paying control', input => { input.receipts[4].verdict = 'pay'; }],
  ['abstaining control', input => { input.receipts[4].verdict = 'abstain'; }],
  ['control probability missing', input => { input.receipts[4].pPay = null; }],
  ['control stale', input => { input.receipts[4].at = new Date(NOW - 4 * 86_400_000).toISOString(); }],
  ['control wrong SHA', input => { input.receipts[4].sha = 'other'; }],
  ['no receipts', input => { input.receipts = []; }],
];
for (const [name, mutate] of mutations) test(`negative control: ready gate rejects ${name}`, t => {
  const f = fixture(t); const input = { ...gateFixture(f.config), cwd: f.cwd };
  mutate(input); input.receipts = input.receipts.map(sealReceipt);
  const result = buyerReady(input);
  assert.equal(result.ready, false, name); assert.equal(result.machineReady, false, name);
  assert.equal(result.next, 'keep-cooking'); assert.ok(result.reasons.length);
});
test('ready hysteresis preserves a verified ready state at 0.62 but never enters there', t => {
  const f = fixture(t); const input = { ...gateFixture(f.config), cwd: f.cwd };
  const own = input.receipts.pop(); own.pPay = 0.62; own.strong = strong(0.62); input.receipts.push(sealReceipt(own));
  assert.equal(buyerReady(input).ready, false);
  assert.equal(buyerReady({ ...input, wasReady: true }).ready, true);
});
test('receipt integrity is checked by pure gate as well as the file reader', t => {
  const f = fixture(t); const input = { ...gateFixture(f.config), cwd: f.cwd };
  input.receipts.at(-1).pPay = 0.99;
  assert.equal(buyerReady(input).ready, false);
});
test('calibration requires three distinct configured holdouts and a positive', t => {
  const f = fixture(t); const input = { ...gateFixture(f.config), cwd: f.cwd };
  input.config.buyer.calibration.holdouts = [input.config.buyer.calibration.holdouts[0]];
  assert.equal(buyerReady(input).ready, false);
  input.config.buyer.calibration.positiveCanaries = [];
  assert.ok(buyerReady(input).reasons.includes('calibration-no-positive-canary'));
});
for (const spec of APPS) test(`${spec.app}: calibrate executes all holdouts, positives and off-audience controls`, async t => {
  const f = fixture(t, spec); const seen = [];
  const result = await calibrate({ ...f, walk: 'own', sha: SHA, evaluateRun: async args => {
    seen.push(args);
    return { verdict: args.expect === 'pay' ? 'pay' : 'no_pay', pPay: args.expect === 'pay' ? 0.7 : 0.03, holdoutHolds: true, sha: SHA };
  } });
  assert.equal(result.status, 'passed'); assert.equal(seen.length, 5);
  assert.equal(seen.filter(row => row.holdout).length, 4);
  assert.equal(seen.at(-1).persona, 'control');
});
test('calibration fails closed on a seeded false positive, outage, missing positive or control', async t => {
  const f = fixture(t);
  const falsePositive = await calibrate({ ...f, walk: 'own', sha: SHA,
    evaluateRun: async () => ({ verdict: 'pay', pPay: 0.8, holdoutHolds: true, sha: SHA }) });
  assert.equal(falsePositive.status, 'failed');
  const outage = await calibrate({ ...f, evaluateRun: async () => { throw new Error('offline'); } });
  assert.equal(outage.status, 'failed');
  f.config.buyer.calibration.positiveCanaries = [];
  const missing = await calibrate({ ...f, evaluateRun: async () => ({ verdict: 'no_pay', pPay: 0.01, holdoutHolds: true }) });
  assert.equal(missing.status, 'failed');
  f.config.buyer.calibration.holdouts[0].expect = 'pay';
  await assert.rejects(calibrate(f), /invalid calibration/);
});
