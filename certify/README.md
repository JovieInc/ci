# Shared app certification kit

Run from the app checkout. All app-specific inputs belong in its
`certification/<app>.json`; `validate` retains the registry-based static check.
The runtime is Node 24 ESM with no npm dependencies. The app supplies Playwright
in its own `node_modules` for privacy crawling; importing the kit needs none.

## Part A API

| Module | Exports |
|---|---|
| `lib/outcome-verifier.mjs` | `verifyOutcome`, `assertOutcome`, `detectFailureSurface`, `foldVerdict`, `acceptedNegativeControls`, `FAILURE_SURFACE_RULES`, `NEGATIVE_CONTROLS`, `POSITIVE_CONTROLS` |
| `privacy/privacy-inventory.mjs` | `crawl({config, cwd?, registry?, chromium?, fetchImpl?})`, `loadRegistry`, `isFirstParty`, `SCENARIOS`, `SNAPSHOT_SCHEMA` |
| `privacy/privacy-rules.mjs` | `evaluate(snapshot, registry, config)`, `runControls(evaluateFn?, config?)`, `summarize`, `analyzePolicy`, `vendorFor`, `isInputPage`, shared rules and controls |
| `privacy/health-rules.mjs` | `evaluateHealth`, `healthFieldKeys`, `analyzeHealthClaims`, `HEALTH_RULES`, `HEALTH_FIELDS`, `HEALTH_CLAIMS` |
| `privacy/privacy-check.mjs` | `buildRecord(snapshot, registry, config)`, `toMarkdown`, `RECORD_SCHEMA` |
| `voice/classify.mjs` | `urgentReasons`, `isFeedbackTurn`, `isAutomatedEmail`, `URGENT_REASONS` |
| `voice/contract.mjs` | `buildEvent(input, config, {env?})`, `validateEvent(event, config)`, `postToSummer`, `redactText`, `EVENT_SCHEMA` |
| `receipt.mjs` | `buildReceipt(config, inputs)`, `signReceipt(receipt, {config, key?, cwd?})`, `verifyReceipt(receipt, {key?, config?})`, `publishReceipt`, `receiptChecks`, `receiptDigest`, `canonicalJSON`, `RECEIPT_SCHEMA` |

Verifier options take `expect` (regex or predicate) and the app config's
`verifier.extraFailurePatterns` (regex source strings or `{id, kind, pattern}`
objects). Extra patterns add to the shared detector. The detector preserves
failure-kind allowances for deliberate negative-path probes.

## Privacy inputs and evidence

`privacy.registry` is resolved inside the app repo, including symlink checks.
Vendors retain `id`, `category`, `hosts`, `rationale`, `approved`, `policy_names`
and optional `allowed_on_input_pages` from the source contract.

`privacy.firstPartyDomains` is required at runtime. `privacy.crawl` supplies
URLs, optional ids, `input`, and `young_audience`; registry surfaces/domains
never override the app config. Each page runs `us-default`, `us-gpc`, `eu`, and
`eu-accept`. An optional `privacy.consentRegionCookie: {name, required, optional}`
controls the app's existing client consent-region switch. This tests client
consent gating, not edge geolocation. Additional policy URLs may be supplied in
`privacy.policies`; `policyUrl` and `healthPolicyUrl` are always included.

The homepage is `privacy.homepageUrl`, the crawl entry marked `homepage`, or the
first crawl entry. Health policy links must be distinct from the ordinary policy.
Counsel sign-off only exempts the extra health ad/replay ban; shared input-page,
GPC, consent, disclosure and minors checks still apply. Health request inspection
persists matching field names only, never query/body values or cookie values.
Use public pages and canary accounts only. Keep output outside tracked files.

An evidence record passes only with usable pages, complete configured scenarios,
versioned policies, matching registry digest, all evaluated checks passing and
all controls working. Warnings and missing evidence block certification.

## Voice and receipt inputs

`buildEvent` takes `{channel, messageId, from, text, receivedAt?, draftReply?}`.
It hashes the normalized sender using `CUSTOMER_VOICE_SALT` and redacts contacts.
Send the event to Summer using
`postToSummer(event, {url: env[config.customerVoice.sink], token: env.SUMMER_CUSTOMER_VOICE_TOKEN})`.
This API only forwards a pending Tim approval event; it cannot reply to customers.

