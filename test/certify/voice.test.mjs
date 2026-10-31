import assert from 'node:assert/strict';
import test from 'node:test';
import { appConfig } from './fixtures/app.mjs';
import { urgentReasons, isFeedbackTurn, isAutomatedEmail } from '../../certify/voice/classify.mjs';
import { buildEvent, validateEvent, postToSummer, redactText } from '../../certify/voice/contract.mjs';
const config = appConfig();
const env = { CUSTOMER_VOICE_SALT: 'synthetic-test-salt' };
const input = { channel: 'support', messageId: 'message-test', from: 'Canary@EXAMPLE.TEST',
  text: 'Reply to Canary@example.test or +1 (202) 555-0100. My page is broken.', draftReply: 'Contact canary@example.test.' };
const event = () => buildEvent(input, config, { env });

test('raw address and phone never appear in the event, including drafted reply', () => {
  const e = event();
  assert.doesNotMatch(JSON.stringify(e), /canary@example\.test|555-0100/i);
  assert.match(e.fromHash, /^[a-f0-9]{64}$/);
  assert.equal(e.approval, 'tim'); assert.equal(e.status, 'pending-approval');
  assert.deepEqual(validateEvent(e, config).errors, []);
  assert.equal(e.fromHash, buildEvent({ ...input, from: 'Canary <canary@example.test>' }, config, { env }).fromHash);
  assert.notEqual(e.fromHash, buildEvent(input, config, { env: { CUSTOMER_VOICE_SALT: 'another-test-salt' } }).fromHash);
});
test('missing salt, sender, text and unknown channels are rejected', () => {
  assert.throws(() => buildEvent(input, config, { env: {} }), /SALT/);
  for (const patch of [{ from: '' }, { text: '' }, { channel: 'unregistered' }]) assert.throws(() => buildEvent({ ...input, ...patch }, config, { env }));
});
for (const patch of [{ schema: 'wrong' }, { app: 'wrong' }, { channel: 'other' }, { kind: 'sms' },
  { messageId: '' }, { receivedAt: 'invalid' }, { fromHash: 'raw@example.test' }, { text: 'raw@example.test' },
  { draftReply: '202-555-0100' }, { classification: {} }, { approval: 'someone' }, { status: 'sent' },
  { from: 'raw@example.test' }, { messageId: 'raw@example.test' },
  { classification: { feedback: true, urgentReasons: ['made-up'] } }]) test(`event validation rejects ${Object.keys(patch)[0]}: ${JSON.stringify(patch)}`, () => {
  assert.ok(validateEvent({ ...event(), ...patch }, config).errors.length);
});
test('only the configured internal approval sink receives the event', async () => {
  const calls = [];
  const e = event();
  const r = await postToSummer(e, { config, url: 'https://summer.example.test/voice', token: 'test-token',
    fetchImpl: async (url, init) => { calls.push({ url, init }); return { ok: true, status: 202 }; } });
  assert.equal(r.ok, true); assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://summer.example.test/voice');
  assert.equal(calls[0].init.redirect, 'error');
  assert.deepEqual(JSON.parse(calls[0].init.body), e);
});
test('missing sink/token, invalid payload, HTTP errors and redirects fail closed', async () => {
  const opts = { config, url: 'https://summer.example.test/voice', token: 'test-token' };
  for (const patch of [{ url: undefined }, { token: undefined }, { url: 'http://example.test' }]) {
    await assert.rejects(postToSummer(event(), { ...opts, ...patch, fetchImpl: () => { assert.fail('must not send'); } }));
  }
  await assert.rejects(postToSummer({ ...event(), status: 'sent' }, opts), /approval/);
  await assert.rejects(postToSummer(event(), { ...opts, fetchImpl: async () => ({ ok: false, status: 503 }) }), /503/);
  await assert.rejects(postToSummer(event(), { ...opts, fetchImpl: async () => { throw new Error('redirect'); } }), /redirect/);
});
const urgent = { billing: 'I was charged twice, I want a refund', bug: "can't log in, blank screen",
  angry: 'this is a scam!!!', public: 'posting about this on reddit', legal: 'delete my data under GDPR or I call a lawyer' };
for (const [kind, text] of Object.entries(urgent)) test(`classification: ${kind}`, () => assert.deepEqual(urgentReasons(text), [kind]));
test('feedback classifier preserves soft price, thin value, confusion and feature asks', () => {
  for (const text of ['15usd a month? Wow. A lot? I want to try it first.', 'Well the preview is just my name and a photo so...',
    'the page is broken on my phone', "I don't understand what this does", 'would be great if it supported files', 'can I talk to someone on the team?']) assert.equal(isFeedbackTurn(text), true);
  for (const text of ['organize my files by date', 'yes that is me', 'add my account', 'ok', 'x'.repeat(4001)]) assert.equal(isFeedbackTurn(text), false);
  assert.deepEqual(urgentReasons('love it, thanks'), []);
  assert.equal(buildEvent({ ...input, channel: 'chat', text: 'organize my files by date', draftReply: null }, config, { env }).classification.feedback, false);
});
test('automated mail is rejected; a real canary question is retained', () => {
  for (const mail of [{ from: 'MAILER-DAEMON@example.test' }, { from: 'canary@example.test', subject: 'Out of office' },
    { from: 'canary@example.test', headers: { 'Auto-Submitted': 'auto-replied' } },
    { from: 'canary@example.test', headers: { 'List-Unsubscribe': '<test>' } },
    { from: 'canary@example.test', headers: { Precedence: 'bulk' } }]) assert.equal(isAutomatedEmail(mail), true);
  assert.equal(isAutomatedEmail({ from: 'Canary <canary@example.test>', subject: 'Question about pricing', headers: { 'Auto-Submitted': 'no' } }), false);
  assert.equal(redactText('ordinary text'), 'ordinary text');
});
test('a channel-validated event can be posted using only the documented sink options', async () => {
  assert.equal((await postToSummer(event(), { url: 'https://summer.example.test/voice', token: 'test-token',
    fetchImpl: async () => ({ ok: true, status: 202 }) })).ok, true);
});
