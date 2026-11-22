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

### Gem and fleet read-back

The tooling registry contains repository declarations. A null version, pin
source or channel means that field has no verified declaration. A declared
package pin such as Eve's also requires a scoped runtime read-back. Symphony
releases are commit bundles on its existing minute clock. Compare its running
commit to the desired released commit through Symphony's own status receipt.
A commit SHA or managed service with no published stable version cannot be
compared as semver.

Use one read-back per environment with the existing documented version sources.
Store the raw evidence in the runtime store and pass the drift command only
tool IDs and their versions and UTC dates. The installed input is keyed by
registry ID with `version` and `observedDate`. The upstream input is keyed by
the same ID with a stable `version`, `releasedDate`, and a boolean `security`
from the documented release channel.

```sh
node scripts/tooling-drift.mjs versions --readback readback.json --upstream upstream.json
```

The report records declarations and observed versions in separate fields. It
flags version lag once a release has cleared the applicable tier's minimum age
and a read-back on or after that date still sees the older version. A security
release has no cooldown. A read-back taken before eligibility or a missing
source stays unverified and requires fresh evidence. Version lag does not say
whether the upgrade has passed its release checks.

Gem's host owner can use the existing Symphony clock to emit at most one host
receipt per UTC week. Include the UTC observation time, running kernel release,
pending security upgrade count, last reboot time and observed state of automatic
security updates. Keep package names, host identifiers, addresses, or paths out
of the receipt. The first successful read-back and proof that security upgrades
run automatically are required before `gem-host` can be marked covered. The
`agent-fleet` entry stays a gap until a scheduled producer and version
read-backs are verified. The inventory and drift command do not schedule work
or apply updates.

## Cost and clocks

Dependabot is the clock for upstream releases; the guard runs only on PR and
push events. No new schedules.
