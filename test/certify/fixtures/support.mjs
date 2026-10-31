import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sealReceipt } from '../../../certify/buyer/store.mjs';
import { digestOf } from '../../../certify/judge/receipt.mjs';
import { RUBRIC_VERSION, RECEIPT_SCHEMA } from '../../../certify/buyer/rubric.mjs';

export const SHA = 'a'.repeat(40);
export const NOW = Date.parse('2026-10-31T12:00:00Z');
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1sAAAAASUVORK5CYII=', 'base64');
export const APPS = [
  { app: 'jovie-fixture', plan: 'Artist Presence', price: 12, brief: 'Independent artist selling music and managing releases.', freeAlternative: 'A free link page' },
  { app: 'logyourbody-fixture', plan: 'Training Insights', price: 9.99, brief: 'Recreational athlete tracking weekly fitness progress.', freeAlternative: 'A local fitness spreadsheet' },
];
export const ENV = { CERT_CANARY_EMAIL: 'canary@example.test', CERT_CANARY_PASSWORD: 'fixture-password' };

export function fixture(t, spec = APPS[0], { paths = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cert-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, 'app');
  mkdirSync(join(cwd, 'certification'), { recursive: true });
  const config = {
    schema: 'company.public-app-cert/v1', app: spec.app, stage: 'prelaunch', dataClass: spec === APPS[1] ? 'health' : 'standard',
    goldenPath: { stages: ['entry', 'signup', 'onboarding', 'first-value', 'paid-conversion'].map(kind => ({ id: kind, kind, oracle: `The canary achieves ${kind} with its own data` })),
      flows: { web: 'certification/flow.mjs' }, baseUrl: 'https://example.test',
      accounts: { policy: 'canary-only', emailPattern: '^canary@.*\\.test$' } },
    paidOutcome: { plan: spec.plan, price: spec.price, currency: 'USD', interval: 'month', trialDays: 14,
      priceSource: 'prices.txt', pricePattern: 'price=(\\d+(?:\\.\\d+)?)', freeAlternative: spec.freeAlternative },
    buyer: { personas: [{ id: 'buyer', brief: spec.brief }, { id: 'control', brief: 'Uses only free tools and will never pay.', control: true }],
      calibration: { holdouts: [1, 2, 3].map(n => ({ id: `bad-${n}`, expect: 'no_pay', walk: `holdout-${n}` })),
        positiveCanaries: [{ id: 'positive', expect: 'pay', walk: 'positive' }] }, contaminationMarkers: ['internal-secret-marker'] },
    privacy: { profile: spec === APPS[1] ? 'health' : 'standard', registry: 'trackers.json', crawl: [{ url: 'https://example.test' }], policyUrl: 'https://example.test/privacy', healthPolicyUrl: 'https://example.test/health' },
    customerVoice: { channels: [{ id: 'feedback', kind: 'in-app-feedback', route: 'feedback' }], approval: 'tim' },
    waste: { appId: spec.app }, capacity: { appId: spec.app },
  };
  writeFileSync(join(cwd, 'prices.txt'), `price=${spec.price}`);
  writeFileSync(join(cwd, 'trackers.json'), '{}');
  writeFlow(cwd);
  if (paths) {
    for (const key of ['personas', 'calibration']) {
      writeFileSync(join(cwd, `${key}.json`), JSON.stringify(config.buyer[key]));
      config.buyer[key] = `${key}.json`;
    }
  }
  writeFileSync(join(cwd, 'certification/app.json'), JSON.stringify(config));
  return { cwd, root, config, outDir: join(root, 'walk'), state: join(root, 'state') };
}

