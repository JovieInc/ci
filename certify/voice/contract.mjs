import { createHash } from 'node:crypto';
import { isFeedbackTurn, urgentReasons } from './classify.mjs';

export const EVENT_SCHEMA = 'company.customer-voice-event/v1';
const email = /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9.-]*[A-Z0-9])?\.[A-Z]{2,}/gi;
const phone = /(?:\+?\d[\d ().-]{6,}\d)/g;
export function redactText(text) {
  return String(text).replace(email, '[email redacted]').replace(phone, '[phone redacted]');
}
const nonempty = value => typeof value === 'string' && value.trim().length > 0;

export function validateEvent(event, config) {
  const errors = [];
  if (!event || typeof event !== 'object') return { errors: ['event must be an object'] };
  if (event.schema !== EVENT_SCHEMA) errors.push('invalid event schema');
  if (!nonempty(config?.app) || event.app !== config.app) errors.push('event app must match config');
  const channel = config?.customerVoice?.channels?.find(c => nonempty(c.id) && c.id === event.channel);
  if (!channel) errors.push('channel is not configured');
  if (!nonempty(event.kind) || (channel && event.kind !== channel.kind)) errors.push('kind must match channel');
  if (!nonempty(event.messageId)) errors.push('messageId required');
  if (!nonempty(event.receivedAt) || !Number.isFinite(Date.parse(event.receivedAt))) errors.push('valid receivedAt required');
  if (!/^[a-f0-9]{64}$/.test(event.fromHash)) errors.push('salted sender hash required');
  if (!nonempty(event.text) || redactText(event.text) !== event.text) errors.push('redacted text required');
  if (event.draftReply !== null && (!nonempty(event.draftReply) || redactText(event.draftReply) !== event.draftReply)) errors.push('draftReply must be redacted text or null');
  if (!event.classification || typeof event.classification.feedback !== 'boolean' ||
    !Array.isArray(event.classification.urgentReasons) || event.classification.urgentReasons.some(r => !['bug', 'billing', 'angry', 'public', 'legal'].includes(r))) errors.push('classification required');
  if (event.approval !== 'tim' || event.status !== 'pending-approval') errors.push('Tim approval required');
  const allowed = new Set(['schema', 'app', 'channel', 'kind', 'messageId', 'receivedAt', 'fromHash', 'text', 'classification', 'draftReply', 'approval', 'status']);
  if (Object.keys(event).some(k => !allowed.has(k))) errors.push('unexpected event fields');
  if (event.classification && Object.keys(event.classification).some(k => !['feedback', 'urgentReasons'].includes(k))) errors.push('unexpected classification fields');
  for (const key of ['app', 'channel', 'kind', 'messageId']) {
    if (typeof event[key] === 'string' && redactText(event[key]) !== event[key]) errors.push(`${key} contains contact data`);
  }
  return { errors };
}

export function buildEvent(input, config, { env = process.env } = {}) {
  if (!nonempty(env.CUSTOMER_VOICE_SALT)) throw new Error('CUSTOMER_VOICE_SALT required');
  if (!nonempty(input.from) || !nonempty(input.text)) throw new Error('sender and text required');
  const channel = config.customerVoice?.channels?.find(c => c.id === input.channel);
  const address = /<([^>]+)>/.exec(input.from)?.[1] ?? input.from;
  const event = {
    schema: EVENT_SCHEMA, app: config.app, channel: input.channel, kind: channel?.kind,
    messageId: input.messageId, receivedAt: input.receivedAt ?? new Date().toISOString(),
    fromHash: createHash('sha256').update(`${env.CUSTOMER_VOICE_SALT}\0${address.trim().toLowerCase()}`).digest('hex'),
    text: redactText(input.text),
    classification: { feedback: channel?.kind === 'chat' ? isFeedbackTurn(input.text) : true,
      urgentReasons: urgentReasons(input.text) },
    draftReply: input.draftReply == null ? null : redactText(input.draftReply),
    approval: 'tim', status: 'pending-approval',
  };
  const { errors } = validateEvent(event, config);
  if (errors.length) throw new Error(errors.join('; '));
  return event;
}

// Sends only to the internal approval sink. There is no customer-send API.
export async function postToSummer(event, { url, token, fetchImpl = globalThis.fetch, config } = {}) {
  if (!nonempty(url) || !nonempty(token)) throw new Error('Customer voice sink URL and token required');
  const target = new URL(url);
  if (target.protocol !== 'https:' || target.username || target.password) throw new Error('Customer voice sink must use HTTPS');
  // A built event is already channel-validated; config can revalidate at the sink boundary.
  config ??= { app: event?.app, customerVoice: { channels: [{ id: event?.channel, kind: event?.kind }] } };
  const { errors } = validateEvent(event, config);
  if (errors.length) throw new Error(errors.join('; '));
  const response = await fetchImpl(target.href, { method: 'POST', redirect: 'error',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(event), signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Customer voice sink failed: HTTP ${response.status}`);
  return { ok: true, status: response.status };
}
