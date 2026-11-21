# CI speed patterns (portable)

Reusable fragments promoted from JovieInc/Jovie (#26115, #26116 / JOV-13072,
#26117 / JOV-12618). Pin a **full commit SHA** of `JovieInc/ci` (JOV-6555).
These patterns never weaken required gates: same checks, fail-closed fan-in,
fail-closed docs-only skips.

Libraries (import from a pinned checkout or copy under review):

| Module | Pattern |
| --- | --- |
| `lib/command-pool.mjs` | Bounded lock-aware command pool |
| `lib/source-guard-pool.mjs` | `runSourceGuards` disk-read guard pooling |
| `lib/fail-closed-fanin.mjs` | Same-name matrix fan-in gate |
| `lib/docs-only.mjs` | `docs_only` + structural skip decision |
| `lib/asserted-doc-paths.mjs` | Asserted-docs ↔ control-paths ratchet |

YAML sketches live in `fragments/`. Adapt job ids and path globs per repo;
keep required check **names** stable when introducing shards.

## Adopt

1. Open a consumer PR that pins `JovieInc/ci@<sha>` (or vendors the reviewed
   files with the same SHA recorded in the PR body).
2. Qualify in shadow if the check is new; existing required names stay enforced.
3. Revert the consumer commit to roll back; siblings keep their pins.

`summer-config` is fleet identity / dispatch — **not** the inheritance surface
for these workflow patterns. Consume from `JovieInc/ci`.

See [docs/ci-patterns.md](../../docs/ci-patterns.md) for per-repo notes.
