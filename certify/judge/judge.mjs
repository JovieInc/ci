import { rmSync } from 'node:fs';
import { ingestWalk } from '../buyer/ingest.mjs';
import { contaminated } from '../buyer/judge.mjs';
import { requiredStages } from './artifacts.mjs';
import { digestOf } from './receipt.mjs';
import { buildClaudeArgs, parseEnvelope, runClaude, STRONG_MODEL } from './model.mjs';
import { buildJudgePrompt, buildJudgeSchema, parseJudgeOutput, RUBRIC_VERSION, runVerdict } from './rubric.mjs';

export async function judgeWalk({ runDir, config, run = runClaude, model = STRONG_MODEL,
  failureDetector, ingest = ingestWalk, now = Date.now, timeoutMs = 900_000 }) {
  // The runtime implementation is supplied by the shared verifier, never a private regex list.
  const detect = failureDetector ?? (await import('../lib/outcome-verifier.mjs')).detectFailureSurface;
  const walk = ingest(runDir);
  try {
    const surface = walk.surface ?? 'web';
    const stages = requiredStages(config, surface);
    const checks = [];
    let costUsd = 0;
    for (const step of walk.steps) {
      const stage = stages.find(row => row.id === step.stageId);
      if (!stage) { checks.push({ stepId: step.stepId, stageId: step.stageId, verdict: 'fail', reasons: ['unknown stage'] }); continue; }
      let result;
      try {
        const failure = detect(step.text);
        if (failure) result = { verdict: 'fail', reasons: [`DOM failure surface: ${failure.kind}`] };
        else {
          const frames = [];
          for (const image of step.images) {
            const prompt = buildJudgePrompt({ stage, step, image });
            const envelope = parseEnvelope(await run(buildClaudeArgs({ model, prompt, schema: buildJudgeSchema(), imageDir: walk.frameDir }), walk.frameDir, timeoutMs));
            costUsd += envelope.costUsd;
            if (contaminated(envelope.output, prompt, config).length) throw new Error('context contamination');
            frames.push(parseJudgeOutput(envelope.output));
          }
          result = { verdict: runVerdict(frames), reasons: frames.flatMap(frame => frame.reasons) };
          if (!frames.length) result.reasons = ['missing frames'];
        }
      } catch { result = { verdict: 'abstain', reasons: ['model or deterministic check failed'] }; }
      checks.push({ stepId: step.stepId, stageId: stage.id, ...result });
    }
    const perStage = stages.map(stage => {
      const rows = checks.filter(check => check.stageId === stage.id);
      return { stageId: stage.id, verdict: rows.length ? runVerdict(rows) : 'fail',
        reasons: rows.length ? rows.flatMap(row => row.reasons) : ['required stage was not recorded'] };
    });
    if (walk.status !== 'passed' || walk.app !== config.app) checks.push({ verdict: 'fail', reasons: ['walk failed or app identity mismatched'] });
    return { schema: 'company.walk-judgement/v1', app: config.app, surface, walkId: walk.walkId,
      sourceSha: walk.sourceSha, judgedAt: new Date(now()).toISOString(), rubricVersion: RUBRIC_VERSION,
      configDigest: digestOf(config), model, verdict: runVerdict([...perStage, ...checks]), stages: perStage, steps: checks, costUsd };
  } finally { rmSync(walk.frameDir, { recursive: true, force: true }); }
}
