import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { evaluate, RULES, runControls, summarize } from './privacy-rules.mjs';
import { HEALTH_RULES } from './health-rules.mjs';

export const RECORD_SCHEMA = 'company.privacy-record/v1';
export function buildRecord(snapshot, registry, config = {}, { evaluateFn = evaluate, cwd = process.cwd() } = {}) {
  const controls = runControls(evaluateFn, config);
  const results = evaluateFn(snapshot, registry, config);
  const controls_ok = controls.length > 0 && controls.every(c => c.ok === true);
  let revision = null;
  try { revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* Evidence remains unsigned. */ }
  const registryDigest = createHash('sha256').update(JSON.stringify(registry)).digest('hex');
  const registryMatches = snapshot.registry_sha256 === registryDigest;
  results.push({ rule: 'registry-version', status: registryMatches ? 'pass' : 'fail', detail: 'Crawled registry must match evaluated registry' });
  return {
    schema: RECORD_SCHEMA, app: config.app ?? snapshot.app, run_id: snapshot.run_id,
    recorded_at: new Date().toISOString(), code_revision: revision,
    registry_sha256: registryDigest, policy_versions: snapshot.policy_versions ?? {},
    controls, controls_ok, summary: summarize(results), results, snapshot,
    pass: controls_ok && results.length > 0 && results.every(r => r.status === 'pass'),
  };
}

export function toMarkdown(record) {
  const lines = [`# Privacy compliance snapshot ${record.recorded_at}`, '',
    `Run ${record.run_id}; code ${record.code_revision ?? 'unknown'}; registry ${record.registry_sha256}.`,
    `Negative controls: ${record.controls_ok ? 'all bit' : 'FAILED'}. Result: ${record.pass ? 'pass' : 'blocked'}.`, '',
    '| Rule | Fail | Warn | Pass |', '|---|---|---|---|'];
  for (const id of new Set([...Object.keys(RULES), ...Object.keys(HEALTH_RULES), ...Object.keys(record.summary.by_rule)])) {
    const r = record.summary.by_rule[id] ?? { fail: 0, warn: 0, pass: 0 };
    lines.push(`| ${id} | ${r.fail} | ${r.warn} | ${r.pass} |`);
  }
  lines.push('', '## Fails and warnings', '');
  for (const r of record.results.filter(r => r.status !== 'pass')) {
    lines.push(`- **${r.status}** ${r.rule}: ${String(r.detail).replaceAll('\n', ' ')}`);
  }
  lines.push('', '## Policy versions', '');
  for (const [id, p] of Object.entries(record.policy_versions)) lines.push(`- ${id}: ${p.url} sha256 ${p.sha256 ?? p.error}`);
  return `${lines.join('\n')}\n`;
}
