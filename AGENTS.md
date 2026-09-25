# Shared CI repository

Keep consumer builds and releases independent. Preserve existing required checks
and native merge queues. New fleet checks qualify in shadow before enforcement.
Use full commit pins and separate consumer upgrade/rollback PRs (JOV-6555).
Do not change credentials, branch protections, deployments or live controllers.

For documentation tooling, read docs/DOCUMENTATION-PARITY.md and run its exact
coverage commands. Local consumer README/AGENTS and manifests remain repo-owned.
The older policy/POLICY.md and README distribution claims predate JOV-6555;
this task does not certify their planned workflows as implemented.

## Repository documentation

See [source parity](docs/DOCUMENTATION.md) and the generated
[source map](docs/REPOSITORY_SOURCES.md). Shared policy is pinned; local
manifest, build, test and release instructions remain owned by this repository.
