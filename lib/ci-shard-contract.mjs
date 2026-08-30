import { createHash } from 'node:crypto';

export const SCHEMA = 'jovie-company-ci-shard/v1';
export const TERMINAL_STATES = new Set([
  'passed',
  'deterministic_failure',
  'transient_failure',
  'unknown_failure',
  'canceled_by_deterministic',
  'canceled_indeterminate',
  'skipped_dependency',
  'not_selected',
]);
export const DETERMINISTIC_CLASSES = new Set([
  'source',
  'policy',
  'compile',
  'type',
  'migration',
  'security',
  'test_assertion',
  'stale_base',
  'exact_head_mismatch',
]);
export const TRANSIENT_CLASSES = new Set([
  'provider_capacity',
  'cache',
  'network',
  'runner_loss',
  'timeout',
  'service_contention',
]);
const SHA = /^[0-9a-f]{40}$/;
const HASH = /^sha256:[0-9a-f]{64}$/;
const IDENTITY_KEYS = [
  'repository',
  'headSha',
  'baseSha',
  'mergeGroupSha',
  'runId',
  'attempt',
  'selectorHash',
  'inventoryHash',
  'policyVersion',
  'adapterVersion',
  'environmentHash',
];

const unique = values => [...new Set(values)];
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const sorted = values => [...values].sort();
const stable = value => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(key => [key, stable(value[key])])
    );
  return value;
};

