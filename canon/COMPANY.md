# Company canon

Source of truth for rules that apply to every JovieInc repo. Taste, opinionated
and architecture calls are company-wide, not repo-wide. A repo's AGENTS.md points
here and adds only a small repo-specific delta. Where this file and a repo copy
disagree, this file wins; a repo may be stricter, never looser.

Pointer line every repo AGENTS.md must contain (checked by `guards/run.mjs`):

    Company canon: JovieInc/ci canon/COMPANY.md (applies in full; this file is the repo delta).

## How a guard becomes company-wide

1. Ship the guard once, as a module in `guards/plugins/` (see `guards/run.mjs`).
   Register it in `canon/guards.json` with an id, owner and ratchet mode.
2. Guards are ratchets: existing violations are baselined in the consumer
   (`.company-guards/*-baseline.json`); new or worse violations fail.
3. Merging to `main` here triggers `pin-bump.yml`, which opens a PR in every
   repo in `canon/consumers.json` moving its SHA pin. Consumers never track a
   branch.
4. Drift check (`guards/drift.mjs`, inside the shared workflow): a repo whose
   pin is more than 72h behind the newest canon/guard commit fails CI.

## Data vs behaviour (ratchet)

Data lives in runtime stores; git holds behaviour. Wins, receipts, proof stats,
metric and capacity snapshots, evidence, handoff notes and generated daily
baselines are data: write them to the runtime store (Summer store, gbrain,
Linear, Ovie DB or the capacity feed) through its API or CLI, never through a
PR. Registries that define behaviour stay in git, and a row changes only when
the behaviour changes, never as a log. The `data-paths` plugin
(`guards/plugins/data-paths.mjs`) fails a PR whose diff is only data paths or
only appended registry rows, and fails any new tracked data file (the count in
`.company-guards/data-paths-baseline.json` may only shrink). Globs per repo live
in `canon/data-paths.json` only; label `data-exception` waives one PR.

## Agent rules (all repos)

- Single source of truth: every fact has one canonical source; copies fail lint.
  Before creating a repo, Vercel project, domain, Doppler project or worker, look
  it up in `canon/resources.json`; `guards/resources.mjs can-create` refuses when
  an entry with the same purpose exists. Merge into the existing one instead.
- Never @mention a person unless they are in `canon/mention-allowlist.json`.
  Agent mentions are limited to one per person per hour. Bot and tool names in
  prose go in backticks.
- Never delete or archive a resource on your own; destructive steps need Tim's yes.
- Never `--no-verify`, never stash, never run git in a human's main checkout.
- Fix red CI; do not skip it. Machines review code, humans review taste.

## Architecture and anti-slop (ratchets)

- File size: no source file over 500 lines; baselined files may not grow
  (`guards/size.mjs`).
- Pass-through wrappers, single-implementation abstractions and similar slop
  guards land as `guards/plugins/*.mjs` (JOV-9975), not per repo.
- Build vs buy: check the existing capability and the registry before building.
- Shared config (biome, knip, jscpd, tsconfig base) lives in `canon/config/`
  and repos extend it. Taste and design tokens: the Jovie `canon/DESIGN.md`
  and `design.tokens.json` remain authoritative until moved here.
