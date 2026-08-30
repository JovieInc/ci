import { appendFileSync } from 'node:fs';
import {
  aggregateShards,
  remediationDecision,
  shadowFailFastDecision,
  timingSampleEligibility,
  validateReceipt,
} from '../../lib/ci-shard-contract.mjs';

const payload = JSON.parse(process.env.INPUT_PAYLOAD ?? '{}');
const operation = process.env.INPUT_OPERATION;
const operations = {
  validate: () => validateReceipt(payload.receipt, payload.identity),
  aggregate: () => aggregateShards(payload),
  shadow: () =>
    shadowFailFastDecision(payload.receipt, {
      ...payload.options,
      expectedIdentity: payload.identity,
    }),
  timing: () =>
    timingSampleEligibility(payload.receipt, {
      ...payload.options,
      expectedIdentity: payload.identity,
    }),
  remediation: () =>
    remediationDecision(payload.receipt, payload.consumedKeys, payload.identity),
};
if (!operations[operation]) throw new Error(`unknown operation: ${operation}`);
const result = operations[operation]();

function partialMatch(actual, expected) {
  if (expected === null || typeof expected !== 'object')
    return Object.is(actual, expected);
  return Object.entries(expected).every(([key, value]) =>
    partialMatch(actual?.[key], value)
  );
}

const expectedText = process.env.INPUT_EXPECT?.trim();
if (expectedText && !partialMatch(result, JSON.parse(expectedText))) {
  throw new Error(
    `contract expectation failed: ${JSON.stringify({ result, expected: JSON.parse(expectedText) })}`
  );
}
appendFileSync(process.env.GITHUB_OUTPUT, `result-json=${JSON.stringify(result)}\n`);
console.log(JSON.stringify(result));
