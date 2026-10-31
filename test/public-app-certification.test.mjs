import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateConfig } from '../certify/config.mjs';
import { check } from '../guards/plugins/public-app-certification.mjs';
import { classify, receiptVerdict } from '../scripts/public-app-scan.mjs';
import { plan } from '../templates/public-app/bootstrap.mjs';

const registry = JSON.parse(readFileSync(new URL('../canon/public-apps.json', import.meta.url)));
const resources = JSON.parse(readFileSync(new URL('../canon/resources.json', import.meta.url)));
const consumers = JSON.parse(readFileSync(new URL('../canon/consumers.json', import.meta.url)));
const SHA = 'a'.repeat(40);
const NOW = Date.parse('2026-11-01T00:00:00Z');

function filled(app = 'logyourbody') {
  return {
    schema: 'company.public-app-cert/v1', app, stage: 'prelaunch', dataClass: 'health',
    goldenPath: {
      stages: ['entry', 'signup', 'onboarding', 'first-value', 'paid-conversion'].map((k) => ({ id: k, kind: k, oracle: `canary sees ${k} for itself` })),
      flows: { web: 'certification/flows/web.mjs' },
      accounts: { policy: 'canary-only', source: 'doppler:lyb/prd' },
    },
    paidOutcome: { plan: 'Premium', price: 9.99, currency: 'USD', interval: 'month', priceSource: 'p.storekit', freeAlternative: 'Apple Health' },
    buyer: { personas: 'certification/personas.json', calibration: 'certification/calibration.json' },
    privacy: { profile: 'health', registry: 'certification/tracker-registry.json', crawl: [{ url: 'https://x' }], policyUrl: 'https://x/privacy', healthPolicyUrl: 'https://x/health' },
    customerVoice: { channels: [{ id: 'mail', kind: 'email', route: 'apps/web/inbound' }], approval: 'tim' },
    waste: { appId: 'logyourbody' }, capacity: { appId: 'logyourbody' },
  };
}

function scaffold(repo = 'JovieInc/LogYourBody') {
  const dir = mkdtempSync(join(tmpdir(), 'pubapp-'));
  for (const w of plan({ registry, repo, target: dir, sha: SHA })) {
    mkdirSync(join(w.dest, '..'), { recursive: true });
    writeFileSync(w.dest, w.body);
  }
  return dir;
}

test('config: a filled config is valid', () => {
  assert.deepEqual(validateConfig(filled()).errors, []);
});

test('config (negative control): the scaffold stub is rejected, so a new app is red until filled', () => {
  const dir = scaffold();
  const stub = JSON.parse(readFileSync(join(dir, 'certification/app.json'), 'utf8'));
  const { errors } = validateConfig(stub, { cwd: dir });
  assert.ok(errors.some((e) => e.includes('TODO')), errors.join('\n'));
});

test('config: health data needs the health privacy profile and a health policy', () => {
  const c = filled();
  c.privacy.profile = 'standard';
  delete c.privacy.healthPolicyUrl;
  assert.ok(validateConfig(c).errors.some((e) => e.includes('must be "health"')));
});

test('config: missing paid-conversion stage, non-canary accounts and non-Tim approval fail', () => {
  const c = filled();
  c.goldenPath.stages = c.goldenPath.stages.filter((s) => s.kind !== 'paid-conversion');
  c.goldenPath.accounts.policy = 'real-users';
  c.customerVoice.approval = 'auto';
  const e = validateConfig(c).errors.join('\n');
  assert.match(e, /paid-conversion/);
  assert.match(e, /canary-only/);
  assert.match(e, /approval must be "tim"/);
});

test('guard: registered app with no config warns before enforceFrom and fails after', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pubapp-'));
  const before = check({ registry, repo: 'JovieInc/LogYourBody', cwd: dir, now: Date.parse('2026-11-01') });
  assert.equal(before.fails.length, 0);
  assert.ok(before.warnings.some((w) => w.includes('missing')));
  const after = check({ registry, repo: 'JovieInc/LogYourBody', cwd: dir, now: Date.parse('2026-11-08') });
  assert.ok(after.fails.some((f) => f.includes('missing')));
});

test('guard: an unregistered certification config fails (registration is the company layer)', () => {
  const r = check({ registry, repo: 'JovieInc/Ops', cwd: '.', listCertFiles: () => ['certification/app.json'] });
  assert.ok(r.fails.some((f) => f.includes('not registered')));
});