export function writeFlow(cwd, source = 'for (const stage of config.goldenPath.stages) await snap(stage.id, stage.kind);') {
  writeFileSync(join(cwd, 'certification/flow.mjs'), `export default async ({snap,config,page,account,baseUrl,settle}) => { ${source} };`);
}
export function mockPlaywright({ screenshotError = false, closeError = false, videoMissing = false } = {}) {
  const flags = { browserClosed: false, contextClosed: false };
  let videoPath;
  const page = { video: () => videoMissing ? null : { path: async () => videoPath },
    screenshot: async ({ path }) => { if (screenshotError) throw new Error('capture failed'); writeFileSync(path, PNG); },
    locator: () => ({ innerText: async () => 'Personalized result with saved account data and a working next action.' }),
    url: () => 'https://example.test/value', waitForTimeout: async () => {} };
  return { flags, chromium: { launch: async () => ({
    newContext: async options => {
      videoPath = join(options.recordVideo.dir, 'capture.webm');
      writeFileSync(videoPath, 'fixture-video');
      return { newPage: async () => page, close: async () => { flags.contextClosed = true; if (closeError) throw new Error('close'); } };
    }, close: async () => { flags.browserClosed = true; },
  }) } };
}

export const media = { probe: () => 10, extract: (_video, _t, out) => { writeFileSync(out, PNG); return true; } };
// Tiny contract stub until part A's real detector is merged. Production never imports this.
export function detectFailureSurface(text) {
  return !text.trim() ? { kind: 'empty' } : /something went wrong|message limit|coming soon|lorem ipsum/i.test(text) ? { kind: 'error' } : null;
}
export function sample(pPay = 0.7, extra = {}) {
  return { pPay, pPay3x: pPay / 2, objections: [{ text: 'Payment needs more proof', stepId: '01', category: 'price_vs_value', severity: 'major' }],
    valueEvidence: [{ stepId: '01', what: 'Personalized saved result' }], flipToPay: [{ change: 'Show a comparison', removesObjection: 1, kind: 'proof' }], ...extra };
}
export const envelope = output => JSON.stringify({ structured_output: output, total_cost_usd: 0.01 });
export function fakeIngest({ config, sha = SHA, subjectId = 'buyer', text = 'Personal saved result', status = 'passed' }) {
  return () => {
    const frameDir = mkdtempSync(join(tmpdir(), 'cert-isolate-'));
    const path = join(frameDir, '01.png'); writeFileSync(path, PNG);
    return { app: config.app, frameDir, sourceSha: sha, status, subjectId, walkId: 'fixture-walk',
      steps: [{ stepId: '01', stageId: 'first-value', title: 'Personal value', tSec: 3.4, images: [path], text }] };
  };
}
export function strong(p = 0.7) {
  return { verdict: 'pay', pPay: p, model: 'claude-opus-5-5', failures: [], samples: 3, coherentSamples: 3,
    sampleP: Array.from({ length: 3 }, () => ({ p, p3x: p / 2, raw: p, coherent: true, capped: false })) };
}
export function gateFixture(config) {
  const base = { schema: RECEIPT_SCHEMA, app: config.app, configDigest: digestOf(config), rubric: RUBRIC_VERSION,
    at: new Date(NOW).toISOString(), sha: SHA, persona: { id: 'buyer', tier: 'A' }, subject: 'buyer' };
  const holdouts = [1, 2, 3].map(n => ({ ...base, subject: `bad-${n}`, calibrationId: `bad-${n}`, holdout: true, expect: 'no_pay', verdict: 'no_pay', pPay: 0.03 }));
  const positive = { ...base, subject: 'positive', calibrationId: 'positive', holdout: true, expect: 'pay', verdict: 'pay', pPay: 0.7, strong: strong() };
  const control = { ...base, subject: 'control', persona: { id: 'control', tier: 'A', control: true }, verdict: 'no_pay', pPay: 0.01 };
  const own = { ...base, walkSubject: 'buyer', walkId: 'fixture-walk', verdict: 'pay', pPay: 0.7, strong: strong() };
  return { subject: 'buyer', sha: SHA, now: NOW, config, timYes: true,
    cert: { allow: true, app: config.app, sourceSha: SHA, judgedAt: base.at }, receipts: [...holdouts, positive, control, own].map(sealReceipt) };
}
