import { digestOf } from '../judge/receipt.mjs';
import { archetypes, readBuyerSetting } from './personas.mjs';
import { holdoutHolds, RUBRIC_VERSION, readyFlag, THRESHOLDS } from './rubric.mjs';
import { validReceipt } from './store.mjs';
import { STRONG_MODEL } from '../judge/model.mjs';
export { readReceipts } from './store.mjs';

export const MIN_HOLDOUTS = 3;
export const MAX_AGE_DAYS = 3;

export function buyerReady({ subject, sha, receipts, cert, config, cwd = process.cwd(), wasReady = false,
  timYes = false, now = Date.now() }) {
  const reasons = [];
  const calibration = readBuyerSetting(cwd, config.buyer.calibration);
  if (!sha) reasons.push('no-sha');
  if (!subject) reasons.push('no-subject');
  const certAge = now - Date.parse(cert?.judgedAt);
  if (cert?.allow !== true || cert.sourceSha !== sha || cert.app !== config.app || !Number.isFinite(certAge) ||
      certAge < 0 || certAge > MAX_AGE_DAYS * 86_400_000) reasons.push('golden-path-cert-blocked-or-missing');
  const current = receipts.filter(row => validReceipt(row) && row.app === config.app && row.rubric === RUBRIC_VERSION && row.configDigest === digestOf(config));
  const fresh = row => { const age = now - Date.parse(row.at); return Number.isFinite(age) && age >= 0 && age <= MAX_AGE_DAYS * 86_400_000; };
  const latest = predicate => current.filter(predicate).sort((a, b) => String(a.at).localeCompare(String(b.at))).at(-1);
  const holdouts = calibration?.holdouts ?? [];
  const positives = calibration?.positiveCanaries ?? [];
  if (!Array.isArray(holdouts) || !Array.isArray(positives)) throw new Error('invalid calibration set');
  if (new Set(holdouts.map(row => row.id)).size < MIN_HOLDOUTS || holdouts.length !== new Set(holdouts.map(row => row.id)).size) reasons.push('calibration-insufficient-or-duplicate');
  if (!positives.length) reasons.push('calibration-no-positive-canary');
  if (new Set([...holdouts, ...positives].map(row => row.id)).size !== holdouts.length + positives.length ||
      holdouts.some(row => row.expect !== 'no_pay') || positives.some(row => row.expect !== 'pay')) reasons.push('calibration-invalid-expectations');
  for (const entry of [...holdouts, ...positives]) {
    const positive = positives.includes(entry);
    const row = latest(row => row.holdout === true && row.calibrationId === entry.id && row.expect === (positive ? 'pay' : 'no_pay'));
    if (!entry.id || !row || !fresh(row) || (positive ? row.verdict !== 'pay' || !strongPay(row) : !holdoutHolds(row))) {
      reasons.push(`calibration-${positive ? 'positive-missed' : 'failed'}:${entry.id}`);
    }
  }
  const controls = archetypes({ cwd, config }).filter(row => row.control === true);
  if (!controls.length) reasons.push('control-not-configured');
  for (const control of controls) {
    const row = latest(row => row.sha === sha && !row.holdout && row.persona?.control === true && row.persona.id === control.id);
    if (!row || !fresh(row) || !holdoutHolds(row)) reasons.push(`control-not-no-pay:${control.id}`);
  }
  const own = latest(row => row.sha === sha && !row.holdout && row.subject === subject && row.walkSubject === subject && row.persona?.control !== true);
  if (!own || !own.walkId || !fresh(own) || !strongPay(own) || !readyFlag(own, wasReady)) reasons.push('no-fresh-own-strong-pay-walk');
  const machineReady = reasons.length === 0;
  if (timYes !== true) reasons.push('tim-approval-required');
  return { ready: machineReady && timYes === true, machineReady, next: machineReady ? 'ask-tim' : 'keep-cooking', reasons, receipt: own?.id ?? null };
}

function strongPay(row) {
  const strong = row.strong;
  if (!strong || strong.model !== STRONG_MODEL || strong.verdict !== 'pay' || row.verdict !== 'pay' || !Number.isFinite(row.pPay) || row.pPay < THRESHOLDS.pay ||
      row.pPay !== strong.pPay || !Array.isArray(strong.failures) || strong.failures.length ||
      !Array.isArray(strong.sampleP) || strong.sampleP.length < THRESHOLDS.minCoherentSamples ||
      strong.sampleP.length !== strong.coherentSamples || strong.samples !== strong.coherentSamples) return false;
  const ps = strong.sampleP.map(sample => sample.p).sort((a, b) => a - b);
  const mid = Math.floor(ps.length / 2);
  const median = ps.length % 2 ? ps[mid] : (ps[mid - 1] + ps[mid]) / 2;
  return strong.sampleP.every(sample => sample.coherent === true && Number.isFinite(sample.p) && sample.p >= THRESHOLDS.payFloor && sample.p <= 1 &&
      Number.isFinite(sample.p3x) && sample.p3x >= 0 && sample.p3x <= sample.raw && sample.raw <= 1) &&
    Math.round(median * 1000) / 1000 === row.pPay && Math.max(...ps) - Math.min(...ps) <= THRESHOLDS.maxSpread;
}
