# CI incident metadata

Run the local metadata check before opening a CI/release change:

```sh
node scripts/verify-ci-release-incidents.mjs --config .github/ci-release-prevention.json
```

Each incident has a unique `ci-release/<slug>` ID, invariant, regression file,
CI-stage owner, operator document, postmortem file, and template source pointers.
The check validates those fields and file references. It does not execute the
regression, verify semantic coverage, or prove upstream propagation; retain the
real tests and record their actual results separately.

The caller uses the explicitly reviewed full `JovieInc/ci` commit supplied at
bootstrap. Evaluate this new check in shadow without adding it to branch
protection. Existing required checks remain enforced. Upgrade via an independent
consumer PR and revert that commit to roll back. Do not change sibling pins.