Receipt inputs are `{walk, buyer, privacy, voice?}`. Walk supplies `sha`, `runId`,
`startedAt`, `finishedAt`, and stages `{id, kind, verdict, tStartMs, tEndMs, evidence}`.
Buyer supplies `verdicts` (including objections), `calibration: {holdoutsNoPay,
controlNoPay, positiveCanary}`, and `gate`. Calibration fields are a count and two
booleans; `gate` is `ready` or a blocking value. Voice supplies `channelsCovered`
(or use `walk.voice`). The privacy input is the full evidence record.

Assembly produces a blocked unsigned draft. Signing checks every configured
stage/channel, privacy, calibration, waste and capacity IDs. It reads the app's
buyer calibration file unless the caller supplies the resolved `config.calibration`.
Its `positiveCanaries` array determines whether buyer readiness is required.
Signing requires `CERT_RECEIPT_SIGNING_KEY`; verification rejects tampering.
Publication uses the GitHub deployment/status API with environment `certification`,
no auto-merge and no required contexts; only a verified certified receipt gets
success. Repository gates themselves are unchanged.

## CLI

```sh
node /path/to/kit/certify/cli.mjs privacy --config certification/app.json --out /private/privacy.json --markdown /private/privacy.md
node /path/to/kit/certify/cli.mjs receipt --config certification/app.json --walk /private/walk.json --buyer /private/buyer.json --privacy /private/privacy.json --out /private/receipt.json
node /path/to/kit/certify/cli.mjs publish --config certification/app.json --receipt /private/receipt.json --repo owner/repo
```

`publish` needs `GITHUB_TOKEN` and the signing key; it is the only receipt command
that writes to GitHub. This port's tests mock publication and browser sessions;
no live deployment, customer event or app certification is implied.

The original source-wired outcome tests use frozen error-copy fixtures captured
from the source ref. Consumer CI can additionally check its evolving local copy.
Buyer evaluation, walk recording and frame judging are integrated separately.

## Part B: walk, frame judge, buyer eval

Run from the consumer repository. The app owns `certification/app.json`, the
flow module, public archetype briefs, price source and calibration walks.
All modules are Node ESM with no npm dependencies in this repository.

```sh
node /path/to/ci/certify/walk/cli.mjs --app-config certification/app.json --surface web --out /private/run --base-url https://your-app.example
node /path/to/ci/certify/buyer/cli.mjs run --app-config certification/app.json --walk /private/run --persona buyer --samples 3
node /path/to/ci/certify/buyer/cli.mjs calibrate --app-config certification/app.json --walk /private/run --sha FULL_SHA
node /path/to/ci/certify/buyer/cli.mjs gate --app-config certification/app.json --subject buyer --sha FULL_SHA --cert /private/judgement.json
```

The recorder dynamically resolves Playwright from the app's `node_modules`.
Set `CERT_CANARY_EMAIL`, optionally `CERT_CANARY_PASSWORD`, `CERT_SOURCE_SHA`
(the served build SHA), and `CERT_WALK_SUBJECT` (opaque canary subject id).
Override credential variable names with `goldenPath.accounts.env.email` and
`.password`. The recorder requires `accounts.emailPattern` and `canary-only`
policy. A supplied `account` must equal the environment-derived credentials.
The fallback SHA is the app's local Git HEAD; that alone is not production proof.

`goldenPath.flows[surface]` is a repo-relative ESM module with a default async
function receiving `{page, snap, settle, account, config, baseUrl}`. Call
`await snap(stageId, label)` after each semantic stage. A stage with a `surface`
applies to that surface; stages without one apply to every surface. Credentials,
OTP retrieval, provider adapters and any app-specific teardown belong in the
app's flow. The recorder performs no database cleanup. It preserves partial
evidence on failure, refuses nonempty output directories and never writes
credentials into metadata.

