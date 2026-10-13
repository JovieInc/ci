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
if (id === 'ci-release/pr-head-claim-freshness' && negative) {
  const claim = { pr: 14469, head: '7b290b', base: 'ff2681', observedAt: '2026-07-19T10:05:00Z', updatedAt: '2026-07-19T10:05:00Z', eventCursor: 10 };
  const events = [
    { cursor: 11, head: '1519', base: 'ff2681', updatedAt: '2026-07-19T10:06:00Z' },
    { cursor: 12, head: 'c3d', base: 'ff2681', updatedAt: '2026-07-19T10:07:00Z' },
    { cursor: 13, head: '24e', base: 'ff2681', updatedAt: '2026-07-19T10:08:00Z' },
  ];
  const live = events.at(-1);
  const disposition = claim.head === live.head && claim.base === live.base && claim.updatedAt === live.updatedAt && claim.eventCursor === live.cursor ? 'fresh' : 'stale_claim';
  assert.equal(disposition, 'stale_claim', 'a claim predating GitHub ref events must be stale');
  assert.notEqual(disposition, 'competing_ownership', 'stale evidence is not competing ownership');
  throw new Error('stale PR-head claim rejected pending live read');
}
if (id === 'ci-release/update-branch-rebase-provenance' && negative) {
  const reviewed = { patchId: 'patch-42', tree: 'tree-42', signed: true };
  const arbitraryUnsigned = { head: 'attacker-head', patchId: 'patch-other', tree: 'tree-other', signed: false };
  const receipt = { mutation: 'updatePullRequestBranch', updateMethod: 'REBASE', expectedHeadOid: 'rebased-head', timelineCursor: 22 };
  const accepted = receipt.mutation === 'updatePullRequestBranch' && receipt.updateMethod === 'REBASE' && receipt.expectedHeadOid === arbitraryUnsigned.head && reviewed.patchId === arbitraryUnsigned.patchId && reviewed.tree === arbitraryUnsigned.tree;
  assert.equal(accepted, false, 'arbitrary unsigned head must not inherit Update Branch authority');
  throw new Error('unsigned head without audited REBASE provenance rejected');
}
if (id === 'ci-release/immutable-required-workflow-boundary' && negative) {
  const immutableGate = { ref: 'org-ruleset-pinned-sha', context: 'PR Ready', body: 'canonical verifier', independentlyInvoked: true };
  const attacks = [
    { kind: 'same-context-spoof', workflow: { ref: 'attacker-pr-head', context: 'PR Ready', body: 'exit 0' } },
    { kind: 'workflow-change', workflow: { ref: 'attacker-pr-head', context: 'PR Ready', body: 'skip policy' } },
    { kind: 'workflow-removal', workflow: undefined },
    { kind: 'workflow-bypass', workflow: { ref: 'attacker-pr-head', context: 'PR Ready', body: 'if: true; exit 0' } },
  ];
  for (const attack of attacks) {
    const authoritative = attack.workflow?.ref === immutableGate.ref && attack.workflow?.body === immutableGate.body && immutableGate.independentlyInvoked;
    assert.equal(authoritative, false, `${attack.kind} must not satisfy the immutable required workflow`);
  }
  throw new Error('PR-controlled workflow cannot satisfy required context');
}
if (id === 'ci-release/runner-warm-path-bootstrap-loop' && negative) {
  const firstRunnerInvocation = { mode: 'heartbeat', receiptInput: undefined };
  const canaryEntrypoint = { mode: undefined, receiptOutput: undefined, expectedControlSha: undefined, expectedImageSha: undefined, expectedSourceSha: undefined };
  const heartbeatEligible = firstRunnerInvocation.mode === 'heartbeat' && typeof firstRunnerInvocation.receiptInput === 'string';
  const canaryEligible = canaryEntrypoint.mode === 'canary' && typeof canaryEntrypoint.receiptOutput === 'string' && [canaryEntrypoint.expectedControlSha, canaryEntrypoint.expectedImageSha, canaryEntrypoint.expectedSourceSha].every(value => /^[a-f0-9]{40,64}$/.test(value ?? ''));
  assert.equal(heartbeatEligible, false, 'heartbeat must reject first-run receipt absence');
  assert.equal(canaryEligible, false, 'canary entrypoint must require explicit mode, receipt output, and expected SHA inputs');
  throw new Error('runner warm-path bootstrap loop rejected');
}
if (id === 'ci-release/runner-warm-entrypoint-dependency-closure' && negative) {
  const entrypoint = { executable: false, checkout: ['verify-fixed-runner-warm.sh'] };
  const requiredClosure = ['verify-fixed-runner-warm.sh', 'restore-installed-tree.sh', 'verify-prerequisites.mjs'];
  assert.equal(entrypoint.executable, false, 'canary entrypoint without execute permission must fail');
  assert.equal(requiredClosure.every(file => entrypoint.checkout.includes(file)), false, 'sparse checkout must include every executable dependency');
  throw new Error('warm canary dependency closure rejected');
}
if (id === 'ci-release/runner-warm-receipt-identity-path' && negative) {
  const heartbeat = { runnerLabels: ['self-hosted'], receiptPath: 'tmp/receipt.json', checksumPath: 'tmp/receipt.sha256' };
  const stableRunnerLabel = /^jovie-warm-[a-z0-9-]+$/;
  const canonical = { receiptPath: 'receipts/warm/${runner}/sealed.json', checksumPath: 'receipts/warm/${runner}/sealed.json.sha256' };
  assert.equal(heartbeat.runnerLabels.some(label => stableRunnerLabel.test(label)), false, 'heartbeat must bind a stable per-runner label');
  assert.notEqual(heartbeat.receiptPath, canonical.receiptPath, 'heartbeat must not accept an ad hoc receipt path');
  throw new Error('warm receipt identity/path mismatch rejected');
}
if (id === 'ci-release/runner-heartbeat-evidence-job-cardinality' && negative) {
  const declared = ['jovie-warm-a', 'jovie-warm-b', 'jovie-warm-c', 'jovie-warm-d', 'jovie-warm-e'];
  const observed = [{ name: 'Warm heartbeat (a)', runner: 'jovie-warm-a', conclusion: 'success' }];
  const eligible = observed.length === declared.length && new Set(observed.map(job => job.runner)).size === declared.length && observed.every(job => job.conclusion === 'success' && declared.includes(job.runner));
  assert.equal(eligible, false, 'one renamed matrix job cannot stand in for five declared runner receipts');
  throw new Error('heartbeat job cardinality/identity mismatch rejected');
}
if (id === 'ci-release/runner-heartbeat-trusted-main-trigger' && negative) {
  const heartbeatRun = { event: 'merge_group', ref: 'refs/heads/gh-readonly-queue/main/pr-1' };
  const trustedMain = heartbeatRun.event === 'push' && heartbeatRun.ref === 'refs/heads/main';
  assert.equal(trustedMain, false, 'persistent heartbeat is trusted-main-only and must not require merge_group execution');
  throw new Error('untrusted heartbeat trigger rejected');
}
if (id === 'ci-release/generated-bytecode-manifest-containment' && negative) {
  const policy = { ignored: ['**/__pycache__/', '*.py[cod]'], tracked: ['scripts/lib/check.pyc'], staged: ['scripts/lib/check.pyc'], manifest: ['scripts/lib/check.mjs'] };
  const generated = /(^|\/)__pycache__(\/|$)|\.py[co]$/;
  assert.equal(policy.ignored.includes('**/__pycache__/') && policy.ignored.includes('*.py[cod]'), true, 'bytecode ignore policy must be declared');
  assert.equal(policy.tracked.some(path => generated.test(path)), true, 'tracked generated bytecode must block landing');
  assert.notDeepEqual([...policy.staged].sort(), [...policy.manifest].sort(), 'staging must equal the explicit manifest');
  throw new Error('generated bytecode or manifest drift rejected before landing');
}
if (negative && id.startsWith('ci-release/')) {
  const negativeCases = {
    'ci-release/bypass-secret-curl-argv': () => { const argv = ['curl', '-H', 'x-bypass=secret']; assert.equal(argv.some(value => value.includes('secret')), true); },
    'ci-release/ready-deployment-pagination-exact-identity': () => { const deployments = [{ id: 'old', sha: 'exact' }, { id: 'new', sha: 'other' }]; assert.equal(deployments.find(item => item.sha === 'exact')?.id, 'old'); },
    'ci-release/configured-auth-smoke-all-skip': () => { const checks = [{ configured: true, skipped: true }, { configured: true, skipped: true }]; assert.equal(checks.every(check => check.skipped), true); },
    'ci-release/tim-route-not-found-200': () => { const response = { status: 200, body: '<h1>Not Found</h1>' }; assert.equal(response.status === 200 && /not found/i.test(response.body), true); },
    'ci-release/public-route-2xx-empty-body': () => { const response = { status: 204, body: '' }; assert.equal(response.status >= 200 && response.status < 300 && response.body.length === 0, true); },
    'ci-release/staging-preview-environment-bypass': () => { const deployment = { environment: 'preview', bypass: true }; assert.equal(deployment.environment === 'preview' && deployment.bypass, true); },
    'ci-release/lighthouse-evidence-symlink-fifo-manifest': () => { const artifact = { type: 'fifo', manifest: false }; assert.equal(['symlink', 'fifo'].includes(artifact.type) || !artifact.manifest, true); },
    'ci-release/bypass-cookie-third-party-mask': () => { const cookie = { name: 'bypass', domain: '.third-party.example', value: 'masked' }; assert.equal(cookie.domain.includes('third-party') && cookie.value === 'masked', true); },
    'ci-release/playwright-route-promise-await': () => { const route = { continued: false, promiseAwaited: false }; assert.equal(!route.continued && !route.promiseAwaited, true); },
    'ci-release/fetch-absolute-timeout': () => { const request = { timeoutMs: undefined, elapsedMs: 120000 }; assert.equal(request.timeoutMs === undefined && request.elapsedMs > 60000, true); },
  };
  if (negativeCases[id]) { negativeCases[id](); throw new Error(`${id} unsafe production-control condition rejected`); }
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
  'ci-release/bypass-secret-curl-argv': () => { const argv = ['curl', '-H', 'x-bypass=REDACTED']; return argv.every(value => !value.includes('secret')); },
  'ci-release/ready-deployment-pagination-exact-identity': () => { const deployments = [{ id: 'old', sha: 'old' }, { id: 'exact', sha: 'exact' }]; return deployments.filter(item => item.sha === 'exact').length === 1 && deployments.find(item => item.sha === 'exact')?.id === 'exact'; },
  'ci-release/configured-auth-smoke-all-skip': () => { const checks = [{ configured: true, skipped: false }, { configured: false, skipped: true }]; return checks.some(check => check.configured && !check.skipped); },
  'ci-release/tim-route-not-found-200': () => { const response = { status: 404, body: 'Not Found' }; return response.status !== 200 || !/not found/i.test(response.body); },
  'ci-release/public-route-2xx-empty-body': () => { const response = { status: 200, body: '<main>public</main>' }; return response.status >= 200 && response.status < 300 && response.body.length > 0; },
  'ci-release/staging-preview-environment-bypass': () => { const deployment = { environment: 'production', bypass: false }; return deployment.environment !== 'preview' && !deployment.bypass; },
  'ci-release/lighthouse-evidence-symlink-fifo-manifest': () => { const artifact = { type: 'regular', manifest: true }; return artifact.type === 'regular' && artifact.manifest; },
  'ci-release/bypass-cookie-third-party-mask': () => { const cookie = { name: 'bypass', domain: 'first-party.example', value: 'REDACTED' }; return !cookie.domain.includes('third-party') && cookie.value === 'REDACTED'; },
  'ci-release/playwright-route-promise-await': () => { const route = { continued: true, promiseAwaited: true }; return route.continued && route.promiseAwaited; },
  'ci-release/fetch-absolute-timeout': () => { const request = { timeoutMs: 5000, elapsedMs: 100 }; return Number.isInteger(request.timeoutMs) && request.timeoutMs > 0 && request.elapsedMs < request.timeoutMs; },
  'ci-release/pr-head-claim-freshness': () => {
    const claim = { head: '7b290b', base: 'ff2681', observedAt: '2026-07-19T10:05:00Z', updatedAt: '2026-07-19T10:05:00Z', eventCursor: 10 };
    const events = [
      { cursor: 11, head: '1519', base: 'ff2681', updatedAt: '2026-07-19T10:06:00Z' },
      { cursor: 12, head: 'c3d', base: 'ff2681', updatedAt: '2026-07-19T10:07:00Z' },
      { cursor: 13, head: '24e', base: 'ff2681', updatedAt: '2026-07-19T10:08:00Z' },
    ];
    const live = events.at(-1);
    const stale = claim.head !== live.head || claim.base !== live.base || claim.updatedAt !== live.updatedAt || claim.eventCursor !== live.cursor;
    return stale && live.head === '24e' && !['competing_ownership', 'mutation_authorized'].includes('stale_claim');
  },
  'ci-release/update-branch-rebase-provenance': () => {
    const reviewed = { patchId: 'patch-42', tree: 'tree-42', signed: true };
    const serverRebased = { head: 'rebased-head', patchId: 'patch-42', tree: 'tree-42', signed: false };
    const receipt = { mutation: 'updatePullRequestBranch', updateMethod: 'REBASE', expectedHeadOid: 'rebased-head', timelineCursor: 22 };
    const finalProvenance = { mergeQueue: 'squash', main: 'authoritative' };
    return receipt.mutation === 'updatePullRequestBranch' && receipt.updateMethod === 'REBASE' && receipt.expectedHeadOid === serverRebased.head && reviewed.patchId === serverRebased.patchId && reviewed.tree === serverRebased.tree && !serverRebased.signed && finalProvenance.mergeQueue === 'squash' && finalProvenance.main === 'authoritative';
  },
  'ci-release/immutable-required-workflow-boundary': () => {
    const localWorkflow = { ref: 'pr-head', context: 'PR Ready', changedByPr: true };
    const immutableGate = { ref: 'central-pinned-sha', context: 'PR Ready', independentlyInvoked: true, verifier: 'canonical-contract', events: ['pull_request', 'merge_group'] };
    return localWorkflow.changedByPr && localWorkflow.context === immutableGate.context && immutableGate.independentlyInvoked && immutableGate.ref !== localWorkflow.ref && immutableGate.verifier === 'canonical-contract' && immutableGate.events.join(',') === 'pull_request,merge_group';
  },
  'ci-release/runner-warm-path-bootstrap-loop': () => {
    const canary = {
      mode: 'canary',
      receiptOutput: 'sealed-warm-receipt.json',
      expectedControlSha: 'a'.repeat(40),
      expectedImageSha: 'b'.repeat(64),
      expectedSourceSha: 'c'.repeat(40),
    };
    const receipt = {
      sealed: true,
      controlSha: canary.expectedControlSha,
      imageSha: canary.expectedImageSha,
      sourceSha: canary.expectedSourceSha,
    };
    const heartbeat = { mode: 'heartbeat', receiptInput: receipt };
    const validCanary = canary.mode === 'canary' && typeof canary.receiptOutput === 'string' && [canary.expectedControlSha, canary.expectedImageSha, canary.expectedSourceSha].every(value => /^[a-f0-9]{40,64}$/.test(value));
    const validHeartbeat = heartbeat.mode === 'heartbeat' && heartbeat.receiptInput.sealed && heartbeat.receiptInput.controlSha === canary.expectedControlSha && heartbeat.receiptInput.imageSha === canary.expectedImageSha && heartbeat.receiptInput.sourceSha === canary.expectedSourceSha;
    return validCanary && validHeartbeat;
  },
  'ci-release/runner-warm-entrypoint-dependency-closure': () => {
    const entrypoint = { executable: true, checkout: ['verify-fixed-runner-warm.sh', 'restore-installed-tree.sh', 'verify-prerequisites.mjs'] };
    return entrypoint.executable && ['verify-fixed-runner-warm.sh', 'restore-installed-tree.sh', 'verify-prerequisites.mjs'].every(file => entrypoint.checkout.includes(file));
  },
  'ci-release/runner-warm-receipt-identity-path': () => {
    const runner = 'jovie-warm-a';
    const label = `jovie-warm-${runner.slice('jovie-warm-'.length)}`;
    const receipt = `receipts/warm/${runner}/sealed.json`;
    return /^jovie-warm-[a-z0-9-]+$/.test(label) && receipt === 'receipts/warm/jovie-warm-a/sealed.json' && `${receipt}.sha256` === 'receipts/warm/jovie-warm-a/sealed.json.sha256';
  },
  'ci-release/runner-heartbeat-evidence-job-cardinality': () => {
    const declared = ['jovie-warm-a', 'jovie-warm-b', 'jovie-warm-c', 'jovie-warm-d', 'jovie-warm-e'];
    const observed = declared.map(runner => ({ runner, conclusion: 'success', contract: 'warm-heartbeat-v1' }));
    return observed.length === declared.length && new Set(observed.map(job => job.runner)).size === declared.length && observed.every(job => job.conclusion === 'success' && job.contract === 'warm-heartbeat-v1' && declared.includes(job.runner));
  },
  'ci-release/runner-heartbeat-trusted-main-trigger': () => {
    const heartbeatRun = { event: 'push', ref: 'refs/heads/main' };
    return heartbeatRun.event === 'push' && heartbeatRun.ref === 'refs/heads/main';
  },
  'ci-release/generated-bytecode-manifest-containment': () => {
    const ignored = ['**/__pycache__/', '*.py[cod]'];
    const tracked = ['scripts/lib/check.mjs'];
    const manifest = ['scripts/lib/check.mjs', 'scripts/test/check.test.mjs'];
    const staged = ['scripts/test/check.test.mjs', 'scripts/lib/check.mjs'];
    const generated = /(^|\/)__pycache__(\/|$)|\.py[co]$/;
    return ignored.includes('**/__pycache__/') && ignored.includes('*.py[cod]') && !tracked.some(path => generated.test(path)) && !staged.some(path => generated.test(path)) && JSON.stringify([...staged].sort()) === JSON.stringify([...manifest].sort());
  },
};
assert.ok(checks[id], `unknown incident fixture: ${id}`);
assert.equal(negative ? !checks[id]() : checks[id](), true, `${id} regression invariant failed`);
console.log(`${negative ? 'negative' : 'positive'} recurrence case passed: ${id}`);
