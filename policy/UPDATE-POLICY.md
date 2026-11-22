# Auto-update policy

Everything Jovie runs stays on the latest stable release by default, as long as
each upgrade passes a compatibility check. Updates land without Tim. Agents own
the exceptions. Machine-readable rules, limits and the full inventory live in
[`canon/update-policy.json`](../canon/update-policy.json).

## Tiers

| Update | Minimum release age | How it lands |
| --- | --- | --- |
| Security fix | none | Auto-merge on green. |
| Patch | 1 day | Auto-merge on green. |
| Minor (1.x and up) | 3 days | Auto-merge on green. |
| Major, or any 0.x minor | 7 days | Labelled `compat-check`. An agent runs the compatibility check (full CI plus any gate in `canon/dependency-migration-gates.json`), fixes breakage, and merges once checks and the canary are green. Never routed to a human reviewer. |

"On green" means every required check on the PR, plus the repo's merge queue
where it has one. Deploys keep their own protection: Jovie web ships through
the canary health gate, staged promote and rollback gates; the desktop app
ships through its updater feeds.

## Repo rules

Every repo that consumes `JovieInc/ci` follows these, checked by the
`auto-update` company guard (`guards/plugins/auto-update.mjs`) on every PR and
push. The guard starts in shadow (warnings) and moves to ratchet once each
consumer is clean.

1. `.github/dependabot.yml` (or a Renovate config) covers every ecosystem the
   repo ships: npm, pip, docker and GitHub Actions, including composite
   actions outside `.github/workflows`.
2. npm and pip entries that open version PRs set a `cooldown`.
3. Third-party actions are pinned to a full 40-character commit SHA with a
   version comment. Dependabot keeps the SHA and the comment current.
4. A workflow lands Dependabot patch and minor PRs on green. Use the shared
   `JovieInc/ci/.github/workflows/dependabot-auto-merge.yml` (set
   `arm_auto_merge: true` when the repo has no label-driven queue).
5. Every hold (`ignore` entry) carries a dated re-evaluate note or a Linear
   key. A dated hold older than 60 days is drift: re-test it, then drop it or
   re-date it with the new evidence.
6. The pinned Node major is the current Active LTS major.
7. A Cloudflare Worker's `compatibility_date` is at most 120 days old.

## Outside the repos

Runtimes, hosts, agents, models and vendors are listed in the inventory with
how each updates today, its guard and, where it is a gap, the next step. A gap
becomes a Linear issue for an agent. Anything that touches production data,
secrets, money, a paid plan or customers waits for Tim's yes.

## Cost and clocks

Dependabot is the clock for upstream releases; the guard runs only on PR and
push events. No new schedules.
