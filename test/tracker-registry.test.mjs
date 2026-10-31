import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { approved, compileCatalog, invalidEntries, scanFile } from '../guards/plugins/tracker-registry.mjs';

const catalog = JSON.parse(readFileSync(new URL('../canon/trackers.json', import.meta.url)));
const sigs = compileCatalog(catalog);
const claims = catalog.banned_claims;
const meta = { id: 'meta', category: 'pixel', hosts: ['facebook.net', 'facebook.com'], rationale: 'retargeting on profiles' };

test('deliberate red: unapproved pixel in source fails', () => {
  const f = scanFile('app/Pixel.tsx', "<Script src='https://connect.facebook.net/en_US/fbevents.js' />", sigs, { vendors: [] }, claims);
  assert.equal(f.length, 1);
  assert.match(f[0].key, /^tracker:meta:/);
});
test('approved vendor with rationale passes; without rationale does not approve', () => {
  const src = "fbq('init', id)";
  assert.equal(scanFile('a.ts', src, sigs, { vendors: [meta] }, claims).length, 0);
  assert.equal(scanFile('a.ts', src, sigs, { vendors: [{ ...meta, rationale: '' }] }, claims).length, 1);
  assert.equal(invalidEntries({ vendors: [{ ...meta, rationale: '' }] }).length, 1);
});
test('deliberate red: session replay and chat widgets are caught', () => {
  assert.equal(scanFile('s.ts', 'integrations: [Sentry.replayIntegration()]', sigs, { vendors: [] }, claims)[0].key.split(':')[1], 'sentry-replay');
  assert.equal(scanFile('package.json', '"@intercom/messenger-js-sdk": "1"', sigs, { vendors: [] }, claims)[0].key.split(':')[1], 'intercom');
});
test('deliberate red: untrue privacy claim in legal copy fails; same words outside copy paths ignored', () => {
  assert.equal(scanFile('content/legal/privacy.md', 'We do not track you.', sigs, null, claims).length, 1);
  assert.equal(scanFile('src/util.ts', 'we do not track you', sigs, null, claims).length, 0);
});
test('host approval matches subdomains, not lookalikes', () => {
  assert.equal(approved(sigs.find((s) => s.id === 'meta'), { vendors: [meta] }), true);
  assert.equal(approved(sigs.find((s) => s.id === 'meta'), { vendors: [{ ...meta, id: 'x', hosts: ['notfacebook.net'] }] }), false);
});
test('every catalog signature has an id, category and at least one matcher', () => {
  for (const s of catalog.signatures) assert.ok(s.id && s.category && (s.hosts.length + s.code.length) > 0, s.id);
});
