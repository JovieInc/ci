# JovieInc/ci

Shared CI source for independently released company repositories. Consumers own
their build commands, tests, required checks, deployment and rollback.

## Implemented on this branch

- `.github/workflows/dependabot-auto-merge.yml`: callable dependency mediation.
- `.github/workflows/secret-scan.yml`: callable pinned-gitleaks scan of the pushed or
  PR range (`full-history`, shadow via `fail-on-findings: false`); behavior tests in
  `tests/test_secret_scan_workflow.py`.
- `.github/workflows/private-data-guard.yml`: callable PII/private-path guard for public
  repos (key/cert/env files, personal-brain dirs, internal hostnames, home paths, private
  IPs); prints rule and file:line only; path allowlist in `.private-data-allowlist`; tests in
  `tests/test_private_data_guard_workflow.py`.
- `actions/slop-guard`: composite action running the company anti-slop ratchets (file size,
  pass-through modules, single-implementation interfaces, prefix sprawl, knip, jscpd) against a
  per-repo `.slop-guard.json` and a shrink-only `.slop-baseline.json`. Consumer usage:
  `uses: JovieInc/ci/actions/slop-guard@<sha>` after the repo's install step; tests in
  `actions/slop-guard/slop-guard.test.mjs`, qualified by `slop-guard-self.yml`.
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


## Typed shard evidence

`actions/ci-shard-contract/` validates provider-neutral shard receipts, exact
inventory aggregation and shadow-only cancellation decisions. Missing controller
identity or malformed evidence is indeterminate and cannot authorize success.

Consumers remain `fail-fast: false` until their own hosted shadow cohort meets
correctness, diagnostic-loss, cost and rollback thresholds. Every shadow, timing
and remediation decision requires the controller's current identity tuple.

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

## Optional incident metadata scaffold

The [bootstrap](templates/jovie-ci-release-prevention/README.md) installs a real
consumer scaffold with an explicitly selected full commit pin. Its check validates
metadata and file references, not regression execution or prevention coverage.
Adopt and qualify independently under JOV-6555; preserve existing required gates.
