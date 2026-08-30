import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aggregateShards,
  digest,
  remediationDecision,
  SCHEMA,
  shadowFailFastDecision,
  timingSampleEligibility,
  validateReceipt,
} from '../lib/ci-shard-contract.mjs';

const identity = {
  repository: 'JovieInc/Jovie',
  headSha: 'a'.repeat(40),
  baseSha: 'b'.repeat(40),
  mergeGroupSha: 'c'.repeat(40),
  runId: '123',
  attempt: 1,
  selectorHash: digest('selector'),
  inventoryHash: digest(['a.test.ts', 'b.test.ts']),
  policyVersion: digest('policy-v1'),
  adapterVersion: digest('adapter-v1'),
  environmentHash: digest('ubuntu-24.04'),
};
const receipt = ({
  index = 1,
  total = 2,
  state = 'passed',
  planned = ['a.test.ts'],
  executed = planned,
  outcome = {},
  identityOverride = {},
} = {}) => ({
  schema: SCHEMA,
  identity: { ...identity, ...identityOverride },
  shard: { index, total },
  inventory: { planned, executed },
  outcome: { state, ...outcome },
});
const plan = [
  { id: '1/2', selected: true, tests: ['a.test.ts'] },
  { id: '2/2', selected: true, tests: ['b.test.ts'] },
];

test('green: exact inventory aggregation passes', () => {
  const result = aggregateShards({
    identity,
    plan,
    receipts: [
      receipt(),
      receipt({ index: 2, planned: ['b.test.ts'] }),
    ],
  });
  assert.deepEqual(result, {
    status: 'green',
    green: true,
    evidenceComplete: true,
    errors: [],
  });
});

test('red: missing receipts and canceled siblings never aggregate green', () => {
  assert.equal(
    aggregateShards({ identity, plan, receipts: [receipt()] }).status,
    'indeterminate'
  );
  const canceled = receipt({
    index: 2,
    planned: ['b.test.ts'],
    executed: [],
    state: 'canceled_by_deterministic',
    outcome: {
      triggerFingerprint: 'test_assertion:a:assertion',
      cancellationReason: 'validated deterministic sibling',
    },
  });
  assert.equal(
    aggregateShards({ identity, plan, receipts: [receipt(), canceled] }).green,
    false
  );
});

test('green contract: a typed cancellation remains deterministically red', () => {
  const fingerprint = 'test_assertion:a:assertion';
  const deterministic = receipt({
    state: 'deterministic_failure',
    executed: [],
    outcome: {
      failureClass: 'test_assertion',
      fingerprint,
      logsUrl: 'https://github.com/example/log',
      artifactUrl: 'https://github.com/example/artifact',
    },
  });
  const canceled = receipt({
    index: 2,
    planned: ['b.test.ts'],
    executed: [],
    state: 'canceled_by_deterministic',
    outcome: {
      triggerFingerprint: fingerprint,
      cancellationReason: 'validated deterministic sibling',
    },
  });
  assert.equal(
    aggregateShards({ identity, plan, receipts: [deterministic, canceled] })
      .status,
    'deterministic_red'
  );
});

test('red: duplicate inventory and stale identity fail closed', () => {
  const duplicatePlan = [
    ...plan,
    { id: '3/3', selected: true, tests: ['a.test.ts'] },
  ];
  assert.ok(
    aggregateShards({ identity, plan: duplicatePlan, receipts: [] }).errors.includes(
      'duplicate_planned_test'
    )
  );
  const stale = receipt({ identityOverride: { headSha: 'd'.repeat(40) } });
  assert.ok(validateReceipt(stale, identity).errors.includes('stale.headSha'));
});

