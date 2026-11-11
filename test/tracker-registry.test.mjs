import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, approved, compileCatalog, invalidEntries, scanFile } from '../guards/plugins/tracker-registry.mjs';

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

test('host signatures reject lookalikes and accept real hosts and subdomains', () => {
  const hosts = compileCatalog({ signatures: [{ id: 'test', hosts: ['leadsy.ai'], code: [] }] });
  for (const host of ['leadsy.ai', 'cdn.leadsy.ai'])
    assert.equal(scanFile('a.ts', `"https://${host}/script"`, hosts, null, []).length, 1, host);
  for (const host of ['notleadsy.ai', 'leadsy.ai.evil.com', 'leadsy.ai-example.com', 'leadsyXai'])
    assert.equal(scanFile('a.ts', `"https://${host}/script"`, hosts, null, []).length, 0, host);
});
test('privacy copy normalizes curly and entity apostrophes', () => {
  for (const apostrophe of ["'", '’', '&rsquo;', '&apos;', '&#39;', '&#x27;', '&#8217;', '&#x2019;'])
    assert.equal(scanFile('content/privacy.mdx', `We don${apostrophe}t track you`, sigs, null, claims).length, 1, apostrophe);
});
test('tracked source paths containing lock are scanned; lockfiles stay excluded', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'tracker-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd });
    for (const file of ['src/Clock.tsx', 'src/blocks/Pixel.tsx', 'src/adblock.ts', 'package-lock.json']) {
      mkdirSync(join(cwd, file, '..'), { recursive: true });
      writeFileSync(join(cwd, file), 'fbq("init", id)');
    }
    mkdirSync(join(cwd, 'canon/privacy'), { recursive: true });
    writeFileSync(join(cwd, 'canon/privacy/tracker-registry.json'), '{"vendors":[]}');
    execFileSync('git', ['add', '.'], { cwd });
    const result = await run({ cwd });
    assert.equal(result.count, 3);
    assert.equal(result.fails.length, 3);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
