import assert from 'node:assert/strict';
import { FakeGitHubClient, RELEASE, attestParity, generatedContract, handleRepositoryCreated, reconcileOutOfBandRepository } from './controller.mjs';

const client = new FakeGitHubClient();
client.createRepository('JovieInc/trusted');
assert.equal(handleRepositoryCreated(client, { repository: 'JovieInc/trusted', creationReceipt: { issuer: 'jovie-project-creator', contractId: RELEASE.contractId } }).state, 'compliant');
assert.deepEqual(client.operations.map(([operation]) => operation), ['quarantine', 'seed', 'attest', 'promote']);
client.createRepository('JovieInc/out-of-band');
assert.equal(reconcileOutOfBandRepository(client, 'JovieInc/out-of-band').state, 'quarantined');
assert.equal(client.repository('JovieInc/out-of-band').properties.ci_release_contract, undefined);
const tampered = generatedContract(); tampered['.github/workflows/ci-release-contract.yml'] = 'jobs: {}\n';
assert.deepEqual(attestParity(tampered), { ok: false, reason: 'workflow is not pinned to audited implementation' });
console.log('post-create compliance controller simulator: passed');
