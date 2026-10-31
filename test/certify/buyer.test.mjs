import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readOutcome, describeOutcome } from '../../certify/buyer/outcome.mjs';
import { aggregateSamples, parseBuyerSample, buildBuyerPrompt, buildBuyerSchema, readyFlag,
  fileableObjections, holdoutHolds, redact, assertNoIdentity, objectionRecall } from '../../certify/buyer/rubric.mjs';
import { loadPersona, publicPersonaBrief, archetypes } from '../../certify/buyer/personas.mjs';
import { contaminated, judgeBuyer } from '../../certify/buyer/judge.mjs';
import { domConfirms, summarizeScreen, runScreen, SCREEN_QUESTIONS } from '../../certify/buyer/screen.mjs';
import { evaluate, fixProposals } from '../../certify/buyer/run.mjs';
import { readReceipts, stateDir, validReceipt, writeReceipt, sealReceipt } from '../../certify/buyer/store.mjs';
import { signReceipt, digestOf } from '../../certify/judge/receipt.mjs';
import { RUBRIC_VERSION as WALK_RUBRIC } from '../../certify/judge/rubric.mjs';
import { main } from '../../certify/buyer/cli.mjs';
import { APPS, fixture, sample, envelope, fakeIngest, NOW, SHA, gateFixture } from './fixtures/support.mjs';

const STEPS = [{ stepId: '01', title: 'Personal value', tSec: 3.4, text: 'Saved personal result', images: ['/frame.png'] },
  { stepId: '02', title: 'Preview', tSec: 25.3, text: 'your-handle (source: enrichment)', images: ['/second.png'] }];
const parsed = (p = 0.7, extra) => parseBuyerSample(sample(p, extra), STEPS);

