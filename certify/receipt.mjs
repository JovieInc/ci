import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { foldVerdict } from './lib/outcome-verifier.mjs';

export const RECEIPT_SCHEMA = 'company.cert-receipt/v1';
const nonempty = x => typeof x === 'string' && x.trim().length > 0;
const evidencePresent = x => nonempty(x) || (x && typeof x === 'object' && Object.keys(x).length > 0);
export function canonicalJSON(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort()
    .filter(k => value[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonicalJSON(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function receiptDigest(value) {
  return createHash('sha256').update(canonicalJSON(value)).digest('hex');
}

export function receiptChecks(receipt, config) {
  const checks = [];
  const add = (id, pass) => checks.push({ id, status: pass === true ? 'passed' : 'blocked' });
  add('identity', receipt.schema === RECEIPT_SCHEMA && nonempty(config?.app) && receipt.app === config.app &&
    /^[a-f0-9]{40,64}$/i.test(receipt.sha) && nonempty(receipt.runId));
  add('timestamps', Number.isFinite(Date.parse(receipt.startedAt)) &&
    Date.parse(receipt.finishedAt) >= Date.parse(receipt.startedAt));
  const expected = config?.goldenPath?.stages ?? [];
  const stages = receipt.stages ?? [];
  add('stages-present', expected.length > 0 && stages.length === expected.length &&
    new Set(expected.map(s => s.id)).size === expected.length);
  for (const stage of expected) {
    const matches = stages.filter(s => s.id === stage.id);
    const row = matches[0];
    add(`stage:${stage.id}`, matches.length === 1 && row.kind === stage.kind && row.verdict === 'passed' &&
      Number.isFinite(row.tStartMs) && row.tStartMs >= 0 && Number.isFinite(row.tEndMs) &&
      row.tEndMs >= row.tStartMs && evidencePresent(row.evidence));
  }
  add('privacy', receipt.privacy?.pass === true && /^[a-f0-9]{64}$/.test(receipt.privacy?.digest));
  const b = receipt.buyer;
  add('buyer-recorded', Array.isArray(b?.verdicts) && b.verdicts.length > 0 &&
    Array.from(b.verdicts).every(v => ['pay', 'no_pay'].includes(typeof v === 'string' ? v : v?.verdict)));
  add('holdouts', Number.isInteger(b?.calibration?.holdoutsNoPay) && b.calibration.holdoutsNoPay >= 3);
  add('off-icp-control', b?.calibration?.controlNoPay === true);
  const positiveCanaries = config?.calibration?.positiveCanaries ?? config?.buyer?.positiveCanaries ?? [];
  add('positive-calibration-config', config?.calibration !== null &&
    (config?.calibration === undefined || (typeof config.calibration === 'object' && !Array.isArray(config.calibration))) &&
    Array.isArray(positiveCanaries));
  if (positiveCanaries.length > 0) {
    add('positive-canary', b?.calibration?.positiveCanary === true);
    add('buyer-ready', b?.gate === 'ready' && b.verdicts.some(v => (typeof v === 'string' ? v : v?.verdict) === 'pay'));
  }
  const channels = config?.customerVoice?.channels ?? [];
  add('voice', channels.length > 0 && channels.every(ch => nonempty(ch.id) && receipt.voice?.channelsCovered?.includes(ch.id)));
  add('waste', nonempty(config?.waste?.appId) && receipt.waste?.appId === config.waste.appId);
  add('capacity', nonempty(config?.capacity?.appId) && receipt.capacity?.appId === config.capacity.appId);
  return checks;
}

export function buildReceipt(config, { walk = {}, buyer = {}, privacy = {}, voice = walk.voice ?? {},
  sha = walk.sha, runId = walk.runId ?? walk.run_id, startedAt = walk.startedAt ?? walk.started_at,
  finishedAt = walk.finishedAt ?? walk.finished_at } = {}) {
  const privacyPass = privacy.schema === 'company.privacy-record/v1' && privacy.app === config.app &&
    privacy.pass === true && privacy.controls_ok === true && privacy.controls?.length > 0 &&
    privacy.controls.every(c => c.ok === true) && privacy.results?.length > 0 &&
    privacy.results.every(r => r.status === 'pass');
  const receipt = {
    schema: RECEIPT_SCHEMA, app: config.app, sha, runId, startedAt, finishedAt,
    stages: (walk.stages ?? []).map(s => ({ id: s.id, kind: s.kind, verdict: s.verdict,
      tStartMs: s.tStartMs, tEndMs: s.tEndMs, evidence: s.evidence })),
    buyer: { verdicts: buyer.verdicts ?? [], calibration: {
      holdoutsNoPay: buyer.calibration?.holdoutsNoPay ?? 0,
      controlNoPay: buyer.calibration?.controlNoPay === true,
      positiveCanary: buyer.calibration?.positiveCanary === true,
    }, gate: buyer.gate ?? 'blocked' },
    privacy: { digest: receiptDigest(privacy), pass: privacyPass === true },
    voice: { channelsCovered: voice.channelsCovered ?? [] },
    waste: { appId: config.waste?.appId }, capacity: { appId: config.capacity?.appId },
    verdict: 'blocked',
  };
  receipt.checks = receiptChecks(receipt, config);
  return receipt;
}

function unsigned(receipt) {
  const { signature, ...body } = receipt;
  return body;
}
export function signReceipt(receipt, { config, cwd = process.cwd(), key = process.env.CERT_RECEIPT_SIGNING_KEY } = {}) {
  if (!nonempty(key)) throw new Error('CERT_RECEIPT_SIGNING_KEY required');
  if (!config) throw new Error('App config required when signing');
  if (!config.calibration && typeof config.buyer?.calibration === 'string') {
    config = { ...config, calibration: JSON.parse(readFileSync(resolve(cwd, config.buyer.calibration), 'utf8')) };
  }
  const body = structuredClone(unsigned(receipt));
  body.checks = receiptChecks(body, config);
  body.verdict = foldVerdict(body.checks.map(c => c.status)) === 'passed' ? 'certified' : 'blocked';
  return { ...body, signature: { algorithm: 'hmac-sha256',
    value: createHmac('sha256', key).update(canonicalJSON(body)).digest('hex') } };
}
export function verifyReceipt(receipt, { key = process.env.CERT_RECEIPT_SIGNING_KEY, config } = {}) {
  if (!nonempty(key) || receipt?.signature?.algorithm !== 'hmac-sha256' ||
    !/^[a-f0-9]{64}$/.test(receipt.signature.value)) return false;
  const expected = createHmac('sha256', key).update(canonicalJSON(unsigned(receipt))).digest();
  if (!timingSafeEqual(expected, Buffer.from(receipt.signature.value, 'hex'))) return false;
  if (receipt.schema !== RECEIPT_SCHEMA || !['certified', 'blocked'].includes(receipt.verdict)) return false;
  if (receipt.verdict === 'certified') {
    const checks = config ? receiptChecks(receipt, config) : receipt.checks;
    if (!Array.isArray(checks) || foldVerdict(checks.map(c => c.status)) !== 'passed') return false;
  }
  return true;
}

export async function publishReceipt(receipt, { repo, token, key = process.env.CERT_RECEIPT_SIGNING_KEY,
  fetchImpl = globalThis.fetch } = {}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? '') || !nonempty(token)) throw new Error('GitHub repo and token required');
  if (!verifyReceipt(receipt, { key })) throw new Error('Valid signed receipt required');
  const base = `https://api.github.com/repos/${repo}/deployments`;
  async function post(url, body) {
    const res = await fetchImpl(url, { method: 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`GitHub certification publish failed: HTTP ${res.status}`);
    return res.json();
  }
  const deployment = await post(base, { environment: 'certification', ref: receipt.sha,
    auto_merge: false, required_contexts: [], production_environment: false,
    description: `Certification ${receipt.app}: ${receipt.verdict}`.slice(0, 140),
    payload: { schema: RECEIPT_SCHEMA, digest: receiptDigest(receipt), app: receipt.app,
      verdict: receipt.verdict, runId: receipt.runId, receipt } });
  if (!Number.isSafeInteger(deployment.id) || deployment.id <= 0) throw new Error('GitHub deployment id missing');
  const status = await post(`${base}/${deployment.id}/statuses`, {
    state: receipt.verdict === 'certified' ? 'success' : 'failure', auto_inactive: false,
    description: `${receipt.app}: ${receipt.verdict} (${receipt.runId})`.slice(0, 140),
  });
  return { deployment, status };
}
