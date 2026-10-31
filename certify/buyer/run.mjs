import { rmSync } from 'node:fs';
import { ingestWalk } from './ingest.mjs';
import { judgeBuyer } from './judge.mjs';
import { loadPersona } from './personas.mjs';
import { readOutcome } from './outcome.mjs';
import { aggregateSamples, assertNoIdentity, redact, RUBRIC_VERSION, RECEIPT_SCHEMA, holdoutHolds, fileableObjections } from './rubric.mjs';
import { runScreen } from './screen.mjs';
import { sealReceipt, stateDir, writeReceipt } from './store.mjs';
import { digestOf } from '../judge/receipt.mjs';

// Emits local proposed fixes only; no issue, message or user invitation is sent.
export function factorySignal(receipt, objection) {
  return { schema: 'company.buyer-fix/v1',
    fingerprint: digestOf({ app: receipt.app, stage: objection.stageId ?? objection.stepId, category: objection.category }),
    title: `Buyer objection: ${objection.category} at ${objection.stepId}`,
    problem: objection.text, evidence: { receipt: receipt.id, sourceSha: receipt.sha, tSec: objection.tSec },
    acceptance: ['Make a concrete product, proof, offer or flow change.', 'Add a negative control and re-record every affected stage.'] };
}

export async function evaluate({ cwd = process.cwd(), config, walk: source, persona: ref,
  sha, samples = 3, holdout = false, expect = 'no_pay', calibrationId,
  state = stateDir(config), ingest = ingestWalk, run, screenCall, now = Date.now }) {
  const started = now();
  const persona = loadPersona({ cwd, config, ref });
  const outcome = readOutcome({ cwd, config });
  const walk = ingest(source);
  try {
    if (!walk.steps.length) throw new Error('walk has no judgeable steps');
    if (walk.app && walk.app !== config.app) throw new Error('walk belongs to another app');
    if (sha && walk.sourceSha && sha !== walk.sourceSha) throw new Error('walk SHA differs from requested SHA');
    const screen = await runScreen(walk.steps, { call: screenCall });
    const screenNo = screen.status === 'evaluated' && screen.blockers.length > 0;
    let judged, strong = null, verdict = screenNo ? 'no_pay' : 'abstain';
    if (!screenNo) {
      judged = await judgeBuyer({ persona, outcome, walk, config, samples, run });
      const aggregate = aggregateSamples(judged.samples);
      if (judged.failures.length) { aggregate.verdict = 'abstain'; aggregate.reason = 'one or more model samples failed'; }
      strong = { ...aggregate, model: judged.model, failures: judged.failures, costUsd: judged.costUsd,
        sampleP: judged.samples.map(sample => ({ p: sample.pPay, p3x: sample.pPay3x, raw: sample.rawPPay,
          coherent: sample.coherent, capped: sample.capped })) };
      verdict = strong.verdict;
    }
    if (!holdout && (walk.status !== 'passed' || !walk.sourceSha)) verdict = 'abstain';
    const clean = value => {
      if (typeof value === 'string') return redact(value, persona.identityTokens);
      if (Array.isArray(value)) return value.map(clean);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clean(child)]));
      return value;
    };
    const receipt = clean({ schema: RECEIPT_SCHEMA, app: config.app, configDigest: digestOf(config),
      rubric: RUBRIC_VERSION, at: new Date(now()).toISOString(), sha: walk.sourceSha ?? sha ?? null,
      subject: persona.id, persona: { id: persona.id, tier: persona.tier, control: persona.control === true },
      walkSubject: walk.subjectId, walkId: walk.walkId ?? null, holdout, calibrationId: calibrationId ?? null,
      expect: holdout ? expect : null, outcome, verdict, pPay: strong?.pPay ?? (screenNo ? 0 : null),
      strong, screen, objections: strong?.objections ?? screen.blockers,
      flipToPay: strong?.flipToPay ?? [], valueEvidence: strong?.valueEvidence ?? [],
      cost: { screenUsd: screen.usd, strongUsd: judged?.costUsd ?? 0, totalUsd: screen.usd + (judged?.costUsd ?? 0), durationSec: (now() - started) / 1000 } });
    receipt.holdoutHolds = holdout && (expect === 'pay' ? verdict === 'pay' : holdoutHolds(receipt));
    assertNoIdentity(JSON.stringify(receipt), persona.identityTokens);
    const sealed = sealReceipt(receipt);
    writeReceipt(sealed, { cwd, config, state });
    return sealed;
  } finally { rmSync(walk.frameDir, { recursive: true, force: true }); }
}

export function fixProposals(receipt) {
  return receipt.holdout || receipt.persona.control || receipt.verdict === 'pay' ? [] :
    fileableObjections(receipt).map(objection => factorySignal(receipt, objection));
}
