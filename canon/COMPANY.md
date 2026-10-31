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
- Waste is continuously detected and fixed. Waste is money, API calls, tokens, CI
  minutes, queue rework, agent time, Tim's attention, notifications, storage, idle
  compute and tech debt. Tech debt is waste: no quarterly paydowns. Every waste
  class is normalised to an outcome (per active user, per merged PR) in the
  product repo's waste registry (Jovie `ops/registry/waste.json`), so anomalies show
  while absolute numbers are small. Each detection becomes a tracked fix with an
  owner, a generalization sweep (other apps, ops, agents), a fix at the highest
  layer, a durable guard, and before/after numbers in the wins store. A standing
  share of fleet capacity ships waste fixes every day.

## Verification: verify the outcome, not the action

A check that confirms something happened (a 200, a visible element, exit 0, a
non-empty reply) without confirming it was the right thing is false green
(Jovie JOV-9625: the golden path certified a chat reply that was a quota wall).
Every gate, canary, certification step and agent verify step:

- asserts the semantic outcome with an oracle (this artist, a real release, the
  value the probe asked for), never presence alone;
- treats error, quota, unavailable, empty and placeholder content as failure,
  including a 200 with an error body (Jovie `scripts/lib/outcome-verifier.mjs`);
- ships red before green: a negative control (known-bad input or seeded bug)
  proves the check fails before its green is trusted;
- folds strictly: pass needs at least one check and every check passed; no
  checks, skipped, blocked or a missing result is never green
  (`guards/plugins/vacuous-verdict.mjs`).

## Architecture and anti-slop (ratchets)

- File size: no source file over 500 lines; baselined files may not grow
  (`guards/size.mjs`).
- Pass-through wrappers, single-implementation abstractions and similar slop
  guards land as `guards/plugins/*.mjs` (JOV-9975), not per repo.
- Build vs buy: check the existing capability and the registry before building.
- Shared config (biome, knip, jscpd, tsconfig base) lives in `canon/config/`
  and repos extend it. Taste and design tokens: the Jovie `canon/DESIGN.md`
  and `design.tokens.json` remain authoritative until moved here.
