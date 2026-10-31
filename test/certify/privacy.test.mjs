import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { analyzePolicy, CONTROL_REGISTRY, cleanControlSnapshot, evaluate, RULES, runControls, vendorFor } from '../../certify/privacy/privacy-rules.mjs';
import { HEALTH_FIELDS, HEALTH_RULES, healthFieldKeys, analyzeHealthClaims } from '../../certify/privacy/health-rules.mjs';
import { buildRecord, toMarkdown } from '../../certify/privacy/privacy-check.mjs';

const registry = CONTROL_REGISTRY;
const config = { app: 'p', privacy: { profile: 'standard' } };
function snapshot() {
  return { ...cleanControlSnapshot(), app: 'p', run_id: 'test-run',
    registry_sha256: createHash('sha256').update(JSON.stringify(registry)).digest('hex') };
}
test('clean evidence passes every shared rule and produces markdown', () => {
  const record = buildRecord(snapshot(), registry, config);
  assert.equal(record.pass, true);
  assert.equal(record.schema, 'company.privacy-record/v1');
  assert.match(toMarkdown(record), /Negative controls: all bit/);
  assert.equal(evaluate(snapshot(), registry).every(r => r.status === 'pass'), true);
});
for (const rule of [...Object.keys(RULES), ...Object.keys(HEALTH_RULES)]) test(`negative control: ${rule}`, () => {
  const controls = runControls(undefined, { privacy: { profile: 'health' } });
  assert.equal(controls.find(c => c.control === rule).ok, true);
});
test('an evaluator that stops biting cannot certify its controls', () => {
  for (const evaluateFn of [() => [], () => [{ rule: 'fake', status: 'pass' }], () => [{ status: 'warn' }]]) {
    assert.equal(buildRecord(snapshot(), registry, config, { evaluateFn }).pass, false);
  }
});
const mutants = {
  'missing schema': s => { delete s.schema; },
  'missing network observations': s => { delete s.pages[0].third_party_requests; },
  'missing input observations': s => { delete s.pages[0].input_kinds; },
  'missing consent observations': s => { delete s.pages[0].consent_banner; },
  'network capture failed': s => { s.pages[0].request_capture_error = true; },
  'empty inventory': s => { s.pages = []; },
  'crawl error': s => { s.pages[0].error = 'timeout'; },
  'HTTP error': s => { s.pages[0].status = 500; },
  'missing HTTP status': s => { delete s.pages[0].status; },
  'DOM probe error': s => { s.pages[0].probe_error = 'denied'; },
  'missing policies': s => { s.policy_versions = {}; },
  'policy error': s => { s.policy_versions['p-privacy'].error = 'unavailable'; },
  'missing policy digest': s => { delete s.policy_versions['p-privacy'].sha256; },
  'wrong app': s => { s.app = 'other'; },
  'registry drift': s => { s.registry_sha256 = 'b'.repeat(64); },
  'unverified acceptance': s => { s.pages[4].third_party_requests = []; },
  'missing minors scenario': s => { s.pages = s.pages.filter(p => !p.young_audience); },
};
for (const [name, mutate] of Object.entries(mutants)) test(`blocks ${name}`, () => {
  const s = snapshot(); mutate(s); const r = buildRecord(s, registry, config);
  assert.equal(r.pass, false); assert.match(toMarkdown(r), /blocked/);
});
test('missing configured scenarios and policies block', () => {
  const c = { ...config, privacy: { crawl: [{ url: 'https://example.test/missing' }], policyUrl: 'https://example.test/missing-policy' } };
  const r = buildRecord(snapshot(), registry, c);
  assert.equal(r.pass, false);
  assert.ok(r.results.some(r => r.rule === 'crawl-coverage' && r.status === 'fail'));
  assert.ok(r.results.some(r => r.rule === 'policy-coverage' && r.status === 'fail'));
});
test('registry rationale and approval are enforced', () => {
  for (const field of ['rationale', 'approved', 'hosts', 'id', 'category']) {
    const reg = structuredClone(registry); delete reg.vendors[0][field];
    assert.ok(evaluate(snapshot(), reg).some(r => r.rule === 'registry-rationale' && r.status === 'fail'));
  }
});
test('policy analysis decodes HTML and rejects misleading claims', () => {
  const a = analyzePolicy('<p>We don&#x27;t track you.</p><p>We use <b>Meta</b> pixels.</p>', registry);
  assert.equal(a.banned_claim_hits.length, 1); assert.deepEqual(a.named_vendors, ['meta']);
  const s = snapshot(); s.policy_versions['p-privacy'].analysis.named_vendors = [];
  assert.ok(evaluate(s, registry).some(r => r.rule === 'claims-truthful' && r.status === 'fail'));
});
test('host matching rejects lookalike domains', () => {
  assert.equal(vendorFor('connect.facebook.net', registry)?.id, 'meta');
  assert.equal(vendorFor('evilfacebook.net', registry), null);
});
test('EU consent bar required where US pixels fire; both actions required', () => {
  for (const banner of [{ visible: false }, { visible: true, accept: 1, reject: 0 }]) {
    const s = snapshot(); s.pages[3].consent_banner = banner;
    assert.ok(evaluate(s, registry).some(r => r.rule === 'eu-consent-first' && r.status === 'fail'));
  }
  const s = snapshot(); s.pages[0].third_party_requests = []; s.pages[3].consent_banner.visible = false;
  assert.equal(evaluate(s, registry).some(r => r.rule === 'eu-consent-first' && r.status === 'fail'), false);
});
test('GPC must visibly confirm honor on a pixel product', () => {
  const s = snapshot(); s.pages[2].gpc_confirmation = false;
  assert.ok(evaluate(s, registry).some(r => r.rule === 'gpc-honored' && r.status === 'fail'));
});
for (const field of HEALTH_FIELDS) test(`health key rejected in URL/query/nested body: ${field}`, () => {
  for (const req of [{ url: `https://cdn.test/?${field.toUpperCase()}=123` },
    { body: JSON.stringify({ nested: [{ [field]: 123 }] }) }, { query: `field=${field}` },
    { body: `Content-Disposition: form-data; name="${field}"\r\n123` }]) {
    assert.ok(healthFieldKeys(req).includes(field.toLowerCase()));
  }
  assert.deepEqual(healthFieldKeys({ body: { [`${field}ish`]: 123 } }), []);
});
for (const claim of ['HIPAA compliant', 'HIPAA-compliant', 'medical advice', 'clinically proven', 'we never share your health data']) test(`health claim: ${claim}`, () => {
  const s = snapshot(); s.pages[0].text = claim;
  assert.ok(evaluate(s, registry, { privacy: { profile: 'health' } }).some(r => r.rule === 'health-banned-claims' && r.status === 'fail'));
  assert.ok(analyzeHealthClaims(claim.toUpperCase()).length);
});
test('health tracker ban covers non-input pages and every phase; whitespace is not signoff', () => {
  for (const category of ['pixel', 'ads', 'replay']) {
    const reg = structuredClone(registry); reg.vendors[0].category = category;
    const s = snapshot(); s.pages[0].third_party_requests[0].phase = 'after-accept';
    for (const counselSignoff of [undefined, '', ' ', 'counsel-review-123']) {
      const r = evaluate(s, reg, { privacy: { profile: 'health', counselSignoff } });
      assert.equal(r.some(r => r.rule === 'health-no-ad-tracker' && r.status === 'fail'), counselSignoff !== 'counsel-review-123');
    }
  }
});
test('health policy must be distinct and linked on the actual homepage', () => {
  const c = { privacy: { profile: 'health', crawl: [{ url: 'https://example.test/' }],
    policyUrl: 'https://example.test/privacy', healthPolicyUrl: 'https://example.test/health' } };
  const s = snapshot(); s.pages[0].url = c.privacy.crawl[0].url; s.pages[0].links = ['/health'];
  const passed = () => evaluate(s, registry, c).find(r => r.rule === 'health-policy-linked').status === 'pass';
  assert.equal(passed(), true);
  s.pages[0].links = ['/privacy']; assert.equal(passed(), false);
  c.privacy.healthPolicyUrl = c.privacy.policyUrl; assert.equal(passed(), false);
});