test('red: infrastructure cannot be mislabeled deterministic', () => {
  const invalid = receipt({
    state: 'deterministic_failure',
    executed: [],
    outcome: {
      failureClass: 'provider_capacity',
      fingerprint: 'provider_capacity:runner',
      logsUrl: 'https://github.com/example/log',
      artifactUrl: 'https://github.com/example/artifact',
    },
  });
  assert.equal(validateReceipt(invalid).valid, false);
  assert.equal(shadowFailFastDecision(invalid).wouldCancel, false);
  const transient = receipt({
    state: 'transient_failure',
    executed: [],
    outcome: {
      failureClass: 'provider_capacity',
      fingerprint: 'provider_capacity:runner',
      logsUrl: 'https://github.com/example/log',
      artifactUrl: 'https://github.com/example/artifact',
    },
  });
  assert.equal(
    aggregateShards({
      identity,
      plan,
      receipts: [
        transient,
        receipt({ index: 2, planned: ['b.test.ts'] }),
      ],
    }).status,
    'transient_blocked'
  );
});

test('red: cancellation cannot occur before actionable evidence', () => {
  const missingEvidence = receipt({
    state: 'deterministic_failure',
    executed: [],
    outcome: {
      failureClass: 'test_assertion',
      fingerprint: 'test_assertion:a',
    },
  });
  assert.equal(shadowFailFastDecision(missingEvidence).wouldCancel, false);
});

test('red: nondeterministic and retried attempts cannot tune topology', () => {
  const transient = receipt({
    state: 'transient_failure',
    executed: [],
    outcome: {
      failureClass: 'timeout',
      fingerprint: 'timeout:test-a',
      logsUrl: 'https://github.com/example/log',
      artifactUrl: 'https://github.com/example/artifact',
    },
  });
  assert.equal(
    timingSampleEligibility(transient, { cleanSamplesForFingerprint: 5 }).eligible,
    false
  );
  const retriedPass = receipt({ outcome: { retryOf: 'timeout:test-a' } });
  assert.equal(
    timingSampleEligibility(retriedPass, { cleanSamplesForFingerprint: 5 }).eligible,
    false
  );
});

test('green: deterministic evidence supports immediate or diagnostic-quorum shadow decisions', () => {
  const deterministic = receipt({
    state: 'deterministic_failure',
    executed: [],
    outcome: {
      failureClass: 'test_assertion',
      fingerprint: 'test_assertion:a:assertion',
      logsUrl: 'https://github.com/example/log',
      artifactUrl: 'https://github.com/example/artifact',
    },
  });
  assert.deepEqual(shadowFailFastDecision(deterministic), {
    wouldCancel: true,
    boundedRetry: 0,
    retainDiagnosticSiblings: 0,
    reason: 'validated_deterministic_fingerprint',
  });
  assert.equal(
    shadowFailFastDecision(deterministic, {
      mode: 'diagnostic_quorum',
      diagnosticQuorum: 2,
    }).retainDiagnosticSiblings,
    2
  );
});

test('green: transient retry is bounded and remediation is one-shot', () => {
  const transient = receipt({
    state: 'transient_failure',
    executed: [],
    outcome: {
      failureClass: 'network',
      fingerprint: 'network:reset',
      logsUrl: 'https://github.com/example/log',
      artifactUrl: 'https://github.com/example/artifact',
    },
  });
  assert.equal(shadowFailFastDecision(transient).boundedRetry, 1);
  const deterministic = receipt({
    state: 'deterministic_failure',
    executed: [],
    outcome: {
      failureClass: 'policy',
      fingerprint: 'policy:denied',
      logsUrl: 'https://github.com/example/log',
      artifactUrl: 'https://github.com/example/artifact',
    },
  });
  const first = remediationDecision(deterministic);
  assert.equal(first.dispatch, true);
  assert.equal(first.attemptBudget, 1);
  assert.deepEqual(remediationDecision(deterministic, [first.key]), {
    dispatch: false,
    reason: 'already_consumed',
    key: first.key,
  });
});

test('green: clean repeated samples are timing-eligible', () => {
  assert.deepEqual(
    timingSampleEligibility(receipt(), { cleanSamplesForFingerprint: 3 }),
    { eligible: true, reason: 'clean_repeat_sample' }
  );
});
