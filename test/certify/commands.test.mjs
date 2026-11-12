import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { appConfig, receiptInput } from './fixtures/app.mjs';
import { runCommand } from '../../certify/commands.mjs';
import { cleanControlSnapshot, CONTROL_REGISTRY } from '../../certify/privacy/privacy-rules.mjs';
import { verifyReceipt } from '../../certify/receipt.mjs';

function app(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'certkit-cli-')); t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const config = appConfig();
  const write = (file, data) => writeFileSync(join(cwd, file), JSON.stringify(data));
  write('app.json', config); write('registry.json', CONTROL_REGISTRY);
  for (const file of ['flow.mjs', 'prices.json', 'personas.json']) write(file, {});
  write('calibration.json', config.calibration);
  return { config, cwd, write, read: name => JSON.parse(readFileSync(join(cwd, name), 'utf8')) };
}
test('receipt CLI assembles JSON; publish signs and sends only the signed result to publisher', async t => {
  const a = app(t); const input = receiptInput(a.config);
  for (const kind of ['walk', 'buyer', 'privacy']) a.write(`${kind}.json`, input[kind]);
  assert.equal(await runCommand('receipt', ['--config', 'app.json', '--walk', 'walk.json', '--buyer', 'buyer.json', '--privacy', 'privacy.json', '--out', 'receipt.json'], { cwd: a.cwd }), 0);
  assert.equal(a.read('receipt.json').verdict, 'blocked');
  const env = { CERT_RECEIPT_SIGNING_KEY: 'synthetic-test-key', GITHUB_TOKEN: 'test-token', GITHUB_REPOSITORY: 'example/app' };
  const calls = [];
  const opts = { cwd: a.cwd, env, publishFn: async (receipt, options) => { calls.push({ receipt, options }); return { deployment: { id: 1 } }; } };
  assert.equal(await runCommand('publish', ['--config', 'app.json', '--receipt', 'receipt.json', '--out', 'published.json'], opts), 0);
  assert.equal(verifyReceipt(calls[0].receipt, { key: env.CERT_RECEIPT_SIGNING_KEY }), true);
  assert.equal(calls[0].options.repo, env.GITHUB_REPOSITORY);
  // The app calibration FILE is authoritative over an in-memory default.
  a.write('calibration.json', { positiveCanaries: ['positive'] });
  assert.equal(await runCommand('publish', ['--config', 'app.json', '--receipt', 'receipt.json'], opts), 1);
  assert.equal(calls[1].receipt.verdict, 'blocked');
});
test('privacy CLI writes evidence and markdown, failing closed on incomplete coverage', async t => {
  const a = app(t); const s = cleanControlSnapshot(); s.app = a.config.app;
  s.registry_sha256 = createHash('sha256').update(JSON.stringify(CONTROL_REGISTRY)).digest('hex');
  const args = ['--config', 'app.json', '--out', 'privacy.json', '--markdown', 'privacy.md'];
  let crawled = false;
  assert.equal(await runCommand('privacy', args, { cwd: a.cwd, crawlFn: async options => { crawled = true; assert.equal(options.config.app, a.config.app); return s; } }), 1);
  assert.equal(crawled, true); assert.equal(a.read('privacy.json').pass, false);
  assert.match(readFileSync(join(a.cwd, 'privacy.md'), 'utf8'), /blocked/);
  for (const p of s.pages) p.url = a.config.privacy.crawl[0].url;
  s.policy_versions['p-privacy'].url = a.config.privacy.policyUrl;
  assert.equal(await runCommand('privacy', args, { cwd: a.cwd, crawlFn: async () => s }), 0);
});
test('CLI missing inputs, invalid config and unknown commands fail before side effects', async t => {
  const a = app(t);
  for (const [command, args] of [['privacy', []], ['privacy', ['--config']], ['privacy', ['--config', 'missing.json']],
    ['privacy', ['--config', 'app.json']], ['receipt', ['--config', 'app.json']], ['unknown', ['--config', 'app.json']]]) {
    await assert.rejects(runCommand(command, args, { cwd: a.cwd, crawlFn: () => assert.fail('unexpected crawl') }));
  }
  a.write('app.json', {});
  await assert.rejects(runCommand('receipt', ['--config', 'app.json'], { cwd: a.cwd }), /schema/);
  const cli = fileURLToPath(new URL('../../certify/cli.mjs', import.meta.url));
  assert.equal(spawnSync(process.execPath, [cli, 'privacy'], { cwd: a.cwd }).status, 1);
  assert.equal(spawnSync(process.execPath, [cli, 'unknown'], { cwd: a.cwd }).status, 2);
  assert.equal(spawnSync(process.execPath, [cli, 'validate'], { cwd: a.cwd }).status, 1);
});
