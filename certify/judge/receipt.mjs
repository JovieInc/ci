import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { requiredStages } from './artifacts.mjs';
import { RUBRIC_VERSION, runVerdict } from './rubric.mjs';
import { STRONG_MODEL } from './model.mjs';

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).filter(key => value[key] !== undefined).sort()
    .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const digestOf = value => createHash('sha256').update(canonical(value)).digest('hex');

export function signReceipt(receipt, key = process.env.CERT_JUDGE_SIGNING_KEY, keyId = process.env.CERT_JUDGE_SIGNING_KEY_ID ?? 'default') {
  const { signature, digest, ...body } = receipt;
  const next = { ...body, digest: digestOf(body) };
  return { ...next, signature: key ? { alg: 'hmac-sha256', keyId,
    value: createHmac('sha256', key).update(next.digest).digest('hex') } : null };
}

export function verifyReceiptSignature(receipt, key = process.env.CERT_JUDGE_SIGNING_KEY) {
  try {
    if (!key || receipt.signature?.alg !== 'hmac-sha256') return false;
    const { signature, digest, ...body } = receipt;
    if (digestOf(body) !== digest) return false;
    const expected = Buffer.from(createHmac('sha256', key).update(digest).digest('hex'));
    const actual = Buffer.from(String(signature.value));
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch { return false; }
}

export function gateDecision({ receipt, config, sourceSha, now = Date.now(), maxAgeDays = 3,
  signingKey = process.env.CERT_JUDGE_SIGNING_KEY, model = STRONG_MODEL }) {
  const reasons = [];
  if (!receipt) return { allow: false, reasons: ['receipt-missing'] };
  if (!verifyReceiptSignature(receipt, signingKey)) reasons.push('signature-invalid-or-missing');
  if (receipt.schema !== 'company.walk-judgement/v1' || receipt.app !== config.app) reasons.push('wrong-schema-or-app');
  if (!config.goldenPath?.flows?.[receipt.surface]) reasons.push('unknown-surface');
  if (!sourceSha || !receipt.sourceSha || receipt.sourceSha !== sourceSha) reasons.push('source-sha-mismatch-or-missing');
  if (receipt.rubricVersion !== RUBRIC_VERSION || receipt.model !== model || receipt.configDigest !== digestOf(config)) reasons.push('stale-rubric-model-or-config');
  const age = now - Date.parse(receipt.judgedAt);
  if (!Number.isFinite(age) || age < 0 || age > maxAgeDays * 86_400_000) reasons.push('receipt-stale-or-invalid-time');
  try {
    const stages = requiredStages(config, receipt.surface);
    const rows = receipt.stages;
    if (!Array.isArray(rows) || rows.length !== stages.length ||
        stages.some(stage => rows.filter(row => row.stageId === stage.id).length !== 1) || runVerdict(rows) !== 'pass') reasons.push('stage-checks-not-passed');
    if (!Array.isArray(receipt.steps) || runVerdict(receipt.steps) !== 'pass' ||
        stages.some(stage => !receipt.steps.some(step => step.stageId === stage.id))) reasons.push('step-checks-not-passed');
  } catch { reasons.push('invalid-stages'); }
  if (receipt.verdict !== 'pass' || !receipt.walkId) reasons.push('judge-not-passed');
  return { allow: reasons.length === 0, reasons, sourceSha: receipt.sourceSha,
    app: receipt.app, judgedAt: receipt.judgedAt, digest: receipt.digest };
}
