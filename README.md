# JovieInc/ci

Centralized, opinionated CI for all Jovie repositories — one set of reusable GitHub Actions workflows, shared composite actions, and a single strict policy for gates, distribution, and agent mediation.

**Principle:** update one workflow here → every repo benefits. Consumer repos keep only ~15-line caller stubs pinned to `@v1`.

## Layout
- `.github/workflows/` — reusable workflows (`on: workflow_call`)
- `actions/` — shared composite actions
- `policy/` — POLICY.md (branch rules, gate tiers, agent PR contract), risk-rules.yml, gitleaks.toml

## Gate tiers
1. **Pre-PR (local/agent harness)** — typecheck, lint, affected unit tests. Never burn a runner on what the agent can run itself.
2. **PR (required)** — `rw-gate-fast` + risk classifier only. Deep gates run only when `rw-gate-risk` says risk ≥ standard.
3. **Merge queue** (`merge_group`) — build + E2E smoke on the queued batch.
4. **Post-merge** — deploy + canary + error gate, **fix-forward**: failures auto-file P1 + capped autofix; never retro-block the queue.
5. **Scheduled** — nightly full suite, security, CodeQL.

## Versioning
Consumers pin `@v1` (moving major tag). Breaking changes bump major. Changes here run actionlint + smoke against consumer repos before tagging.

Tracked in Linear: JOV-2970 (epic), JOV-2975 (Phase 1).
