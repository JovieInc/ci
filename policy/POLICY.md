# Shared CI source policy

Updated 2026-09-24. The old moving-major, universal gate-tier and automatic
AGENTS-sync claims were proposals, not implementation receipts. They are
superseded by the approved JOV-6555 independent pinned rollout contract.

- Full immutable commit-SHA pins; separate reviewed consumer upgrades and rollback.
- Preserve existing required-check names and real repo-specific test selectors.
- Validate the candidate against applicable representative fixtures and one actual
  consumer canary. Unchanged pinned consumers remain independently usable.
- Each repo owns its runtime/toolchain, credentials, builds, releases and gates.
  Do not copy another repo's Node/Python/Xcode requirements as company policy.
- Read-only untrusted PR validation is isolated from protected deployment/signing.
  Use explicit least-privilege permissions and named secrets.
- Preserve native merge queue and existing gates. Applicable failed, missing or
  unknown evidence cannot be presented as success.
- New delivery requirements qualify in nonblocking shadow before promotion, with
  actual ship samples, correctness/pass rate, p95 duration, throughput/cost,
  failure isolation, owner and tested rollback. No fixed new threshold is claimed.
- Publish a coherent draft early, then qualify the exact final head with required
  tests, coverage and independent source review before promotion.
- Legacy `needs-human`, `human-review-required` and `no-auto` labels are not blanket
  implementation/landing holds. Actual consequential-action authority still applies.

Shared source distribution must preserve local README/AGENTS instructions. The
[documentation parity procedure](../docs/DOCUMENTATION-PARITY.md) copies only
explicitly pinned files and generates a local source map. It neither rewrites a
consumer's whole AGENTS file nor establishes a fleet-wide enforced gate.

This policy does not mutate repository protections, rename required checks,
enable workflow consumers or authorize live runtime changes.
