# JovieInc/ci

Shared CI source for independently released company repositories. Consumers own
their build commands, tests, required checks, deployment and rollback.

## Implemented on this branch

- `.github/workflows/dependabot-auto-merge.yml`: callable dependency mediation.
- `actions/setup-node-pnpm`, `actions/setup-ios-build`, `actions/asc-api-key`:
  composite actions; inspect their own inputs and prerequisites before use.
- `scripts/repository_docs.py`: offline manifest projection and pinned shared-file
  parity. See [documentation parity](docs/DOCUMENTATION-PARITY.md) for tests,
  scope, update procedure, shadow qualification and rollback.
- `policy/`: source policy, risk rules and secret-scanner configuration.

This list describes source, not consumer adoption or effective branch controls.
Previously described `rw-gate-fast`, `rw-gate-risk`, `rw-gate-deep` and
`rw-merge-queue` workflows are not present on this revision. JOV-2970/JOV-2975
track shared CI; existing PRs retain ownership of their separate implementation.

## Distribution

JOV-6555 supersedes the old moving-`@v1` proposal: consumers use reviewed full
commit SHAs and separate upgrade PRs. A central commit does not automatically
change consumers. Qualify a candidate with relevant tests and a consumer canary,
then roll out independently; retain known-good pins for rollback.

Existing consumer checks and release guarantees remain in force. New fleet
requirements qualify in shadow before enforcement. No sibling repo's healthy
build depends on every other consumer being green.

## Repository documentation

See [source parity](docs/DOCUMENTATION.md) and the generated
[source map](docs/REPOSITORY_SOURCES.md). Shared policy is pinned; local
manifest, build, test and release instructions remain owned by this repository.
