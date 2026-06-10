# Jovie CI & Agent Delivery Policy (v1)

The single strict policy inherited by every Jovie repository. Mastered here; the
"Agent PR contract" section is synced verbatim into each repo's AGENTS.md.

## 1. Gate tiers
1. **Pre-PR (local/agent harness)** — typecheck, lint, affected unit tests via the repo's validate hook. Agents MUST pass these before opening a PR. Never burn a runner on what the agent can run itself.
2. **PR (required checks)** — `rw-gate-fast` (~5–8 min) + `rw-gate-risk` only. Deep gates run conditionally when risk ≥ standard. Everything else is advisory.
3. **Merge queue** — all merges to main go through the queue (`merge_group`); `rw-merge-queue` runs build + E2E smoke on the batch. Batch 5, timeout 30 min.
4. **Post-merge** — deploy + canary health + error gate with auto-rollback. **Fix-forward:** post-merge failures auto-file a P1 and dispatch capped autofix (max 3 attempts → `needs-human`); they never retro-block the queue. Revert is reserved for canary/error-gate failures.
5. **Scheduled** — nightly full suite, mutation tests, security, CodeQL.

## 2. Risk filtering
`policy/risk-rules.yml` maps changed paths → low / standard / high. High-risk paths (auth, payments, migrations, token-vault, `.github/**`, public API) get the aggressive gates and a mandatory review label. Flaky or slow checks NEVER become required PR checks.

## 3. Branch & distribution rules
- Trunk-based: target `main` by default.
- `integration/<topic>` branches ONLY when: a feature spans >3 coordinated PRs, a churny shared area, or a mechanical agent sweep (codemods). The dispatching orchestrator owns the branch; it merges to main as one train via the queue.
- Concurrency: `cancel-in-progress: true` only for PR-scoped groups keyed by PR number. NEVER on main. NEVER on deploy/release workflows.

## 4. Agent PR contract (synced into AGENTS.md)
1. Branch naming: `codex/*`, `claude/*`, `agent/<name>/*`, `*/jov-<n>-*`.
2. Target branch: `main` unless the orchestrator directs `integration/<topic>`.
3. Run the local validate hook pre-PR; never open a PR red on typecheck/lint/affected tests.
4. PR size ≤ 10 files / 400 lines unless labeled `sweep`.
5. Conventional commits; open as draft; the mediation pipeline flips to ready.
6. Never merge directly. Auto-merge only via the mediation pipeline. `needs-human` is a hard stop.
7. No force-push after entering the merge queue; rebase via the landing sweeper.
8. Labels: `automerge`, `needs-human`, `testing`, `sweep`. CI autofix is capped at 3 attempts per origin PR.

## 5. Versioning
Consumers pin `@v1`. Breaking changes bump the major tag. Central-repo changes run actionlint + consumer smoke before tagging.
