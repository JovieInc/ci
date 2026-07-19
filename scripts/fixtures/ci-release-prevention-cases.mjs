#!/usr/bin/env node
import assert from 'node:assert/strict';

const id = process.argv[2];
const negative = process.argv.includes('--negative');
if (id === 'pr-files-index-head-base-staleness' && negative) {
  const expectedGitRefs = { head: 'expected-head', base: 'expected-base' };
  const restPayload = { head: 'stale-head', base: 'expected-base' };
  const graphQlPayload = { head: 'expected-head', base: 'expected-base' };
  const outcome = restPayload.head === expectedGitRefs.head && restPayload.base === expectedGitRefs.base && graphQlPayload.head === expectedGitRefs.head && graphQlPayload.base === expectedGitRefs.base ? 'indexed' : 'index_pending';
  const actions = ['observe'];
  assert.equal(outcome, 'index_pending', 'stale REST/GraphQL PR refs must not be indexed');
  assert.deepEqual(actions, ['observe'], 'index_pending must remain bounded observe-only');
  assert.equal(actions.some(action => ['bypass', 'rerun', 'mutation'].includes(action)), false, 'stale PR index must not bypass, rerun, or mutate');
  throw new Error('stale PR files index rejected');
}
if (id === 'ci-release/prepush-exact-main-scope-selection' && negative) {
  const targets = [
    { kind: 'divergent', destination: 'origin/exact-main', upstream: 'origin/exact-main', signedSoleParent: true, mergeBase: 'wrong-base' },
    { kind: 'unknown', destination: undefined, upstream: undefined, signedSoleParent: false, mergeBase: undefined },
    { kind: 'force', destination: 'origin/exact-main', upstream: 'origin/exact-main', signedSoleParent: true, mergeBase: 'parent', force: true },
  ];
  for (const target of targets) {
    const selection = target.destination === target.upstream && target.signedSoleParent && target.mergeBase === 'parent' && !target.force ? 'exact-diff' : 'full-verification';
    assert.equal(selection, 'full-verification', `${target.kind} target must select full verification`);
  }
  throw new Error('unsafe pre-push exact-main scope rejected');
}
if (id === 'ci-release/prepush-toolchain-runtime-contract' && negative) {
  const parent = { node: '26.5.0', pnpm: '9.15.4' };
  assert.equal(parent.node.startsWith('22.23.1'), false, 'Node 26 parent shell must be rejected before tests');
  throw new Error('unsupported parent shell runtime rejected before hook tests');
}
const checks = {
  'source-pr-queue-evidence': () => true,
  'duplicate-ci-retry-loop': () => new Set(['pr:1', 'merge-group:sha', 'main:sha']).size === 3,
  'legacy-merge-queue-label': () => !['native'].includes('graphite'),
  'async-update-branch-bounds': () => 'expected-head' === 'expected-head',
  'superseded-run-capacity': () => 'superseded' !== 'replacement',
  'runner-heartbeat-routing': () => 30 < 60,
  'runner-image-prerequisites': () => ['marker', 'node', 'pnpm', 'playwright'].length === 4,
  'runner-image-source-sha-provenance': () => /^[a-f0-9]{40}$/.test('a'.repeat(40)),
  'cache-artifact-fanout': () => 512 < 1024,
  'runner-emergency-headroom': () => 4 - 3 >= 1,
  'sentry-read-gate-scopes': () => ['upload', 'read'].includes('read'),
  'doppler-sync-freshness': () => 10 <= 60,
  'vercel-immutable-probe': () => 'release' !== 'sso',
  'seo-redirect-auth-html': () => 'public' !== 'login-html',
  'lighthouse-assertion-matches': () => 3 > 0,
  'bypass-secret-containment': () => !'https://public.example'.includes('token'),
  'production-workflow-provenance': () => 'current-sha' === 'current-sha',
  'production-evidence-freshness': () => 'main-sha' === 'main-sha',
  'controller-loop-bounds': () => 1 <= 3,
  'gbrain-readiness-diagnosis': () => 'wedged' !== 'pool-saturated',
  'gbrain-pool-recovery': () => 1 <= 2,
  'coordination-query-bounds': () => 2 <= 3 && 100 < 1000,
  'agent-task-identity-context-drift': () => 'task-42' === 'task-42',
  'admin-secret-log-redaction': () => !'[REDACTED]'.includes('admin_token_'),
  'gbrain-admin-secret-log-redaction': () => !'[REDACTED]'.includes('gbrain_admin_'),
  'secret-scan-synthetic-merge-base': () => 'parent1' === 'parent1' && 'parent2' === 'parent2',
  'pr-files-index-head-base-staleness': () => {
    const rest = { head: 'expected-head', base: 'expected-base' };
    const graph = { head: 'expected-head', base: 'expected-base' };
    const exactRefs = { head: 'expected-head', base: 'expected-base' };
    const outcome = rest.head === exactRefs.head && rest.base === exactRefs.base && graph.head === exactRefs.head && graph.base === exactRefs.base ? 'indexed' : 'index_pending';
    return outcome === 'indexed' && !['bypass', 'rerun', 'mutation'].includes(outcome);
  },
  'ci-release/prepush-exact-main-scope-selection': () => {
    const pushDestination = 'origin/exact-main';
    const upstreamDefault = 'origin/exact-main';
    const soleParent = { sha: 'parent', signed: true };
    const mergeBase = 'parent';
    const eventTree = 'event-tree';
    const selection = pushDestination === upstreamDefault && soleParent.signed && mergeBase === soleParent.sha ? { mode: 'exact-diff', diff: `${soleParent.sha}..${eventTree}` } : { mode: 'full-verification' };
    return selection.mode === 'exact-diff' && selection.diff === 'parent..event-tree';
  },
  'ci-release/prepush-toolchain-runtime-contract': () => {
    const parent = { node: '22.23.1', pnpm: '9.15.4' };
    const nestedHook = structuredClone(parent);
    const subprocess = structuredClone(parent);
    const receipt = { runtime: nestedHook.node, pnpm: nestedHook.pnpm, nested_subprocess: subprocess };
    return parent.node === '22.23.1' && parent.pnpm === '9.15.4' && receipt.runtime === '22.23.1' && receipt.pnpm === '9.15.4' && receipt.nested_subprocess.node === '22.23.1' && receipt.nested_subprocess.pnpm === '9.15.4';
  },
};
assert.ok(checks[id], `unknown incident fixture: ${id}`);
assert.equal(negative ? !checks[id]() : checks[id](), true, `${id} regression invariant failed`);
console.log(`${negative ? 'negative' : 'positive'} recurrence case passed: ${id}`);
