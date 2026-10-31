import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appConfig } from './fixtures/app.mjs';
import { crawl, loadRegistry, isFirstParty } from '../../certify/privacy/privacy-inventory.mjs';
import { pageProbe } from '../../certify/privacy/page-probe.mjs';
import { CONTROL_REGISTRY, evaluate } from '../../certify/privacy/privacy-rules.mjs';

function mockBrowser({ navigationError, probeError, status = 200, fatal = false, accept = true } = {}) {
  const contexts = [], requested = [], scripts = [];
  let closed = false;
  const browser = {
    async close() { closed = true; },
    async newContext(opts) {
      contexts.push(opts); let listener; let url = 'about:blank';
      const request = (url, body) => listener({ url: () => url, postData: () => body, resourceType: () => 'fetch' });
      const page = {
        on(name, fn) { assert.equal(name, 'request'); listener = fn; },
        url: () => url,
        async goto(target) {
          url = target; requested.push(target);
          if (navigationError) throw new Error('Navigation timeout');
          request('https://example.test/api?weight=123', '{"email":"canary@example.test"}');
          request('https://cdn.test/event?token=synthetic-secret&bodyFat=20', '{"weight":77,"email":"canary@example.test"}');
          request('https://cdn.test/image', null);
          request('data:text/plain,ignore', null);
          return { status: () => status };
        },
        async waitForLoadState() {}, async waitForTimeout() {},
        async evaluate() {
          if (probeError) throw new Error('DOM unavailable');
          return { input_kinds: [], prechecked: [], links: ['https://example.test/health'], health_claim_hits: [],
            consent_banner: { visible: true, accept: 1, reject: 1 }, gpc_confirmation: true, local_storage_keys: ['test-key'] };
        },
        getByRole() { return { first: () => ({ click: async () => {
          if (!accept) throw new Error('no button');
          request('https://cdn.test/after', '{"height":180}');
        } }) }; },
      };
      return { async newPage() { if (fatal) throw new Error('browser fatal'); return page; },
        async addInitScript(fn, arg) { scripts.push({ fn, arg }); },
        async cookies() { return [{ name: 'session', domain: '.example.test', value: 'synthetic-secret' }, { name: 'vendor', domain: '.cdn.test', value: 'synthetic-secret' }]; },
        async close() {} };
    },
  };
  return { chromium: { launch: async () => browser }, contexts, requested, scripts, get closed() { return closed; } };
}
const fetchImpl = async () => ({ ok: true, status: 200, text: async () => '<p>Privacy policy. Meta</p>' });
test('crawler covers config surfaces/scenarios, records request field names, and drops all values', async () => {
  const config = appConfig(); config.privacy.profile = 'health'; config.privacy.healthPolicyUrl = 'https://example.test/health';
  config.privacy.consentRegionCookie = { name: 'test_region', required: 'yes', optional: 'no' };
  config.privacy.crawl.push({ url: 'https://example.test/signup', input: true });
  const mock = mockBrowser();
  const s = await crawl({ config, registry: CONTROL_REGISTRY, chromium: mock.chromium, fetchImpl });
  assert.equal(s.schema, 'company.privacy-inventory/v1'); assert.equal(s.app, config.app);
  assert.equal(s.pages.length, 8); assert.equal(mock.closed, true);
  assert.equal(s.pages[4].declared_inputs[0], 'text');
  assert.deepEqual(s.pages[0].third_party_requests[0].health_field_keys, ['bodyfat', 'weight']);
  assert.equal(s.pages[3].third_party_requests[1].phase, 'after-accept');
  assert.deepEqual(s.pages[3].third_party_requests[1].health_field_keys, ['height']);
  assert.doesNotMatch(JSON.stringify(s), /synthetic-secret|canary@example|"weight":77|bodyFat=20/);
  assert.equal(s.pages[0].cookies.find(c => c.name === 'vendor').third_party, true);
  assert.equal(mock.contexts.filter(c => c.extraHTTPHeaders['Sec-GPC'] === '1').length, 2);
  assert.ok(mock.scripts.some(s => s.arg?.name === 'test_region' && s.arg.value === 'yes'));
  assert.equal(Object.keys(s.policy_versions).length, 2);
  assert.ok(evaluate(s, CONTROL_REGISTRY, config).some(r => r.rule === 'health-no-health-fields-to-third-parties' && r.status === 'fail'));
  for (const script of mock.scripts) {
    const sandbox = { arg: script.arg, document: {}, Navigator: function Navigator() {} };
    const prior = { document: globalThis.document, Navigator: globalThis.Navigator };
    Object.assign(globalThis, { document: sandbox.document, Navigator: sandbox.Navigator });
    try { script.fn(script.arg); } finally { Object.assign(globalThis, prior); }
    if (script.arg) assert.match(sandbox.document.cookie, /^test_region=/);
    else assert.equal(new sandbox.Navigator().globalPrivacyControl, true);
  }
});
for (const fault of [{ navigationError: true }, { probeError: true }, { status: 503 }]) test(`failed crawl remains red: ${JSON.stringify(fault)}`, async () => {
  const config = appConfig(), mock = mockBrowser(fault);
  const s = await crawl({ config, registry: CONTROL_REGISTRY, chromium: mock.chromium, fetchImpl });
  assert.ok(evaluate(s, CONTROL_REGISTRY, config).some(r => r.rule === 'crawl-complete' && r.status === 'fail'));
  assert.equal(mock.closed, true);
});
test('policy fetch errors and rejected Accept remain evidence, not success', async () => {
  for (const policyFetch of [async () => ({ ok: false, status: 502, text: async () => 'failed' }), async () => { throw new Error('network'); }]) {
    const config = appConfig(), mock = mockBrowser({ accept: false });
    const s = await crawl({ config, registry: CONTROL_REGISTRY, chromium: mock.chromium, fetchImpl: policyFetch });
    assert.ok(Object.values(s.policy_versions)[0].error);
    assert.equal(s.pages[3].accepted, false);
  }
});
test('browser is closed on unexpected errors and invalid selectors are rejected', async () => {
  const mock = mockBrowser({ fatal: true });
  await assert.rejects(crawl({ config: appConfig(), registry: CONTROL_REGISTRY, chromium: mock.chromium, fetchImpl }), /browser fatal/);
  assert.equal(mock.closed, true);
  for (const patch of [{ config: {} }, { scenarios: [] }, { scenarios: ['unknown'] }, { only: ['absent'] },
    { config: { ...appConfig(), privacy: { ...appConfig().privacy, firstPartyDomains: [] } } }]) {
    await assert.rejects(crawl({ config: appConfig(), registry: CONTROL_REGISTRY, chromium: mock.chromium, fetchImpl, ...patch }));
  }
});
test('module imports without Playwright; crawl dynamically resolves it from the app repo only', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'certkit-app-'));
  try {
    const config = appConfig();
    writeFileSync(join(cwd, 'registry.json'), JSON.stringify(CONTROL_REGISTRY));
    assert.deepEqual(loadRegistry(config, cwd), CONTROL_REGISTRY);
    await assert.rejects(crawl({ config, cwd, fetchImpl }), /playwright/);
    mkdirSync(join(cwd, 'node_modules/playwright'), { recursive: true });
    writeFileSync(join(cwd, 'node_modules/playwright/package.json'), '{"type":"module","main":"index.mjs"}');
    writeFileSync(join(cwd, 'node_modules/playwright/index.mjs'), 'export const chromium = { launch() { throw new Error("APP-LOCAL-PLAYWRIGHT"); } };');
    await assert.rejects(crawl({ config, cwd, fetchImpl }), /APP-LOCAL-PLAYWRIGHT/);
    symlinkSync(join(cwd, 'registry.json'), join(cwd, 'linked.json'));
    assert.deepEqual(loadRegistry({ privacy: { registry: 'linked.json' } }, cwd), CONTROL_REGISTRY);
    assert.throws(() => loadRegistry({ privacy: { registry: '../' } }, cwd), /inside the app repo/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
  assert.equal(isFirstParty('sub.example.test', ['example.test']), true);
  assert.equal(isFirstParty('evilexample.test', ['example.test']), false);
});
test('DOM probe sees typed fields, prechecks, links, health claims and consent choices', () => {
  const el = (tagName, attrs = {}, textContent = '') => ({ tagName, textContent, id: '', disabled: false, checked: attrs.checked,
    href: attrs.href, src: attrs.src, hidden: attrs.hidden,
    getAttribute: key => attrs[key] ?? null, closest: () => null, matches: sel => sel === 'input' && tagName === 'INPUT',
    getBoundingClientRect: () => ({ width: attrs.hidden ? 0 : 100, height: 20 }) });
  const inputs = [el('INPUT', { type: 'email' }), el('INPUT', { type: 'password' }), el('INPUT', { type: 'tel' }),
    el('INPUT', { type: 'search' }), el('TEXTAREA'), el('DIV'), el('INPUT', { type: 'text' }),
    el('INPUT', { type: 'hidden' }), el('INPUT', { type: 'text', hidden: true })];
  const boxes = [el('INPUT', { checked: true, name: 'newsletter' }), el('DIV', { 'aria-checked': 'true', 'aria-label': 'marketing' })];
  const links = [el('A', { href: 'https://example.test/health' }, 'Consumer health policy'),
    el('A', { href: '/choices' }, 'Do Not Sell or Share'), el('BUTTON', {}, 'Accept'), el('BUTTON', {}, 'Reject')];
  const sandbox = { args: { globals: ['tracker', 'absent'], dnsSource: 'do not sell', gpcSource: 'GPC', healthClaims: ['HIPAA[- ]compliant'] },
    document: { body: { innerText: 'Privacy cookies GPC HIPAA compliant' }, querySelectorAll: selector => {
      if (selector === 'a, button') return links;
      if (selector === 'a[href]') return links.filter(e => e.tagName === 'A');
      if (selector === 'iframe') return [el('IFRAME', { src: 'https://js.stripe.com/' })];
      if (selector.startsWith('input[type=checkbox]')) return boxes;
      return inputs;
    } }, window: { tracker: true }, localStorage: { one: 'secret' }, sessionStorage: { two: 'secret' },
    getComputedStyle: () => ({ visibility: 'visible', display: 'block' }) };
  const prior = Object.fromEntries(Object.keys(sandbox).map(k => [k, globalThis[k]]));
  Object.assign(globalThis, sandbox);
  let probe;
  try { probe = pageProbe(sandbox.args); } finally { Object.assign(globalThis, prior); }
  assert.deepEqual(probe.input_kinds, ['email', 'freeform', 'password', 'payment', 'search', 'tel', 'text']);
  assert.deepEqual(probe.prechecked, ['newsletter', 'marketing']);
  assert.equal(probe.consent_banner.accept, 1); assert.equal(probe.consent_banner.reject, 1);
  assert.equal(probe.gpc_confirmation, true); assert.ok(probe.health_claim_hits.length);
  assert.deepEqual(probe.globals, ['tracker']); assert.deepEqual(probe.local_storage_keys, ['one']);
  assert.doesNotMatch(JSON.stringify(probe), /secret/);
});
test('empty policy bodies are never usable evidence', async () => {
  const mock = mockBrowser(), config = appConfig();
  const s = await crawl({ config, registry: CONTROL_REGISTRY, chromium: mock.chromium,
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => '<html><body> </body></html>' }) });
  assert.match(Object.values(s.policy_versions)[0].error, /Empty policy/);
});
