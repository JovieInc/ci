export const SCREEN_VERSION = 'company.buyer-screen/v1';
export const SCREEN_QUESTIONS = Object.freeze({
  own_data: 'This account shows personal data rather than a placeholder or generic example.',
  concrete_benefit: 'A concrete personal result is visible and backed by the account data.',
  placeholder_or_jargon: 'Placeholder text, undefined values or internal pipeline jargon are visible.',
  error_or_dead_end: 'An error, blank screen or dead end is visible.',
  paid_ask_while_waitlisted: 'Payment is requested while the account is waitlisted or not admitted.',
});
export const SCREEN_THRESHOLDS = Object.freeze({ placeholder_or_jargon: 0.6, error_or_dead_end: 0.6, paid_ask_while_waitlisted: 0.6 });
export const DOM_CHECKS = Object.freeze({
  placeholder_or_jargon: /\byour-handle\b|lorem ipsum|\bundefined\b|\bnull\b|\(source: [a-z]+\)|\{\{|\bTODO\b/iu,
  error_or_dead_end: /something went wrong|internal server error|\b(?:404|500)\b.*(?:error|not found)|application error/iu,
});
export function domWaitlistPaid(text) {
  return /waitlist|early list|on the list|when a spot opens|not yet admitted|once capacity opens/iu.test(text) &&
    /(?:[$€£]|USD|EUR|GBP)\s?\d+|upgrade|checkout|subscribe/iu.test(text);
}
export function domConfirms(check, text) {
  if (!text) return false;
  return check === 'paid_ask_while_waitlisted' ? domWaitlistPaid(text) : DOM_CHECKS[check]?.test(text) === true;
}
export function summarizeScreen(steps, answersByStep) {
  const blockers = [];
  const perStep = steps.map(step => {
    const p = Object.fromEntries(Object.keys(SCREEN_QUESTIONS).map(id => {
      const value = answersByStep[step.stepId]?.[id]?.noul;
      return [id, Number.isFinite(value) && value >= 0 && value <= 1 ? value : null];
    }));
    for (const [check, threshold] of Object.entries(SCREEN_THRESHOLDS)) {
      if (p[check] !== null && p[check] >= threshold && domConfirms(check, step.text)) {
        blockers.push({ check, stepId: step.stepId, tSec: step.tSec, category: check === 'paid_ask_while_waitlisted' ? 'contradiction' : 'defect', severity: 'blocker', p: p[check] });
      }
    }
    return { stepId: step.stepId, tSec: step.tSec, p };
  });
  return { version: SCREEN_VERSION, perStep, blockers,
    complete: perStep.length > 0 && perStep.every(row => Object.values(row.p).every(value => Number.isFinite(value))) };
}
// Optional app-supplied cheap transport; an outage always routes to the strong judge.
export async function runScreen(steps, { call } = {}) {
  if (!call) return { status: 'not-configured', blockers: [], usd: 0 };
  let usd = 0;
  try {
    const answers = {};
    for (const step of steps) {
      const result = await call({ step, questions: SCREEN_QUESTIONS });
      answers[step.stepId] = result.answers;
      if (!Number.isFinite(result.usd) || result.usd < 0) throw new Error('invalid screen cost');
      usd += result.usd;
    }
    return { status: 'evaluated', ...summarizeScreen(steps, answers), usd };
  } catch { return { status: 'provider-error', blockers: [], error: 'screen unavailable', usd }; }
}
