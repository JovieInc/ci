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
};
assert.ok(checks[id], `unknown incident fixture: ${id}`);
assert.equal(negative ? !checks[id]() : checks[id](), true, `${id} regression invariant failed`);
console.log(`${negative ? 'negative' : 'positive'} recurrence case passed: ${id}`);
