import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, symlinkSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runWalk } from '../../certify/walk/walk.mjs';
import { ingestWalk, probeDuration, extractFrame, withWindows } from '../../certify/buyer/ingest.mjs';
import { appFile, readWalk, requiredStages } from '../../certify/judge/artifacts.mjs';
import { judgeWalk } from '../../certify/judge/judge.mjs';
import { buildClaudeArgs, parseEnvelope, runClaude } from '../../certify/judge/model.mjs';
import { signReceipt, verifyReceiptSignature, gateDecision, digestOf } from '../../certify/judge/receipt.mjs';
import { parseJudgeOutput, runVerdict, CRITERIA } from '../../certify/judge/rubric.mjs';
import { fixture, APPS, ENV, SHA, NOW, mockPlaywright, media, detectFailureSurface, envelope } from './fixtures/support.mjs';

const ingest = source => ingestWalk(source, media);
async function recorded(t, app) {
  const f = fixture(t, app);
  await runWalk({ ...f, baseUrl: 'https://example.test', env: ENV, playwright: mockPlaywright(), now: () => NOW, sourceSha: SHA });
  return f;
}
for (const spec of APPS) test(`${spec.app}: every frame is isolated, judged against its oracle and signed`, async t => {
  const f = await recorded(t, spec);
  let calls = 0, isolated;
  const receipt = await judgeWalk({ runDir: f.outDir, config: f.config, ingest, failureDetector: detectFailureSurface, now: () => NOW,
    run: async (args, cwd) => {
      calls++; isolated = cwd;
      assert.notEqual(cwd, f.cwd); assert.notEqual(cwd, f.outDir);
      assert.ok(readdirSync(cwd).every(name => /\.(png|jpg)$/.test(name)));
      assert.ok(args.includes('--strict-mcp-config') && args.includes('--no-session-persistence'));
      assert.equal(args[args.indexOf('--setting-sources') + 1], '');
      assert.equal(args[args.indexOf('--tools') + 1], 'Read');
      assert.match(args[1], /semantic oracle/);
      return envelope({ verdict: 'pass', reasons: ['Personal outcome is visible'] });
    } });
  assert.equal(receipt.verdict, 'pass');
  assert.equal(calls, 10);
  assert.equal(existsSync(isolated), false);
  assert.equal(receipt.stages.length, 5);
  const signed = signReceipt(receipt, 'fixture-key');
  assert.equal(verifyReceiptSignature(signed, 'fixture-key'), true);
  assert.equal(gateDecision({ receipt: signed, config: f.config, sourceSha: SHA, signingKey: 'fixture-key', now: NOW }).allow, true);
  assert.equal(verifyReceiptSignature({ ...signed, app: 'other' }, 'fixture-key'), false);
});
for (const text of ['Something went wrong', 'Weekly message limit reached', 'Coming soon', 'Lorem ipsum', '']) {
  test(`negative control: DOM failure overrides model pass (${text || 'empty'})`, async t => {
    const f = await recorded(t);
    writeFileSync(join(f.outDir, 'dom/01.txt'), text);
    let calls = 0;
    const result = await judgeWalk({ runDir: f.outDir, config: f.config, ingest, failureDetector: detectFailureSurface,
      run: async () => { calls++; return envelope({ verdict: 'pass', reasons: ['looks good'] }); } });
    assert.equal(result.verdict, 'fail');
    assert.equal(result.stages[0].verdict, 'fail');
    assert.equal(calls, 8);
  });
}
for (const [name, run] of [
  ['outage', async () => { throw new Error('offline'); }],
  ['malformed output', async () => envelope({})],
  ['abstention', async () => envelope({ verdict: 'abstain', reasons: ['unclear'] })],
  ['missing reasons', async () => envelope({ verdict: 'pass', reasons: [] })],
  ['contamination', async () => envelope({ verdict: 'pass', reasons: ['gbrain says yes'] })],
]) test(`negative control: frame ${name} cannot pass`, async t => {
  const f = await recorded(t);
  const result = await judgeWalk({ runDir: f.outDir, config: f.config, ingest, failureDetector: detectFailureSurface, run });
  assert.equal(result.verdict, 'abstain');
});
test('negative control: unknown stage, omitted stage and failed recorder stay failed', async t => {
  const f = await recorded(t);
  const rows = JSON.parse(readFileSync(join(f.outDir, 'steps.json')));
  rows[0].stageId = 'unregistered';
  writeFileSync(join(f.outDir, 'steps.json'), JSON.stringify(rows));
  const result = await judgeWalk({ runDir: f.outDir, config: f.config, ingest, failureDetector: detectFailureSurface,
    run: async () => envelope({ verdict: 'pass', reasons: ['Visible'] }) });
  assert.equal(result.verdict, 'fail');
  assert.ok(result.stages[0].reasons.includes('required stage was not recorded'));
});
test('strict rubric refuses vacuous and malformed results', () => {
  assert.equal(CRITERIA.length, 4);
  assert.equal(runVerdict([]), 'abstain');
  for (const verdict of ['skipped', 'blocked', 'missing', undefined, 'abstain']) assert.notEqual(runVerdict([{ verdict }]), 'pass');
  assert.equal(runVerdict([{ verdict: 'pass' }, { verdict: 'fail' }]), 'fail');
  assert.throws(() => parseJudgeOutput(null), /missing/);
  assert.throws(() => parseJudgeOutput({ verdict: 'pass', reasons: [''] }), /missing/);
});
test('signed gate rejects tampering, missing SHA, staleness, changed config/model and vacuous checks', async t => {
  const f = await recorded(t);
  const receipt = await judgeWalk({ runDir: f.outDir, config: f.config, ingest, failureDetector: detectFailureSurface, now: () => NOW,
    run: async () => envelope({ verdict: 'pass', reasons: ['Visible'] }) });
  const check = (body, overrides = {}) => gateDecision({ receipt: signReceipt(body, 'key'), config: f.config, sourceSha: SHA, signingKey: 'key', now: NOW, ...overrides });
  assert.equal(check(receipt).allow, true);
  for (const patch of [{ sourceSha: null }, { sourceSha: 'b'.repeat(40) }, { verdict: 'fail' }, { app: 'other' },
    { stages: [] }, { steps: [] }, { rubricVersion: 'old' }, { model: 'weak' }, { configDigest: 'old' },
    { judgedAt: 'invalid' }, { judgedAt: new Date(NOW + 1).toISOString() }, { walkId: null },
    { stages: receipt.stages.map((row, i) => i === 0 ? { ...row, verdict: 'skipped' } : row) }]) {
    assert.equal(check({ ...receipt, ...patch }).allow, false, JSON.stringify(patch));
  }
  assert.equal(check(receipt, { now: NOW + 4 * 86_400_000 }).allow, false);
  assert.equal(check(receipt, { sourceSha: null }).allow, false);
  assert.equal(check(receipt, { signingKey: 'wrong' }).allow, false);
  assert.equal(check(receipt, { config: { ...f.config, app: 'other' } }).allow, false);
  assert.equal(gateDecision({ receipt: null, config: f.config }).allow, false);
  assert.equal(verifyReceiptSignature(signReceipt(receipt), 'key'), false);
  assert.equal(verifyReceiptSignature(null, 'key'), false);
  const signed = signReceipt(receipt, 'key'); signed.signature.value = 'x';
  assert.equal(verifyReceiptSignature(signed, 'key'), false);
  assert.equal(digestOf({ b: { y: 2, x: 1 }, a: [1] }), digestOf({ a: [1], b: { x: 1, y: 2 } }));
});
test('ingest copies screenshots and midpoint frames; missing media or DOM fails closed', async t => {
  const f = await recorded(t);
  const walk = ingest(f.outDir);
  assert.equal(walk.steps.length, 5);
  assert.equal(walk.steps[0].images.length, 2);
  rmSync(walk.frameDir, { recursive: true });
  assert.throws(() => ingestWalk(f.outDir, { ...media, extract: () => false }), /extraction failed/);
  rmSync(join(f.outDir, 'dom/01.txt'));
  assert.throws(() => ingest(f.outDir), /ENOENT/);
});
test('artifact paths reject traversal, absolute references and symlink escapes', t => {
  const f = fixture(t);
  const outside = join(f.root, 'secret.txt'); writeFileSync(outside, 'private');
  symlinkSync(outside, join(f.cwd, 'link.txt'));
  for (const path of ['../secret.txt', outside, 'link.txt', '.', undefined]) assert.throws(() => appFile(f.cwd, path));
  assert.throws(() => requiredStages({ goldenPath: { stages: [] } }, 'web'));
  assert.throws(() => requiredStages({ goldenPath: { stages: [{ id: 'x' }] } }, 'web'));
  assert.throws(() => requiredStages({ goldenPath: { stages: [{ id: 'x', oracle: 'a' }, { id: 'x', oracle: 'b' }] } }, 'web'));
});
test('negative control: malformed provenance/timestamps/frames never ingest', async t => {
  const f = await recorded(t);
  const original = JSON.parse(readFileSync(join(f.outDir, 'steps.json')));
  for (const patch of [{ step: '../01' }, { walkId: 'foreign' }, { tStartMs: null }, { tEndMs: 0 }, { videoOffsetSec: -1 }, { screenshot: '../secret.png' }, { status: 'skipped' }]) {
    writeFileSync(join(f.outDir, 'steps.json'), JSON.stringify([{ ...original[0], ...patch }]));
    assert.throws(() => readWalk(f.outDir));
  }
  writeFileSync(join(f.outDir, 'steps.json'), '[]'); assert.throws(() => readWalk(f.outDir), /no steps/);
});
test('bare video sampling and external media failures remain fail closed', t => {
  const f = fixture(t); const video = join(f.root, 'input.webm'); writeFileSync(video, 'fake');
  assert.equal(probeDuration(video), null); assert.equal(extractFrame(video, 0, join(f.root, 'bad.png')), false);
  assert.throws(() => ingestWalk(video, { probe: () => null }), /duration/);
  const walk = ingestWalk(video, media); assert.equal(walk.steps.length, 2); rmSync(walk.frameDir, { recursive: true });
  assert.equal(withWindows([{ tSec: 1 }, { tSec: 3 }], 5)[0].endSec, 3);
  assert.throws(() => ingestWalk(join(f.root, 'x.txt')), /not a walk/);
});
test('model envelope and transport cannot turn errors into success', async t => {
  const f = fixture(t);
  for (const value of ['not-json', '{}', '{"is_error":true}', { structured_output: {}, total_cost_usd: -1 }]) assert.throws(() => parseEnvelope(value));
  const args = buildClaudeArgs({ prompt: 'x', schema: {}, imageDir: f.cwd });
  assert.equal(args[args.indexOf('--mcp-config') + 1], '{"mcpServers":{}}');
  // The installed CLI may exist; an impossible executable path guarantees an ENOENT control.
  const previous = process.env.PATH; process.env.PATH = f.cwd;
  try { await assert.rejects(runClaude([], f.cwd, 100), /unavailable/); } finally { process.env.PATH = previous; }
});
test('model transport proves nonzero exit, timeout, output bound and success without a provider', async t => {
  const f = fixture(t);
  const binary = join(f.root, 'claude');
  const previous = process.env.PATH; process.env.PATH = f.root;
  const install = body => writeFileSync(binary, `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
  try {
    install("process.stdout.write('fixture-result')");
    assert.equal(await runClaude([], f.cwd, 5000), 'fixture-result');
    install('process.exit(2)'); await assert.rejects(runClaude([], f.cwd, 5000), /exited 2/);
    install('setInterval(() => {}, 1000)'); await assert.rejects(runClaude([], f.cwd, 100), /timeout/);
    install("process.stdout.write('x'.repeat(4_000_001)); setInterval(() => {}, 1000)");
    await assert.rejects(runClaude([], f.cwd, 5000), /output limit/);
  } finally { process.env.PATH = previous; }
});
