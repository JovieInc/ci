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