test('guard: a repo with no public app has nothing to check', () => {
  assert.deepEqual(check({ registry, repo: 'JovieInc/ci', cwd: '.' }).fails, []);
});

test('launch scan: the live registry classifies every public surface', () => {
  assert.deepEqual(classify(registry, resources, consumers), []);
});

test('launch scan (negative control): a new canonical domain that is not classified fails', () => {
  const r = { resources: [...resources.resources, { kind: 'domain', name: 'newapp.com', purpose: 'New app', status: 'canonical' }] };
  assert.ok(classify(registry, r, consumers).some((f) => f.includes('newapp.com')));
});

test('launch scan: an app repo outside consumers.json fails', () => {
  const reg = { ...registry, apps: [...registry.apps, { id: 'x', repo: 'JovieInc/NewApp', stage: 'prelaunch', dataClass: 'standard', enforceFrom: '2026-12-01', surfaces: [] }] };
  assert.ok(classify(reg, resources, consumers).some((f) => f.includes('consumers.json')));
});

test('receipts: public needs a fresh success; missing, failed or stale fail after enforceFrom', () => {
  const app = { id: 'a', stage: 'public', enforceFrom: '2026-10-01' };
  const fresh = { state: 'success', createdAt: '2026-10-30T00:00:00Z' };
  assert.equal(receiptVerdict({ app, latest: fresh, maxAgeDays: 7, now: NOW }).ok, true);
  assert.equal(receiptVerdict({ app, latest: null, maxAgeDays: 7, now: NOW }).level, 'fail');
  assert.equal(receiptVerdict({ app, latest: { ...fresh, state: 'failure' }, maxAgeDays: 7, now: NOW }).ok, false);
  assert.equal(receiptVerdict({ app, latest: { ...fresh, createdAt: '2026-10-01T00:00:00Z' }, maxAgeDays: 7, now: NOW }).ok, false);
  assert.equal(receiptVerdict({ app: { ...app, enforceFrom: '2026-12-01' }, latest: null, maxAgeDays: 7, now: NOW }).level, 'warn');
  assert.equal(receiptVerdict({ app: { ...app, stage: 'prelaunch' }, latest: null, maxAgeDays: 7, now: NOW }).ok, true);
});

test('scaffold: writes every inherited piece with values filled and never overwrites', () => {
  const dir = scaffold();
  const wf = readFileSync(join(dir, '.github/workflows/public-app-certification.yml'), 'utf8');
  assert.ok(wf.includes(`public-app-certification.yml@${SHA}`));
  const cfg = JSON.parse(readFileSync(join(dir, 'certification/app.json'), 'utf8'));
  assert.equal(cfg.app, 'logyourbody');
  assert.equal(cfg.dataClass, 'health');
  for (const f of ['personas.json', 'calibration.json', 'tracker-registry.json', 'flows/web.mjs']) readFileSync(join(dir, 'certification', f));
  assert.equal(plan({ registry, repo: 'JovieInc/LogYourBody', target: dir, sha: SHA }).length, 0);
});

test('scaffold: a repo with several apps gets one config per app at its registry path', () => {
  const dir = scaffold('JovieInc/Jovie');
  for (const f of ['jovie-web.json', 'jovie-ios.json', 'should-i-make.json']) {
    assert.equal(JSON.parse(readFileSync(join(dir, 'canon/certification', f), 'utf8')).schema, 'company.public-app-cert/v1');
  }
  const ios = JSON.parse(readFileSync(join(dir, 'canon/certification/jovie-ios.json'), 'utf8'));
  assert.equal(ios.buyer.personas, 'canon/certification/jovie-ios-personas.json');
  assert.equal(ios.goldenPath.flows.web, 'canon/certification/flows/jovie-ios.mjs');
  readFileSync(join(dir, 'canon/certification/jovie-ios-personas.json'));
});

test('scaffold: an app that is already configured only gets repo-level files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pubapp-'));
  mkdirSync(join(dir, 'certification'), { recursive: true });
  writeFileSync(join(dir, 'certification/app.json'), '{}');
  const rels = plan({ registry, repo: 'JovieInc/LogYourBody', target: dir, sha: SHA }).map((w) => w.rel);
  assert.deepEqual(rels, ['.github/workflows/public-app-certification.yml']);
});
