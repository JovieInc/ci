import { buildClaudeArgs, parseEnvelope, runClaude, STRONG_MODEL } from '../judge/model.mjs';
import { buildBuyerPrompt, buildBuyerSchema, parseBuyerSample } from './rubric.mjs';
export { STRONG_MODEL } from '../judge/model.mjs';
export const DEFAULT_SAMPLES = 3;
export const CONTAMINATION_MARKERS = Object.freeze(['$300', '300/mo', 'ovie', 'summer', 'gbrain', 'premium pricing', 'icp']);

export function contaminated(raw, prompt, config = {}) {
  const out = JSON.stringify(raw ?? '').toLowerCase();
  const input = prompt.toLowerCase();
  const has = (text, word) => new RegExp(`(?:^|[^a-z0-9])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[^a-z0-9])`, 'u').test(text);
  return [...new Set([...CONTAMINATION_MARKERS, ...(config.buyer?.contaminationMarkers ?? [])])]
    .map(word => word.toLowerCase()).filter(word => word && has(out, word) && !has(input, word));
}

export async function judgeBuyer({ persona, outcome, walk, config, samples = DEFAULT_SAMPLES,
  model = STRONG_MODEL, timeoutMs = 900_000, run = runClaude }) {
  if (!Number.isInteger(samples) || samples < 2 || samples > 10) throw new Error('samples must be an integer from 2 to 10');
  const prompt = buildBuyerPrompt({ persona, outcome, steps: walk.steps, standIn: walk.subjectId !== persona.id });
  const args = buildClaudeArgs({ model, prompt, schema: buildBuyerSchema(walk.steps.map(step => step.stepId)), imageDir: walk.frameDir });
  const results = await Promise.allSettled(Array.from({ length: samples }, () => run(args, walk.frameDir, timeoutMs)));
  const parsed = [], failures = [];
  let costUsd = 0;
  for (const result of results) {
    if (result.status === 'rejected') { failures.push('model call failed'); continue; }
    try {
      const envelope = parseEnvelope(result.value);
      costUsd += envelope.costUsd;
      if (contaminated(envelope.output, prompt, config).length) throw new Error('context contamination');
      parsed.push(parseBuyerSample(envelope.output, walk.steps));
    } catch { failures.push('invalid or contaminated model sample'); }
  }
  return { model, samples: parsed, failures, costUsd };
}