export function digest(value) {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(stable(value)))
    .digest('hex')}`;
}

function identityErrors(identity = {}) {
  const errors = [];
  if (!/^[^/\s]+\/[^/\s]+$/.test(identity.repository ?? ''))
    errors.push('identity.repository');
  for (const key of ['headSha', 'baseSha', 'mergeGroupSha']) {
    if (!SHA.test(identity[key] ?? '')) errors.push(`identity.${key}`);
  }
  if (!/^\d+$/.test(String(identity.runId ?? '')))
    errors.push('identity.runId');
  if (!Number.isInteger(identity.attempt) || identity.attempt < 1)
    errors.push('identity.attempt');
  for (const key of [
    'selectorHash',
    'inventoryHash',
    'policyVersion',
    'adapterVersion',
    'environmentHash',
  ]) {
    if (!HASH.test(identity[key] ?? '')) errors.push(`identity.${key}`);
  }
  return errors;
}

export function validateReceipt(receipt, expectedIdentity = null) {
  const errors = [];
  if (receipt?.schema !== SCHEMA) errors.push('schema');
  errors.push(...identityErrors(receipt?.identity));
  const shard = receipt?.shard ?? {};
  if (
    !Number.isInteger(shard.index) ||
    !Number.isInteger(shard.total) ||
    shard.index < 1 ||
    shard.total < shard.index
  )
    errors.push('shard');
  const outcome = receipt?.outcome ?? {};
  if (!TERMINAL_STATES.has(outcome.state)) errors.push('outcome.state');
  const planned = receipt?.inventory?.planned;
  const executed = receipt?.inventory?.executed;
  if (!Array.isArray(planned) || unique(planned).length !== planned?.length)
    errors.push('inventory.planned');
  if (!Array.isArray(executed) || unique(executed).length !== executed?.length)
    errors.push('inventory.executed');
  if (outcome.state === 'passed' && !same(sorted(planned ?? []), sorted(executed ?? [])))
    errors.push('passed.inventory_mismatch');
  if (outcome.state === 'deterministic_failure') {
    if (!DETERMINISTIC_CLASSES.has(outcome.failureClass))
      errors.push('deterministic.failureClass');
    for (const key of ['fingerprint', 'logsUrl', 'artifactUrl'])
      if (!String(outcome[key] ?? '').trim())
        errors.push(`deterministic.${key}`);
    if (
      outcome.failureClass &&
      !String(outcome.fingerprint ?? '').startsWith(
        `${outcome.failureClass}:`
      )
    )
      errors.push('deterministic.typedFingerprint');
  }
  if (outcome.state === 'transient_failure') {
    if (!TRANSIENT_CLASSES.has(outcome.failureClass))
      errors.push('transient.failureClass');
    for (const key of ['fingerprint', 'logsUrl', 'artifactUrl'])
      if (!String(outcome[key] ?? '').trim()) errors.push(`transient.${key}`);
    if (
      outcome.failureClass &&
      !String(outcome.fingerprint ?? '').startsWith(
        `${outcome.failureClass}:`
      )
    )
      errors.push('transient.typedFingerprint');
  }
  if (outcome.state === 'unknown_failure') {
    for (const key of ['reason', 'fingerprint', 'logsUrl', 'artifactUrl'])
      if (!String(outcome[key] ?? '').trim()) errors.push(`unknown.${key}`);
    if (
      outcome.fingerprint &&
      !String(outcome.fingerprint).startsWith('unknown:')
    )
      errors.push('unknown.typedFingerprint');
  }
  if (
    outcome.state === 'canceled_indeterminate' &&
    (!String(outcome.reason ?? '').trim() ||
      !String(outcome.artifactUrl ?? '').trim())
  )
    errors.push('canceled_indeterminate.evidence');
  if (
    ['canceled_by_deterministic', 'skipped_dependency'].includes(outcome.state) &&
    (!String(outcome.triggerFingerprint ?? '').trim() ||
      !String(outcome.cancellationReason ?? '').trim())
  )
    errors.push(`${outcome.state}.trigger`);
  if (
    outcome.state === 'not_selected' &&
    !String(outcome.selectionReason ?? '').trim()
  )
    errors.push('not_selected.selectionReason');
  if (expectedIdentity) {
    for (const key of IDENTITY_KEYS) {
      if (receipt?.identity?.[key] !== expectedIdentity[key])
        errors.push(`stale.${key}`);
    }
  }
  return { valid: errors.length === 0, errors: unique(errors) };
}

export function aggregateShards({ identity, plan = [], receipts = [] } = {}) {
  const errors = [];
  const expectedInventory = sorted(
    plan.flatMap(item => (item.selected ? item.tests : []))
  );
  if (unique(expectedInventory).length !== expectedInventory.length)
    errors.push('duplicate_planned_test');
  const byShard = new Map();
  const validDeterministicFingerprints = new Set();
  for (const receipt of receipts) {
    const validation = validateReceipt(receipt, identity);
    errors.push(...validation.errors.map(error => `receipt:${error}`));
    const id = `${receipt?.shard?.index}/${receipt?.shard?.total}`;
    if (byShard.has(id)) errors.push(`duplicate_receipt:${id}`);
    byShard.set(id, receipt);
    if (
      validation.valid &&
      receipt.outcome.state === 'deterministic_failure'
    )
      validDeterministicFingerprints.add(receipt.outcome.fingerprint);
  }
  const plannedIds = new Set(plan.map(item => item.id));
  for (const id of byShard.keys())
    if (!plannedIds.has(id)) errors.push(`unplanned_receipt:${id}`);
  const executedInventory = [];
  let deterministicRed = false;
  let transientBlocked = false;
  let unknownBlocked = false;
  let indeterminate = false;
  for (const item of plan) {
    const receipt = byShard.get(item.id);
    if (!receipt) {
      errors.push(`missing_receipt:${item.id}`);
      indeterminate = true;
      continue;
    }
    if (!item.selected) {
      if (receipt.outcome.state !== 'not_selected') {
        errors.push(`unselected_not_typed:${item.id}`);
        indeterminate = true;
      }
      continue;
    }
    if (!same(sorted(item.tests), sorted(receipt.inventory.planned))) {
      errors.push(`plan_mismatch:${item.id}`);
      indeterminate = true;
    }
    if (receipt.outcome.state === 'passed') {
      executedInventory.push(...receipt.inventory.executed);
    } else if (receipt.outcome.state === 'deterministic_failure') {
      deterministicRed ||= validDeterministicFingerprints.has(
        receipt.outcome.fingerprint
      );
    } else if (receipt.outcome.state === 'transient_failure') {
      transientBlocked = true;
    } else if (receipt.outcome.state === 'unknown_failure') {
      unknownBlocked = true;
    } else if (
      ['canceled_by_deterministic', 'skipped_dependency'].includes(
        receipt.outcome.state
      )
    ) {
      if (
        validDeterministicFingerprints.has(
          receipt.outcome.triggerFingerprint
        )
      )
        deterministicRed = true;
      else indeterminate = true;
    } else {
      indeterminate = true;
    }
  }
  if (unique(executedInventory).length !== executedInventory.length)
    errors.push('duplicate_executed_test');
  if (
    !deterministicRed &&
    !transientBlocked &&
    !unknownBlocked &&
    !indeterminate &&
    !same(sorted(executedInventory), expectedInventory)
  )
    errors.push('aggregate_inventory_mismatch');
  const status =
    deterministicRed
      ? 'deterministic_red'
      : errors.length > 0 || indeterminate
        ? 'indeterminate'
        : transientBlocked
          ? 'transient_blocked'
          : unknownBlocked
            ? 'unknown_blocked'
            : 'green';
  return {
    status,
    green: status === 'green',
    evidenceComplete: errors.length === 0 && !indeterminate,
    errors: unique(errors),
  };
}

export function shadowFailFastDecision(
  receipt,
  {
    mode = 'immediate',
    diagnosticQuorum = 2,
    expectedIdentity = null,
  } = {}
) {
  const validation = expectedIdentity
    ? validateReceipt(receipt, expectedIdentity)
    : { valid: false, errors: ['missing.expectedIdentity'] };
  const deterministic =
    validation.valid && receipt.outcome.state === 'deterministic_failure';
  if (!deterministic) {
    const retry =
      validation.valid && receipt.outcome.state === 'transient_failure';
    return {
      wouldCancel: false,
      boundedRetry: retry ? 1 : 0,
      retainDiagnosticSiblings: 0,
      reason: validation.valid ? receipt.outcome.state : 'invalid_evidence',
    };
  }
  return {
    wouldCancel: true,
    boundedRetry: 0,
    retainDiagnosticSiblings:
      mode === 'diagnostic_quorum' ? Math.max(1, diagnosticQuorum) : 0,
    reason: 'validated_deterministic_fingerprint',
  };
}

export function timingSampleEligibility(
  receipt,
  { cleanSamplesForFingerprint = 0, expectedIdentity = null } = {}
) {
  const validation = expectedIdentity
    ? validateReceipt(receipt, expectedIdentity)
    : { valid: false, errors: ['missing.expectedIdentity'] };
  const eligible =
    validation.valid &&
    receipt.outcome.state === 'passed' &&
    receipt.identity.attempt === 1 &&
    !receipt.outcome.retryOf &&
    receipt.outcome.flaky !== true &&
    receipt.outcome.quarantined !== true &&
    cleanSamplesForFingerprint >= 3;
  return {
    eligible,
    reason: eligible
      ? 'clean_repeat_sample'
      : validation.valid
        ? 'non_clean_or_insufficient_history'
        : 'invalid_receipt',
  };
}

export function remediationDecision(
  receipt,
  consumedKeys = [],
  expectedIdentity = null
) {
  const validation = expectedIdentity
    ? validateReceipt(receipt, expectedIdentity)
    : { valid: false, errors: ['missing.expectedIdentity'] };
  if (!validation.valid || receipt.outcome.state !== 'deterministic_failure')
    return { dispatch: false, reason: 'not_effective_deterministic_failure' };
  const {
    repository,
    headSha,
    baseSha,
    mergeGroupSha,
    selectorHash,
    inventoryHash,
    policyVersion,
    adapterVersion,
  } = receipt.identity;
  const key = digest({
    identity: {
      repository,
      headSha,
      baseSha,
      mergeGroupSha,
      selectorHash,
      inventoryHash,
      policyVersion,
      adapterVersion,
    },
    fingerprint: receipt.outcome.fingerprint,
  });
  return consumedKeys.includes(key)
    ? { dispatch: false, reason: 'already_consumed', key }
    : { dispatch: true, reason: 'single_bounded_transition', key, attemptBudget: 1 };
}
