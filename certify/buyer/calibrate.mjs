import { isAbsolute, resolve } from 'node:path';
import { archetypes, readBuyerSetting } from './personas.mjs';
import { evaluate } from './run.mjs';
import { holdoutHolds } from './rubric.mjs';
import { MIN_HOLDOUTS } from './gate.mjs';

export async function calibrate({ cwd = process.cwd(), config, walk, sha, samples = 3, state,
  evaluateRun = evaluate, ...deps }) {
  const set = readBuyerSetting(cwd, config.buyer.calibration);
  const people = archetypes({ cwd, config });
  const holdouts = set?.holdouts ?? [], positives = set?.positiveCanaries ?? [];
  if (!Array.isArray(holdouts) || !Array.isArray(positives)) throw new Error('invalid calibration set');
  const entries = [...holdouts, ...positives];
  if (entries.some(entry =>
    !entry.id || !entry.walk || !['pay', 'no_pay'].includes(entry.expect)) ||
    holdouts.some(entry => entry.expect !== 'no_pay') || positives.some(entry => entry.expect !== 'pay') ||
    new Set(entries.map(entry => entry.id)).size !== entries.length) throw new Error('invalid calibration set');
  const checks = [], receipts = [];
  for (const entry of entries) {
    try {
      const receipt = await evaluateRun({ cwd, config, samples, state, ...deps,
        walk: isAbsolute(entry.walk) ? entry.walk : resolve(cwd, entry.walk),
        persona: entry.persona ?? people.find(row => !row.control)?.id,
        holdout: true, expect: entry.expect, calibrationId: entry.id });
      receipts.push(receipt);
      checks.push({ id: entry.id, status: receipt.holdoutHolds === true &&
        (entry.expect === 'pay' ? receipt.verdict === 'pay' : holdoutHolds(receipt)) ? 'passed' : 'failed' });
    } catch { checks.push({ id: entry.id, status: 'failed' }); }
  }
  const controls = people.filter(row => row.control === true);
  for (const control of controls) {
    try {
      const source = set.control?.walk ?? walk;
      if (!source) throw new Error('control walk required');
      const receipt = await evaluateRun({ cwd, config, samples, state, sha, ...deps,
        walk: resolve(cwd, source), persona: control.id, holdout: false });
      receipts.push(receipt);
      checks.push({ id: control.id, status: holdoutHolds(receipt) && receipt.sha === sha ? 'passed' : 'failed' });
    } catch { checks.push({ id: control.id, status: 'failed' }); }
  }
  checks.push({ id: 'calibration-coverage', status: holdouts.length >= MIN_HOLDOUTS && positives.length > 0 && controls.length > 0 ? 'passed' : 'failed' });
  return { status: checks.length > 0 && checks.every(check => check.status === 'passed') ? 'passed' : 'failed', checks, receipts };
}
