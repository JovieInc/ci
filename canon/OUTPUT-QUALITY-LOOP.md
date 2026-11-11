# Output quality loop

Canonical. Rule from Tim White, 2026-11-01. Every agent's instructions point
here and add no looser rule. Where a copy disagrees, this file wins.

> "Anything agents build follows those rules. I don't care if it's a memo or a
> thank-you card to a vendor."

Scope: everything an agent produces for a person to read, watch or use. That
includes memos, docs, texts and emails (to Tim, customers, vendors), social
posts, video, decks and investor content, UI and app screens, and HTML
artifacts. There is no exempt output.

Why: a first draft that is technically correct can still miss what it was for.
Tim's example: asked to help him tell the time as quickly as possible, an agent
shows 50 clocks for every time zone. Every number is a time, and the mission
still fails. Pretend to be Tim, look at the screen and ask: can Tim see the time
quickly? What could make it quicker? Do not ship the first draft.

## 1. Declare the mission and the audience

Before building, write two lines and keep them with the output:

- **Mission:** what the output must achieve, in one line, as an outcome for the
  audience. "Help Tim tell the time as quickly as possible", not "show times".
- **Audience:** who will read or use it, in their terms (what they know, what
  device they use, how long they will give it).

Presets: `tim`, `customer`, `vendor`, `investor`, `buyer`. An output without a
mission cannot pass the eval; the tool refuses to run without one.

## 2. Gates (deterministic first, all of them)

| Gate | What fails | Source of truth |
|---|---|---|
| Brand and design system | Off-brand voice; raw colors or fonts outside design tokens; light-first visuals; failed visual design rules | Jovie `canon/VOICE.md`, `design.tokens.json`, `DESIGN.md`, Clef screenshot rules |
| Slop | Filler, hedging, AI cliches, em dashes, generic phrasing | `@jovie/copy` rules, anti-slop registry, `slop-guard` ratchets here |
| Data integrity | Any claim-like number not in the claims ledger; retired claims; two numbers that contradict each other; stale data presented as current | Claims ledger (fundraising registry `claims.yaml` + `metrics.yaml`), product truth |
| Harm and the brand line | Anything illegal, defamatory, hateful, mean-spirited, or that targets a person or group. Edgy, provocative and profane are fine when legal and harmless. | Copy lint floor (harm, legal, privacy); judge harm check |
| Privacy | Secrets, personal contact data, private identities, internal-only data in external output | Copy lint privacy rules; privacy gate |

A gate that cannot run (missing ledger, no model credit) reports `unavailable`
or `abstain`. That is never a pass.

## 3. Audience-intent eval

A judge role-plays the declared audience and looks at the output as it will be
delivered: a rendered screenshot for anything visual, frames for video, the
exact text for messages. It answers:

1. What do I notice and understand in the first five seconds?
2. Does this achieve the mission for me? Correct but slow, cluttered,
   confusing, generic or off-target does not.
3. A score from 0 to 100.
4. The single biggest issue between this output and the mission.
5. The single most impactful change, concrete enough to apply without asking.
6. Any harm, legal risk, or unsupported or contradictory claims.

Pass: the mission is achieved, the score meets the bar (80 routine, 85 high
stakes), and nothing harmful is flagged.

Route (sanctioned, no new spend):

- Routine output: one system-1 sample on Cloudflare Workers AI (routing caller
  `dev.intent-eval`).
- High stakes (investor, legal, public launch, decks): three independent
  samples on `dev.intent-eval-strong`, and every sample must pass. A paid
  stronger model is new spend and needs Tim.

## 4. Iterate until it passes

Fix the top issue, then evaluate again. Repeat until it passes or the pass
budget runs out (default 3). Out of budget, report the remaining issues
honestly with the next change; never present a failing output as done. Only
the passing version is delivered.

## 5. Evidence record

Every pass is recorded with entry and exit timestamps, keyed to a run id
(measure-everything rule), so passes-to-pass and time-to-pass have p50 and p95.

- Receipt line, carried by every PR that changes user-facing output and by
  every message Summer sends:
  `Intent-eval: jovie.intent-eval/v1 run=<id> verdict=<pass|fail|abstain> score=<n> passes=<n> sha256=<12 hex> mission="<...>"`
  or `Output-check: jovie.output-check/v1 run=<id> verdict=... gates=... intent=...`.
  When it does not apply: `Intent-eval: n/a - <reason>`.
- Local store: `~/.local/state/jovie-intent-eval/` (`passes.jsonl`,
  `checks.jsonl`, `runs/<id>/receipt.json` with every version of the artifact).

## 6. Tools

One entry point, from a Jovie checkout (`JovieInc/Jovie` `scripts/output-quality/`):

    jovie output check <file|url|image|video> --kind memo|social|video|deck|ui|email|sms|doc|artifact \
      --mission "<one line>" --preset tim|customer|vendor|investor|buyer [--audience "<who>"] --fix auto

    jovie eval intent --mission "<one line>" --audience "<who>" --artifact <file|url|screenshot> [--fix auto]

Without the `jovie` wrapper: `pnpm output:check` / `pnpm eval:intent`.
`--fix auto` revises text and HTML; `--fix cmd:<shell>` runs your own fixer
between passes. Buyer-eval and the would-you-invest deck eval are presets and
rubrics on the same judge core; a new audience eval adds a rubric, never a
transport.

## 7. Enforcement

| Where | Check | Mode |
|---|---|---|
| PRs that touch user-facing paths | Fleet Rules evidence requires a receipt line in the PR body | warn |
| Summer's messages to Tim and customers | Summer runs the check before sending and records the receipt in the send ledger | warn |
| Mesh swarm tasks that return an output | The task result carries the receipt line; a result without one is not done | warn |

Warn mode flips to blocking only after calibration: the judge must land every
known-good and known-bad fixture on its expected verdict on repeated runs.
Tim's every-time-zone clock is a must-fail fixture. Calibration lives in
Jovie `scripts/output-quality/fixtures/calibration.json` and its record in
`scripts/output-quality/policy.json`.

## 8. Pointer line for agent instructions

Every agent's AGENTS.md, system prompt or custom instructions contains:

    Output quality: JovieInc/ci canon/OUTPUT-QUALITY-LOOP.md. Every output (memo, text, email, post, video, deck, UI, artifact) states mission and audience, passes brand/DS, slop, claims-ledger and harm checks, then an audience-intent eval loop until it passes (`jovie output check`). Never ship the first draft; carry the receipt.