for (const app of APPS) {
  test(`${app.app}: live outcome, persona and free alternative come only from config`, t => {
    const f = fixture(t, app);
    const outcome = readOutcome(f);
    assert.equal(outcome.price, app.price);
    assert.equal(outcome.plan, app.plan);
    const prompt = buildBuyerPrompt({ persona: loadPersona({ ...f, ref: 'buyer' }), outcome, steps: STEPS, standIn: true });
    assert.ok(prompt.includes(`${app.price}/month`)); assert.ok(prompt.includes(app.freeAlternative));
    assert.match(prompt, /STAND-IN/); assert.match(prompt, /3\.4s/);
    assert.ok(prompt.indexOf('1. objections') < prompt.indexOf('3. pPay'));
    writeFileSync(join(f.cwd, 'prices.txt'), `price=${app.price + 1}`);
    assert.throws(() => readOutcome(f), /differs/);
    writeFileSync(join(f.cwd, 'prices.txt'), 'cannot parse'); assert.throws(() => readOutcome(f), /unparseable/);
    writeFileSync(join(f.cwd, 'prices.txt'), `price=${app.price} price=${app.price}`); assert.throws(() => readOutcome(f), /ambiguous/);
    delete f.config.paidOutcome.pricePattern;
    writeFileSync(join(f.cwd, 'prices.txt'), `The offer is USD ${app.price} monthly`); assert.equal(readOutcome(f).price, app.price);
    writeFileSync(join(f.cwd, 'prices.txt'), `price=1${app.price}`); assert.throws(() => readOutcome(f), /configured price/);
    f.config.paidOutcome.priceSource = 'missing'; assert.throws(() => readOutcome(f));
  });
  test(`${app.app}: buyer run writes private, hashed receipts and cost, then cleans isolated frames`, async t => {
    const f = fixture(t, app, { paths: true });
    let frameDir;
    const receipt = await evaluate({ ...f, walk: 'unused', persona: 'buyer', now: () => NOW,
      ingest: fakeIngest(f), run: async (_args, cwd) => { frameDir = cwd; return envelope(sample()); } });
    assert.equal(receipt.verdict, 'pay'); assert.equal(receipt.pPay, 0.7);
    assert.equal(receipt.app, app.app); assert.equal(receipt.sha, SHA);
    assert.equal(receipt.walkSubject, 'buyer'); assert.equal(receipt.objections[0].tSec, 3.4);
    assert.ok(validReceipt(receipt)); assert.equal(existsSync(frameDir), false);
    assert.deepEqual(readReceipts(f.state), [receipt]);
    const cost = JSON.parse(readFileSync(join(f.state, 'cost.jsonl'), 'utf8').trim());
    assert.equal(cost.app, app.app); assert.equal(cost.totalUsd, 0.03);
    assert.match(stateDir(f.config), new RegExp(`${app.app}-buyer-eval$`));
    assert.deepEqual(fixProposals(receipt), []);
    const file = join(f.state, 'receipts', `${receipt.id}.json`);
    writeFileSync(file, JSON.stringify({ ...receipt, verdict: 'no_pay' })); assert.deepEqual(readReceipts(f.state), []);
  });
}
test('outcome validates offer fields, finite prices, numeric captures and trial terms', t => {
  const f = fixture(t);
  for (const patch of [{ price: NaN }, { price: -1 }, { plan: '' }, { interval: 'daily' }, { currency: '' }, { freeAlternative: '' }, { trialDays: -1 }]) {
    assert.throws(() => readOutcome({ ...f, config: { ...f.config, paidOutcome: { ...f.config.paidOutcome, ...patch } } }));
  }
  f.config.paidOutcome.pricePattern = '(price)'; assert.throws(() => readOutcome(f), /unparseable/);
  assert.match(describeOutcome({ plan: 'Plan', price: 4, currency: 'EUR', interval: 'year', horizonDays: 30, freeAlternative: 'Paper' }), /EUR 4\/year.*Paper/);
});
test('sample timestamps are machine-sourced; malformed samples fail closed', () => {
  assert.equal(parsed().objections[0].tSec, 3.4);
  for (const raw of [null, sample(NaN), sample(Infinity), sample(-1), sample(1.1), sample(0.1, { pPay3x: NaN }),
    sample(0.1, { objections: [] }), sample(0.1, { objections: [{ text: 'x', stepId: '99', category: 'trust', severity: 'major' }] }),
    sample(0.1, { objections: [{ text: 'x', stepId: '01', category: 'made-up', severity: 'major' }] }),
    sample(0.1, { objections: [{ text: 'x', stepId: '01', category: 'trust', severity: 'unknown' }] }),
    sample(0.1, { valueEvidence: [{ stepId: '99', what: 'x' }] }), sample(0.1, { flipToPay: [{ change: 'x', removesObjection: 5, kind: 'copy' }] }),
    sample(0.1, { valueEvidence: null }), sample(0.1, { flipToPay: null })]) assert.throws(() => parseBuyerSample(raw, STEPS));
  assert.ok(buildBuyerSchema(['01']).properties.pPay);
});
test('blockers cap probability; median, lower bound, spread and coherence govern pay', () => {
  const blocker = parsed(0.9, { objections: [{ text: 'Broken', category: 'defect', stepId: '01', severity: 'blocker' }] });
  assert.equal(blocker.pPay, 0.2); assert.equal(blocker.capped, true);
  assert.equal(aggregateSamples([parsed(0.7), parsed(0.72), parsed(0.68)]).verdict, 'pay');
  for (const values of [[0.7, 0.72, 0.45], [0.8, 0.5, 0.6], [0.4, 0.4, 0.4]]) assert.equal(aggregateSamples(values.map(p => parsed(p))).verdict, 'abstain');
  assert.equal(aggregateSamples([parsed(0.05), parsed(0.1), parsed(0.02)]).verdict, 'no_pay');
  assert.equal(aggregateSamples([]).verdict, 'abstain');
  assert.equal(aggregateSamples([parsed(), parsed(), parsed(0.7, { pPay3x: 0.9 })]).verdict, 'abstain');
  assert.equal(readyFlag({ verdict: 'pay', pPay: 0.62 }), false);
  assert.equal(readyFlag({ verdict: 'pay', pPay: 0.66 }), true);
  assert.equal(readyFlag({ verdict: 'pay', pPay: 0.62 }, true), true);
  assert.equal(readyFlag({ verdict: 'abstain', pPay: 0.9 }), false);
  assert.equal(readyFlag({ verdict: 'pay', pPay: NaN }), false);
  assert.equal(holdoutHolds({ verdict: 'abstain', pPay: 0.01 }), false);
});
test('objection votes count samples, not repeated claims; copy fixes are excluded', () => {
  const repeated = sample(0.1).objections[0];
  const a = parsed(0.1, { objections: [repeated, repeated], flipToPay: [{ change: 'Assert value', removesObjection: 1, kind: 'copy' }] });
  const b = parsed(0.1, { objections: [{ ...repeated, category: 'trust', stepId: '02' }] });
  assert.equal(fileableObjections(aggregateSamples([a, b])).length, 0);
  const result = aggregateSamples([a, a, b]);
  assert.equal(fileableObjections(result).length, 1);
  assert.deepEqual(result.flipToPay, []);
  assert.equal(objectionRecall(result.objections, ['price_vs_value', 'defect']), 0.5);
  assert.equal(objectionRecall([], []), 1);
});
test('private personas require external 0600 files and whitelisted public facts', t => {
  const f = fixture(t); const dir = join(f.root, 'private'); mkdirSync(dir);
  f.config.buyer.privatePersonaDir = dir;
  const path = join(dir, 'subject.json');
  const file = { subjectId: 'hashed-subject', facts: { publicRole: 'Independent professional', currentTools: ['Spreadsheet'] }, identityTokens: ['Example Person'] };
  writeFileSync(path, JSON.stringify(file), { mode: 0o600 });
  assert.equal(loadPersona({ ...f, ref: 'subject' }).tier, 'B');
  chmodSync(path, 0o644); assert.throws(() => loadPersona({ ...f, ref: 'subject' }), /0600/);
  chmodSync(path, 0o600);
  writeFileSync(path, JSON.stringify({ ...file, facts: { email: 'canary@example.test' } })); assert.throws(() => loadPersona({ ...f, ref: 'subject' }), /not allowed/);
  assert.throws(() => publicPersonaBrief({ diagnosis: 'private' }), /not allowed/);
  assert.throws(() => publicPersonaBrief({ publicRole: 'canary@example.test' }), /email/);
  assert.throws(() => publicPersonaBrief({ publicRole: {} }), /invalid/);
  f.config.buyer.privatePersonaDir = f.cwd; assert.throws(() => loadPersona({ ...f, ref: 'subject' }), /outside/);
  f.config.buyer.privatePersonaDir = 'relative'; assert.throws(() => loadPersona({ ...f, ref: 'subject' }), /absolute/);
  assert.ok(archetypes(f).some(row => row.control));
  f.config.buyer.personas.push(f.config.buyer.personas[0]); assert.throws(() => archetypes(f), /invalid/);
});
test('identity redaction is case-insensitive and surviving tokens block persistence', () => {
  const tokens = ['Example Person', 'example-handle'];
  const text = redact('EXAMPLE PERSON /example-handle canary@example.test', tokens);
  assert.doesNotMatch(text, /EXAMPLE|example-handle|@example/);
  assert.doesNotThrow(() => assertNoIdentity(text, tokens));
  assert.throws(() => assertNoIdentity('Example Person', tokens), /write blocked/);
  assert.throws(() => assertNoIdentity('canary@example.test'), /write blocked/);
});
test('screen requires DOM confirmation and never promotes missing answers or outages', async () => {
  const answers = { '01': { placeholder_or_jargon: { noul: 0.9 } }, '02': { placeholder_or_jargon: { noul: 0.9 } } };
  assert.deepEqual(summarizeScreen(STEPS, answers).blockers.map(row => row.stepId), ['02']);
  assert.equal(summarizeScreen([], {}).complete, false);
  assert.equal(summarizeScreen(STEPS, answers).complete, false);
  for (const [kind, bad, good] of [
    ['placeholder_or_jargon', 'undefined', 'Personal result'], ['error_or_dead_end', 'Something went wrong', 'No errors found'],
    ['paid_ask_while_waitlisted', "You're on the list. Subscribe (EUR 10)", 'Subscribe (EUR 10)'],
  ]) { assert.equal(domConfirms(kind, bad), true); assert.equal(domConfirms(kind, good), false); }
  assert.equal(domConfirms('unknown', ''), false);
  assert.equal((await runScreen(STEPS)).status, 'not-configured');
  assert.equal((await runScreen(STEPS, { call: async () => { throw new Error('offline'); } })).status, 'provider-error');
  const complete = await runScreen(STEPS, { call: async () => ({ usd: 0.001, answers: Object.fromEntries(Object.keys(SCREEN_QUESTIONS).map(key => [key, { noul: 0.1 }])) }) });
  assert.equal(complete.complete, true); assert.equal(complete.usd, 0.002);
});
test('contamination defaults, custom markers, word boundaries and prompt exemptions', () => {
  assert.deepEqual(contaminated({ note: 'premium pricing at $300 per month' }, 'prompt'), ['$300', 'premium pricing']);
  assert.deepEqual(contaminated({ note: 'summer tour' }, 'prompt'), ['summer']);
  assert.deepEqual(contaminated('participate', 'prompt'), []);
  assert.deepEqual(contaminated('Summer', 'Summer'), []);
  assert.deepEqual(contaminated('internal-secret-marker', 'prompt', { buyer: { contaminationMarkers: ['internal-secret-marker'] } }), ['internal-secret-marker']);
});
for (const [label, run] of [
  ['outage', async () => { throw new Error('offline'); }], ['invalid', async () => 'not-json'],
  ['contamination', async () => envelope(sample(0.7, { flipToPay: [{ change: 'gbrain approves', removesObjection: 1, kind: 'proof' }] }))],
]) test(`negative control: buyer ${label} abstains and logs cost`, async t => {
  const f = fixture(t);
  const result = await evaluate({ ...f, walk: 'unused', persona: 'buyer', ingest: fakeIngest(f), run });
  assert.equal(result.verdict, 'abstain'); assert.ok(readFileSync(join(f.state, 'cost.jsonl')).length);
});
test('one failed sample, failed recording and SHA/app mismatch cannot produce pay', async t => {
  const f = fixture(t); let n = 0;
  const result = await evaluate({ ...f, walk: 'unused', persona: 'buyer', ingest: fakeIngest(f),
    run: async () => { if (++n === 1) throw new Error('offline'); return envelope(sample()); } });
  assert.equal(result.verdict, 'abstain');
  const failed = await evaluate({ ...f, walk: 'unused', persona: 'buyer', ingest: fakeIngest({ ...f, status: 'failed' }), run: async () => envelope(sample()) });
  assert.equal(failed.verdict, 'abstain');
  await assert.rejects(evaluate({ ...f, walk: 'unused', persona: 'buyer', sha: 'wrong', ingest: fakeIngest(f) }), /SHA/);
  await assert.rejects(evaluate({ ...f, walk: 'unused', persona: 'buyer', ingest: fakeIngest({ config: { app: 'other' } }) }), /another app/);
  await assert.rejects(judgeBuyer({ persona: {}, walk: {}, samples: 0 }), /samples/);
});
test('confirmed screen blockers skip strong tier and yield no-pay; screen outage runs strong', async t => {
  const f = fixture(t); let calls = 0;
  const result = await evaluate({ ...f, walk: 'unused', persona: 'buyer', holdout: true,
    ingest: fakeIngest({ ...f, text: 'Something went wrong' }),
    screenCall: async () => ({ usd: 0.001, answers: { error_or_dead_end: { noul: 0.9 } } }),
    run: async () => { calls++; return envelope(sample()); } });
  assert.equal(result.verdict, 'no_pay'); assert.equal(result.holdoutHolds, true); assert.equal(calls, 0);
  const strong = await evaluate({ ...f, walk: 'unused', persona: 'buyer', ingest: fakeIngest(f),
    screenCall: async () => { throw new Error('offline'); }, run: async () => envelope(sample()) });
  assert.equal(strong.verdict, 'pay');
});
test('state rejects repo paths, invalid identifiers and permissive/tampered receipt files', async t => {
  const f = fixture(t);
  assert.throws(() => stateDir({ app: '../escape' }), /invalid/);
  const result = await evaluate({ ...f, walk: 'unused', persona: 'buyer', ingest: fakeIngest(f), run: async () => envelope(sample(0.1)) });
  assert.equal(fixProposals(result).length, 1);
  assert.equal(fixProposals({ ...result, persona: { control: true } }).length, 0);
  assert.throws(() => writeReceipt(result, { ...f, state: join(f.cwd, 'private') }), /outside/);
  const path = join(f.state, 'receipts', `${result.id}.json`); chmodSync(path, 0o644);
  assert.deepEqual(readReceipts(f.state), []);
  assert.equal(validReceipt(null), false); assert.deepEqual(readReceipts(join(f.root, 'absent')), []);
});
test('buyer CLI runs and calibrates with config, rejects missing inputs', async t => {
  const f = fixture(t);
  const args = ['--app-config', 'certification/app.json'];
  let called = false;
  assert.equal(await main(['run', ...args, '--walk', 'walk', '--persona', 'buyer'], { cwd: f.cwd,
    evaluateRun: async input => { called = true; assert.equal(input.config.app, f.config.app); return { verdict: 'pay', persona: {}, objections: [] }; } }), 0);
  assert.ok(called);
  assert.equal(await main(['calibrate', ...args], { cwd: f.cwd, calibrateRun: async () => ({ status: 'failed', checks: [] }) }), 1);
  for (const args of [[], ['run'], ['run', '--app-config', 'missing'], ['run', '--app-config', 'certification/app.json'], ['gate', '--app-config', 'certification/app.json']]) await assert.rejects(main(args, { cwd: f.cwd }));
});
test('buyer CLI gate verifies a signed judgement and stored own-walk evidence before asking Tim', async t => {
  const f = fixture(t);
  const previousHome = process.env.HOME, previousKey = process.env.CERT_JUDGE_SIGNING_KEY;
  process.env.HOME = f.root; process.env.CERT_JUDGE_SIGNING_KEY = 'fixture-key';
  try {
    const at = new Date(Date.now() - 1000).toISOString();
    for (const row of gateFixture(f.config).receipts) writeReceipt(sealReceipt({ ...row, at }), { ...f, state: stateDir(f.config) });
    const judgement = signReceipt({ schema: 'company.walk-judgement/v1', app: f.config.app, sourceSha: SHA,
      judgedAt: at, walkId: 'fixture-walk', surface: 'web', model: 'claude-opus-5-5', rubricVersion: WALK_RUBRIC,
      configDigest: digestOf(f.config), verdict: 'pass',
      stages: f.config.goldenPath.stages.map(stage => ({ stageId: stage.id, verdict: 'pass' })),
      steps: f.config.goldenPath.stages.map(stage => ({ stageId: stage.id, verdict: 'pass' })),
    }, 'fixture-key');
    const path = join(f.root, 'judgement.json'); writeFileSync(path, JSON.stringify(judgement));
    const args = ['gate', '--app-config', 'certification/app.json', '--subject', 'buyer', '--sha', SHA, '--cert', path];
    assert.equal(await main(args, { cwd: f.cwd }), 1);
    assert.equal(await main([...args, '--tim-yes'], { cwd: f.cwd }), 0);
    writeFileSync(path, JSON.stringify({ ...judgement, sourceSha: 'wrong' }));
    assert.equal(await main([...args, '--tim-yes'], { cwd: f.cwd }), 1);
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousKey === undefined) delete process.env.CERT_JUDGE_SIGNING_KEY; else process.env.CERT_JUDGE_SIGNING_KEY = previousKey;
  }
});
