import { createHash } from 'node:crypto';

export const RELEASE = Object.freeze({ contractId: 'ci-release/drain-019f75f7/v1', implementationSha: 'bc0b0676c058ffa1c8515e8c29fefd2317b160cc', incidentCount: 27, incidentSetSha256: 'd557bce0c0a727ccdf6608c2db719b5e7e5a41f0384353c1c4b54c2e17c34f5c', requiredCheck: 'ci-release-contract' });
const digest = value => createHash('sha256').update(value).digest('hex');

export function generatedContract(release = RELEASE) {
  const verifier = 'export function verify() { return true; }\n';
  return {
    '.github/ci-release-prevention.json': JSON.stringify({ contract_id: release.contractId, implementation_sha: release.implementationSha, incident_count: release.incidentCount, incident_set_sha256: release.incidentSetSha256 }),
    '.github/workflows/ci-release-contract.yml': `jobs:\n  verify:\n    uses: JovieInc/ci/.github/workflows/verify-ci-release-prevention.yml@${release.implementationSha}\n`,
    'ci-release/incidents.json': JSON.stringify({ contract_id: release.contractId, incident_count: release.incidentCount, incident_set_sha256: release.incidentSetSha256 }),
    'scripts/verify-ci-release-incidents.mjs': verifier,
    '.ci-release/verifier.sha256': digest(verifier),
  };
}

export class FakeGitHubClient {
  constructor() { this.repositories = new Map(); this.operations = []; }
  createRepository(name) { this.repositories.set(name, { state: 'open', files: {}, properties: {}, rulesets: [] }); }
  repository(name) { const repo = this.repositories.get(name); if (!repo) throw new Error(`unknown repository ${name}`); return repo; }
  quarantine(name, reason) { const repo = this.repository(name); repo.state = 'quarantined'; repo.reason = reason; this.operations.push(['quarantine', name]); }
  seed(name, files) { const repo = this.repository(name); if (repo.state !== 'quarantined') throw new Error('seed requires quarantine'); repo.files = structuredClone(files); this.operations.push(['seed', name]); }
  attest(name) { this.operations.push(['attest', name]); return attestParity(this.repository(name).files); }
  promote(name, release) { const repo = this.repository(name); if (repo.state !== 'quarantined') throw new Error('promotion requires quarantine'); repo.rulesets.push({ name: 'ci-release-contract', requiredCheck: release.requiredCheck, implementationSha: release.implementationSha }); repo.properties.ci_release_contract = release.contractId; repo.state = 'compliant'; this.operations.push(['promote', name]); }
}

export function handleRepositoryCreated(client, event, release = RELEASE) {
  client.quarantine(event.repository, 'bootstrap-pending');
  if (event.creationReceipt?.issuer !== 'jovie-project-creator' || event.creationReceipt.contractId !== release.contractId) return { state: 'quarantined', reason: 'untrusted-or-missing-creation-receipt' };
  client.seed(event.repository, generatedContract(release));
  const attestation = client.attest(event.repository);
  if (!attestation.ok) return { state: 'quarantined', reason: attestation.reason };
  client.promote(event.repository, release);
  return { state: 'compliant', attestation };
}

export function reconcileOutOfBandRepository(client, repository) { client.quarantine(repository, 'out-of-band-creation-requires-human-or-creator-receipt'); return { state: 'quarantined' }; }

export function attestParity(files, release = RELEASE) {
  try {
    const config = JSON.parse(files['.github/ci-release-prevention.json']);
    const ledger = JSON.parse(files['ci-release/incidents.json']);
    if (config.contract_id !== release.contractId || config.implementation_sha !== release.implementationSha || config.incident_count !== release.incidentCount || config.incident_set_sha256 !== release.incidentSetSha256) throw new Error('manifest parity mismatch');
    if (ledger.contract_id !== release.contractId || ledger.incident_count !== release.incidentCount || ledger.incident_set_sha256 !== release.incidentSetSha256) throw new Error('ledger parity mismatch');
    if (!files['.github/workflows/ci-release-contract.yml'].includes(`@${release.implementationSha}`)) throw new Error('workflow is not pinned to audited implementation');
    if (digest(files['scripts/verify-ci-release-incidents.mjs']) !== files['.ci-release/verifier.sha256']) throw new Error('verifier digest mismatch');
    return { ok: true };
  } catch (error) { return { ok: false, reason: error.message }; }
}
