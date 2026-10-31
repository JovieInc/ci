import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appConfig, receiptInput } from './fixtures/app.mjs';
import { buildReceipt, signReceipt, verifyReceipt, publishReceipt, receiptDigest } from '../../certify/receipt.mjs';
const key = 'synthetic-receipt-test-key';
function setup() { const config = appConfig(); return { config, input: receiptInput(config) }; }
function signed(config, input) { return signReceipt(buildReceipt(config, input), { config, key }); }

test('unsigned receipt is blocked; signed full evidence certifies without buyer pay before a positive canary', () => {
  const { config, input } = setup(); const draft = buildReceipt(config, input);
  assert.equal(draft.verdict, 'blocked'); assert.equal(verifyReceipt(draft, { key }), false);
  const receipt = signReceipt(draft, { config, key });
  assert.equal(receipt.verdict, 'certified'); assert.equal(verifyReceipt(receipt, { key, config }), true);
  assert.equal(receipt.buyer.verdicts[0].objections[0], 'insufficient value');
  assert.equal(receipt.privacy.digest, receiptDigest(input.privacy));
  assert.equal(draft.signature, undefined);
});
const violations = {
  'missing stage': i => i.walk.stages.pop(),
  'zero stages': i => { i.walk.stages = []; },
  'duplicate stage': i => { i.walk.stages[1] = i.walk.stages[0]; },
  'wrong stage kind': i => { i.walk.stages[0].kind = 'wrong'; },
  'missing verdict': i => { delete i.walk.stages[0].verdict; },
  'skipped stage': i => { i.walk.stages[0].verdict = 'skipped'; },
  'failed stage': i => { i.walk.stages[0].verdict = 'failed'; },
  'blocked stage': i => { i.walk.stages[0].verdict = 'blocked'; },
  'error stage': i => { i.walk.stages[0].verdict = 'error'; },
  'missing evidence': i => { i.walk.stages[0].evidence = {}; },
  'reversed stage time': i => { i.walk.stages[0].tEndMs = -1; },
  'missing stage time': i => { delete i.walk.stages[0].tStartMs; },
  'missing SHA': i => { delete i.walk.sha; },
  'missing run id': i => { delete i.walk.runId; },
  'bad timestamps': i => { i.walk.finishedAt = '2000-01-01'; },
  'privacy failed': i => { i.privacy.pass = false; },
  'privacy wrong app': i => { i.privacy.app = 'other'; },
  'privacy missing results': i => { i.privacy.results = []; },
  'privacy warning': i => { i.privacy.results[0].status = 'warn'; },
  'privacy missing controls': i => { i.privacy.controls = []; },
  'privacy broken control': i => { i.privacy.controls[0].ok = false; },
  'too few holdouts': i => { i.buyer.calibration.holdoutsNoPay = 2; },
  'missing off-ICP control': i => { delete i.buyer.calibration.controlNoPay; },
  'off-ICP control says pay': i => { i.buyer.calibration.controlNoPay = false; },
  'missing buyer verdict': i => { i.buyer.verdicts = [{}]; },
  'errored buyer evaluation': i => { i.buyer.verdicts = [{ verdict: 'error' }]; },
  'no buyer verdicts': i => { i.buyer.verdicts = []; },
  'missing voice channel': i => { i.walk.voice.channelsCovered.pop(); },
};
for (const [name, mutate] of Object.entries(violations)) test(`certification blocks ${name}`, () => {
  const { config, input } = setup(); mutate(input);
  const r = signed(config, input); assert.equal(r.verdict, 'blocked'); assert.equal(verifyReceipt(r, { key }), true);
});
test('configured positive canaries require a successful positive control and ready buyer gate', () => {
  const { config, input } = setup(); config.calibration.positiveCanaries = ['known-good'];
  assert.equal(signed(config, input).verdict, 'blocked');
  input.buyer.calibration.positiveCanary = true;
  assert.equal(signed(config, input).verdict, 'blocked');
  input.buyer.gate = 'ready'; assert.equal(signed(config, input).verdict, 'blocked');
  input.buyer.verdicts[0].verdict = 'pay'; assert.equal(signed(config, input).verdict, 'certified');
});
test('missing config stages, channels, waste and capacity never certify', () => {
  for (const mutate of [c => { c.goldenPath.stages = []; }, c => { c.customerVoice.channels = []; },
    c => { c.waste = {}; }, c => { c.capacity = {}; }]) {
    const { config, input } = setup(); mutate(config); assert.equal(signed(config, input).verdict, 'blocked');
  }
});
test('signing requires a key and config; signing re-evaluates a forged verdict', () => {
  const { config, input } = setup(); const draft = buildReceipt(config, input);
  assert.throws(() => signReceipt(draft, { config, key: '' }), /SIGNING_KEY/);
  assert.throws(() => signReceipt(draft, { key }), /config/);
  draft.stages = []; draft.verdict = 'certified'; draft.checks = [{ status: 'passed' }];
  assert.equal(signReceipt(draft, { config, key }).verdict, 'blocked');
});
test('tampering, wrong keys, malformed signatures and unsigned certified claims are rejected', () => {
  const { config, input } = setup(); const receipt = signed(config, input);
  assert.equal(verifyReceipt(receipt, { key: 'wrong' }), false);
  assert.equal(verifyReceipt({ ...receipt, sha: 'b'.repeat(40) }, { key }), false);
  assert.equal(verifyReceipt({ ...receipt, signature: undefined }, { key }), false);
  assert.equal(verifyReceipt({ ...receipt, signature: { algorithm: 'hmac-sha256', value: 'a' } }, { key }), false);
  config.customerVoice.channels.push({ id: 'new' }); assert.equal(verifyReceipt(receipt, { key, config }), false);
  assert.equal(receiptDigest({ b: 2, a: 1 }), receiptDigest({ a: 1, b: 2 }));
});
for (const certified of [true, false]) test(`publish uses certification deployment and ${certified ? 'success' : 'failure'} status`, async () => {
  const { config, input } = setup(); if (!certified) input.walk.stages = [];
  const receipt = signed(config, input); const calls = [];
  const result = await publishReceipt(receipt, { repo: 'example/app', token: 'test-token', key,
    fetchImpl: async (url, init) => { calls.push({ url, ...init, body: JSON.parse(init.body) }); return { ok: true, json: async () => ({ id: 42 }) }; } });
  assert.equal(result.deployment.id, 42); assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://api.github.com/repos/example/app/deployments');
  assert.equal(calls[0].body.ref, receipt.sha); assert.equal(calls[0].body.environment, 'certification');
  assert.equal(calls[0].body.auto_merge, false); assert.deepEqual(calls[0].body.required_contexts, []);
  assert.equal(calls[0].body.payload.digest, receiptDigest(receipt));
  assert.equal(calls[1].url.endsWith('/42/statuses'), true);
  assert.equal(calls[1].body.state, certified ? 'success' : 'failure');
  assert.ok(calls[1].body.description.length <= 140);
});
test('publish rejects missing authority, unsigned receipts, HTTP failure and missing deployment id', async () => {
  const { config, input } = setup(); const r = signed(config, input);
  const opts = { repo: 'example/app', token: 'test-token', key, fetchImpl: () => { assert.fail('must not call'); } };
  for (const patch of [{ repo: '../bad' }, { token: '' }, { key: '' }]) await assert.rejects(publishReceipt(r, { ...opts, ...patch }));
  await assert.rejects(publishReceipt(buildReceipt(config, input), opts), /signed/);
  await assert.rejects(publishReceipt(r, { ...opts, fetchImpl: async () => ({ ok: false, status: 403 }) }), /403/);
  await assert.rejects(publishReceipt(r, { ...opts, fetchImpl: async () => ({ ok: true, json: async () => ({}) }) }), /id missing/);
  let n = 0;
  await assert.rejects(publishReceipt(r, { ...opts, fetchImpl: async () => ++n === 1 ? { ok: true, json: async () => ({ id: 42 }) } : { ok: false, status: 503 } }), /503/);
});

test('signing loads the app calibration file and fails closed on a missing file', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'certkit-calibration-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const { config, input } = setup(); delete config.calibration;
  const draft = buildReceipt(config, input);
  assert.throws(() => signReceipt(draft, { config, key, cwd }), /ENOENT/);
  writeFileSync(join(cwd, config.buyer.calibration), JSON.stringify({ positiveCanaries: ['known-good'] }));
  assert.equal(signReceipt(draft, { config, key, cwd }).verdict, 'blocked');
  for (const invalid of [[], null, 'invalid', 12]) {
    writeFileSync(join(cwd, config.buyer.calibration), JSON.stringify(invalid));
    assert.equal(signReceipt(draft, { config, key, cwd }).verdict, 'blocked');
  }
});
