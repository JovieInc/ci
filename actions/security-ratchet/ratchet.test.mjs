import test from 'node:test';
import assert from 'node:assert/strict';
import { newBlocking, baselineVerdict, countBySeverity, severityOf } from './ratchet.mjs';
const al = (id, path, sev, rsev = 'warning') => ({ rule: { id, security_severity_level: sev, severity: rsev }, tool: { name: 't' }, most_recent_instance: { location: { path } } });
test('only new critical/high blocks; existing backlog does not', () => {
  const base = [al('a', 'x', 'critical')];
  const pr = [al('a', 'x', 'critical'), al('b', 'y', 'high'), al('c', 'z', 'medium')];
  assert.deepEqual(newBlocking(pr, base).map((a) => a.rule.id), ['b']);
});
test('semgrep error maps to high', () => assert.equal(severityOf(al('s', 'p', null, 'error')), 'high'));
test('baseline only shrinks', () => {
  const b = { critical: 3, high: 10, medium: 5, low: 1, total: 20 };
  assert.equal(baselineVerdict(countBySeverity([al('a', 'p', 'high')]), b).ok, true);
  assert.equal(baselineVerdict(countBySeverity([al('a', 'p', 'high')]), b).lowered.high, 1);
  const grown = baselineVerdict({ critical: 4, high: 1, medium: 0, low: 0, total: 5 }, b);
  assert.equal(grown.ok, false);
});
