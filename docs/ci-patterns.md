# Portable CI patterns for fleet inheritance

Source: JovieInc/Jovie merged PRs #26115, #26116 (JOV-13072 M1/M2), #26117
(JOV-12618). Implemented here as libraries + YAML fragments under
`lib/` and `templates/ci-patterns/`.

**Distribution (JOV-6555):** consumers pin a full commit SHA of `JovieInc/ci`
and adopt via separate upgrade PRs. Nothing here changes branch protection,
credentials, or live controllers. Never weaken required gates.

**Not summer-config:** `JovieInc/summer-config` is Summer/Hermes fleet identity.
These workflow patterns inherit from **this repo**, not summer-config.

## 1. Source-guard pooling (`runSourceGuards`)

| | |
| --- | --- |
| Jovie | #26115 — Source Validation disk-read guards via `ci-source-guard-pool` |
| Here | `lib/command-pool.mjs`, `lib/source-guard-pool.mjs` |
| Fragment | `templates/ci-patterns/fragments/source-guard-pool-step.yml` |

**Contract:** every selected guard still runs; first failure in list order sets
the exit code; log blocks stay list-ordered; shared locks (e.g. `git`) never
overlap; default concurrency ≤3; `SOURCE_GUARD_CONCURRENCY=1` = serial.

**Consume:** import `runSourceGuards` from a pinned checkout; keep guard
*selection* repo-owned. Replace serial `spawnSync` loops only.

## 2. Same-name fail-closed fan-in + matrix shards

| | |
| --- | --- |
| Jovie | #26116 / JOV-13072 — `ci-fast` remaining + structural-lanes shards |
| Here | `lib/fail-closed-fanin.mjs` |
| Fragment | `templates/ci-patterns/fragments/fail-closed-fanin.yml` |

**Contract:** required check **name** stays on the fan-in job; matrix workers
are not required by name; `fail-fast: false`; fan-in `if: always()` (after
admission); gate exits non-zero for `failure|cancelled|skipped|missing`; no
`continue-on-error` on the gate or evidence downloads.

**Consume:** split a long critical-path job into `*-shards` + same-name fan-in.
Add a consumer contract test that only `SHARDS_RESULT=success` greens.

## 3. Docs-only classifier + structural skip

| | |
| --- | --- |
| Jovie | #26117 / JOV-12618 — `docs_only` + structural-control-paths + asserted-docs |
| Here | `lib/docs-only.mjs`, `lib/asserted-doc-paths.mjs` |
| Fragment | `templates/ci-patterns/fragments/docs-only-structural-skip.yml` |

**Contract:** merge groups skip structural only when `docs_only=true` **and**
the path decision against the classified base selects nothing. Missing
`docs_only`, unusable base, empty diff, or any control-path hit → run
structural. Tracked asserted docs must stay covered by
`structural-control-paths.ere` (ratchet) or an explicit exclusion.

**Consume:** emit `docs_only` from path classification; wire
`STRUCTURAL_DOCS_ONLY` into the structural decision; add the asserted-docs
ratchet test before enabling skips.

## Per-repo adoption

| Repo | How to consume |
| --- | --- |
| **Jovie** | Already landed in-tree. Next: optionally re-export / pin this SHA for the portable libs to avoid drift, or leave Jovie as reference implementation and treat this repo as the sibling source. |
| **LogYourBody** | Pin `JovieInc/ci@<sha>`. Adopt fan-in first if MQ critical path is a single long job; add docs_only only if merge queue + structural control paths exist. Guard pooling when serial disk-read guards dominate a required job. |
| **symphony-control** | Same pin. Prefer fan-in+matrix for multi-suite required jobs; docs_only only with an asserted-docs ratchet against that repo’s control-path file. |
| **summer-config** | Do **not** move these patterns into summer-config. Optionally document the pin in operator notes; workflows continue to `uses:` / import from `JovieInc/ci`. |

## Rollback

Revert the consumer upgrade commit (known-good pin). Sibling repos are
unaffected. Revert this PR on `JovieInc/ci` if the portable API needs
withdrawal; Jovie keeps its in-tree originals.