The evidence contract is `steps.json`, `walk.json`, `walk.webm`, `NN.png`, and
`dom/NN.txt`. `walk.json` binds the app, walk id, surface, subject, build SHA,
machine timestamps and strict stage checks. Each step also records its stage,
walk id and machine timestamps. Recording every stage is necessary; the judge
must separately verify each stage's semantic oracle. Artifacts must contain
only canary/test data and stay in private directories outside Git.

`judgeWalk({runDir, config})` in `judge/judge.mjs` judges every screenshot and
mid-window video frame against the stage oracle. It uses the shared
`lib/outcome-verifier.mjs` detector; part A supplies that module. Frame extraction
requires `ffmpeg` and `ffprobe` on PATH and fails closed when unavailable. An
empty, failed or missing check never passes. Output schema is
`company.walk-judgement/v1` with stage and step verdicts `pass|fail|abstain`.
The model transport is injectable as `run(args, cwd, timeoutMs)` for tests.
Production uses `claude -p` with a strong model, empty settings sources, empty
strict MCP configuration, no session persistence, only the Read tool, and a
fresh directory containing only copied frames. This uses CLI isolation, not an
OS filesystem sandbox. Evidence is explicitly untrusted data in the prompt.

`signReceipt`, `verifyReceiptSignature` and `gateDecision` in
`judge/receipt.mjs` authenticate the whole judgement and bind its SHA, app,
model, rubric, config and freshness. Set `CERT_JUDGE_SIGNING_KEY` and optionally
`CERT_JUDGE_SIGNING_KEY_ID` through the environment. Unsigned receipts fail the
gate. Judging and signing do not deploy, publish or invite anyone.

`readOutcome({cwd, config})` fails if the live price cannot be parsed, has
multiple matches, or differs from `paidOutcome.price`. Without `pricePattern`,
the price source must contain the complete configured numeric price string.
Currency, interval, plan, trial and free alternative all come from config.

`buyer.personas` is either a JSON file path or an array of `{id, brief, control}`.
`buyer.calibration` is either a JSON path or
`{holdouts:[{id,expect:'no_pay',walk,persona?}],positiveCanaries:[{id,expect:'pay',walk,persona?}],control?:{walk}}`.
Holdout ids must be distinct; at least three bad walks, one positive and every
configured off-audience control must hold. Calibration control uses `--walk`
unless `control.walk` is configured. These walks may remain in private state.

Tier B persona ids resolve only in the absolute `buyer.privatePersonaDir`,
outside all Git worktrees, as `ID.json` with mode 0600. Files contain
`{subjectId, facts, identityTokens}`. Public facts are whitelisted in
`buyer/personas.mjs`; contact information, private health facts and arbitrary
fields are rejected. Use opaque subject ids and supply identity tokens for
redaction. Real-signup facts must be verified public facts. The recorder still
uses only canary accounts. An archetype stand-in cannot qualify as an own walk.

`evaluate`, `judgeBuyer`, `calibrate`, `buyerReady` and the pure rubric functions
are exported from their corresponding buyer modules. `evaluate` writes private
hashed receipts and `cost.jsonl` to `~/.local/state/<app>-buyer-eval`. All model
samples must be valid and coherent for a positive result. Blocker objections
cap p(pay); repeated objections can produce local proposals via `fixProposals`.
No provider-specific issue publishing or external messaging is included.

The optional cheap screen uses an injectable `screenCall` transport, avoiding a
dependency on one app's provider client. A screen blocker needs deterministic
DOM confirmation. Missing screen configuration or a provider outage routes to
the strong judge. A strong model failure or contamination produces abstention.

`buyerReady` requires signed walk certification allowance on the same app/SHA,
current calibration, a fresh control `no_pay`, a fresh own-walk strong `pay`
(median >=0.60, every sample >=0.50, enter >=0.65), and `timYes === true`.
Before approval, `machineReady:true` yields `next:'ask-tim'` with `ready:false`.
The CLI's `--tim-yes` records an explicit human yes; it grants no sending action.
Receipts expire after three days. Output never sends anything.

Validation uses the repository's exact self-test selector with
`--experimental-test-coverage`. The test fixtures exercise a music product and
a fitness product. Live browser/model qualification requires app-owned canary
credentials and deployed-build evidence; unit tests do not establish that.
