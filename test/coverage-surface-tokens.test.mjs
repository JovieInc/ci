import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractSurfaceTokens,
  surfaceAppPrefix,
  testPathMatchesSurface,
} from '../lib/coverage-surface-tokens.mjs';

test('extractSurfaceTokens: single-file proxy yields stem, not proxy.ts', () => {
  const tokens = extractSurfaceTokens({
    id: 'proxy',
    glob: 'apps/web/proxy.ts',
  });
  assert.ok(tokens.includes('proxy'));
  assert.ok(!tokens.includes('proxy.ts'));
});

test('extractSurfaceTokens: directory surfaces keep trailing segments', () => {
  const tokens = extractSurfaceTokens({
    id: 'stripe-webhooks',
    glob: 'apps/web/app/api/stripe/webhooks/**',
  });
  assert.ok(tokens.includes('webhooks'));
  assert.ok(tokens.includes('stripe/webhooks'));
  assert.ok(tokens.includes('stripe-webhooks'));
});

test('testPathMatchesSurface: scopes to apps/web and rejects other packages', () => {
  const proxy = { id: 'proxy', glob: 'apps/web/proxy.ts' };
  assert.equal(surfaceAppPrefix(proxy), 'apps/web/');
  assert.equal(
    testPathMatchesSurface(
      'apps/web/tests/e2e/proxy-audience-gate.spec.ts',
      proxy
    ),
    true
  );
  assert.equal(testPathMatchesSurface('apps/ovie/proxy.test.ts', proxy), false);
  assert.equal(
    testPathMatchesSurface('packages/jovie-cli/src/proxy.test.ts', proxy),
    false
  );
});

test('testPathMatchesSurface: rejects mid-segment substrings', () => {
  const proxy = { id: 'proxy', glob: 'apps/web/proxy.ts' };
  assert.equal(
    testPathMatchesSurface(
      'apps/web/tests/unit/lib/approxy-helper.test.ts',
      proxy
    ),
    false
  );
});

test('testPathMatchesSurface: matches kebab/snake with symmetric boundaries', () => {
  const proxy = { id: 'proxy', glob: 'apps/web/proxy.ts' };
  assert.equal(
    testPathMatchesSurface(
      'apps/web/tests/integration/middleware-proxy.test.ts',
      proxy
    ),
    true
  );
  assert.equal(
    testPathMatchesSurface(
      'apps/web/tests/unit/lib/auth_proxy_gate.test.ts',
      proxy
    ),
    true
  );
  assert.equal(
    testPathMatchesSurface('apps/ovie/middleware-proxy.test.ts', proxy),
    false
  );
});
