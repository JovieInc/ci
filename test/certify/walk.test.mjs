import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { runWalk, resolveAccount, loadPlaywright } from '../../certify/walk/walk.mjs';
import { main } from '../../certify/walk/cli.mjs';
import { validateConfig } from '../../certify/config.mjs';
import { APPS, ENV, SHA, fixture, mockPlaywright, writeFlow } from './fixtures/support.mjs';

for (const app of APPS) {
  test(`${app.app}: recorder writes every stage, clock and run-contract artifact`, async t => {
    const f = fixture(t, app);
    const pw = mockPlaywright();
    let clock = 1000;
    const result = await runWalk({ ...f, baseUrl: 'https://example.test', env: ENV, playwright: pw, now: () => clock++, sourceSha: SHA });
    assert.equal(result.status, 'passed');
    assert.equal(result.sourceSha, SHA);
    assert.ok(pw.flags.browserClosed && pw.flags.contextClosed);
    const rows = JSON.parse(readFileSync(join(f.outDir, 'steps.json')));
    assert.equal(rows.length, 5);
    for (const row of rows) {
      assert.equal(row.walkId, result.walkId);
      assert.ok(row.tEndMs >= row.tStartMs && row.tStartMs >= result.tStartMs);
      assert.ok(existsSync(join(f.outDir, row.screenshot)));
      assert.ok(existsSync(join(f.outDir, 'dom', `${row.step}.txt`)));
    }
    assert.ok(readFileSync(join(f.outDir, 'walk.webm')).length > 0);
    assert.doesNotMatch(readFileSync(join(f.outDir, 'walk.json'), 'utf8'), /fixture-password|canary@/);
    await assert.rejects(runWalk({ ...f, baseUrl: 'https://example.test', env: ENV, playwright: pw }), /must be empty/);
  });
}
test('account is environment-only, matches canary policy and supports app env names', t => {
  const { config } = fixture(t);
  assert.deepEqual(resolveAccount(config, ENV), { email: ENV.CERT_CANARY_EMAIL, password: ENV.CERT_CANARY_PASSWORD });
  for (const env of [{}, { CERT_CANARY_EMAIL: 'real@example.com' }]) assert.throws(() => resolveAccount(config, env), /refusing/);
  assert.throws(() => resolveAccount(config, ENV, { email: 'canary@example.test', password: 'injected' }), /environment/);
  config.goldenPath.accounts.env = { email: 'APP_TEST_EMAIL', password: 'APP_TEST_PASSWORD' };
  assert.equal(resolveAccount(config, { APP_TEST_EMAIL: ENV.CERT_CANARY_EMAIL }).email, ENV.CERT_CANARY_EMAIL);
  delete config.goldenPath.accounts.emailPattern;
  assert.throws(() => resolveAccount(config, ENV), /emailPattern/);
});
for (const [label, flow, options] of [
  ['missing stage', "await snap('entry');", {}],
  ['no steps', '', {}],
  ['unknown stage', "await snap('made-up');", {}],
  ['flow failure', "throw new Error(account.password);", {}],
  ['capture failure', "await snap('entry');", { screenshotError: true }],
  ['missing video', undefined, { videoMissing: true }],
  ['close failure', undefined, { closeError: true }],
]) test(`negative control: ${label} never records a passing walk`, async t => {
  const f = fixture(t); if (flow !== undefined) writeFlow(f.cwd, flow);
  const pw = mockPlaywright(options);
  const result = await runWalk({ ...f, baseUrl: 'https://example.test', env: ENV, playwright: pw });
  assert.equal(result.status, 'failed');
  assert.equal(pw.flags.browserClosed, true);
  assert.doesNotMatch(JSON.stringify(result), /fixture-password/);
});
test('Playwright resolves dynamically from the app node_modules', async t => {
  const { cwd } = fixture(t);
  await assert.rejects(loadPlaywright(cwd), /Cannot find module/);
  const dir = join(cwd, 'node_modules/playwright'); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'playwright', type: 'module', exports: './index.mjs' }));
  writeFileSync(join(dir, 'index.mjs'), 'export const chromium = { consumer: true };');
  assert.equal((await loadPlaywright(cwd)).chromium.consumer, true);
});
test('walk CLI validates path and inline config then forwards app-specific options', async t => {
  const f = fixture(t, APPS[1], { paths: true });
  assert.deepEqual(validateConfig(f.config, { cwd: f.cwd }).errors, []);
  let called = false;
  assert.equal(await main(['--app-config', 'certification/app.json', '--out', 'out', '--surface', 'web'], {
    cwd: f.cwd, run: async args => { called = true; assert.equal(args.config.app, APPS[1].app); return { status: 'passed' }; },
  }), 0);
  assert.ok(called);
  await assert.rejects(main([], { cwd: f.cwd }), /usage/);
  await assert.rejects(main(['--app-config', 'missing.json', '--out', 'x'], { cwd: f.cwd }), /missing/);
});
