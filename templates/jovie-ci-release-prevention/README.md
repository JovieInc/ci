# Incident metadata scaffold

Opt-in bootstrap for a new repository, restored from the historical scaffold
referenced by consumer incident records. This validates metadata and file
references; it does not execute regressions or certify that an incident cannot
recur. Consumers retain their existing test, release, and merge gates.

Choose a reviewed full commit of `JovieInc/ci` that includes this reusable
workflow. From that checkout, install into a new project:

```sh
node templates/jovie-ci-release-prevention/bootstrap.mjs --target /path/to/project --ci-ref <full-40-character-commit-sha>
```

The installer rejects floating tags, existing destination files, and symlink
parents. It generates a workflow with that explicit commit pin, a minimal
incident ledger, a verifier, and operator/postmortem documents. The verifier
rejects malformed or duplicate entries and absent/out-of-repository evidence.

Run locally with:

```sh
node scripts/verify-ci-release-incidents.mjs --config .github/ci-release-prevention.json
```

Adopt through an independently checked consumer PR. Qualify the new check in
shadow without adding it to branch protection. Failing metadata remains a failing
check; existing required checks are preserved. Promote only with the owner,
observed ship samples, performance/correctness evidence, and rollback required
by JOV-6555. Upgrade pins independently; revert the consumer commit to roll back.
No moving tags, fleet-wide gate, live controller, or runtime cutover is installed.
