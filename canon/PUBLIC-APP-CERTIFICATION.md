# Public app certification standard

Applies to every public-facing paid or freemium app the company runs (web, iOS,
desktop, extension). It is company policy: apps never copy it, they point here
and supply a small config. A repo may be stricter, never looser.

Origin: Tim, 2026-10-31: "I want onboarding to LYB to be as tested and guarded
as Jovie. The same 'would this person buy' should be applied there too. This
whole ethos and system should be centralized and applied to all our
public-facing paid or freemium apps." And: "Future apps must inherit all of
this automatically. No per-app opt-in."

## What "certified" means

An app is certified on a production SHA when one signed receipt
(`company.cert-receipt/v1`) shows all of these, each folded strictly (at least
one check, every check passed; skipped, blocked or missing is never green):

1. **Golden-path walk.** An agent walks production on video, with canary or
   test accounts only, through every stage in the app config: install or visit,
   sign up, onboarding, first value, paid conversion. A vision judge checks
   every frame. Each stage asserts its semantic outcome with an oracle (this
   user, the value they asked for), never presence alone. Error, quota,
   placeholder, empty and "coming soon" surfaces fail, including a 200 with an
   error body (`certify/lib/outcome-verifier.mjs`).
2. **Buyer eval: would this person pay.** The walk is judged as the buyer by a
   strong-tier model in isolation (no repo, no company memory; contamination
   canary voids a sample). Outcome: a paid conversion at the live price, read
   from the app's own price source, failing closed if unparseable.
   - Calibration holds on the current rubric: at least 3 known-bad walks are
     `no_pay`, and the off-ICP control is `no_pay`. A judge that says pay to a
     control is sycophantic and its yes means nothing.
   - "Ready" needs a positive canary plus a `pay` verdict (median p >= 0.60,
     every coherent sample >= 0.50, entering ready >= 0.65). Until a positive
     canary exists the buyer gate stays closed by design; certification then
     records the buyer verdicts and objections and files them as work.
   - The gate output means "ask Tim". Nothing is ever sent to a real user.
3. **Privacy compliance.** Inventory crawl of public and input pages under the
   app's scenarios, rules with negative controls (a run whose seeded
   violations do not all fail is itself a failure), an evidence log, and a
   tracker registry where every third party has a rationale. Profiles:
   - `standard`: gbrain `decisions/company/privacy-tracking-compliance-guidelines-2026-10-31`.
   - `health` (stricter, any app that processes consumer health data, such as
     weight, body composition, photos of the body, HealthKit): no ad pixel,
     retargeting or session replay anywhere on the app's surfaces without a
     recorded counsel sign-off; no health data to analytics vendors; opt-in
     consent before collecting consumer health data and a separate opt-in
     before sharing it (Washington My Health My Data Act, RCW 19.373); a
     linked consumer health data privacy policy; CCPA sensitive personal
     information limits and a "Limit the Use of My Sensitive Personal
     Information" path where SPI is used beyond what the service needs; FTC
     Health Breach Notification Rule (16 CFR 318) readiness, since an
     unauthorized disclosure (including to an ad platform) is a breach.
4. **Customer voice.** Every customer message on every channel the app owns
   (support email, in-app feedback, chat, App Store review replies) reaches Tim
   through Summer with a drafted reply he approves. Nothing replies to a
   customer without that approval.
5. **Waste and capacity.** The app is registered in the waste registry and the
   capacity collector, so its cost per active user is measured.

## Rules

- Canary and test accounts only. No real user data, no PII in repos, no
  outbound to real users. Real-signup personas use public facts only, live in
  a private state directory (0600), never in git.
- Every stage records machine timestamps keyed to the walk id (p50/p95 per
  stage is a tracked metric).
- Taste calls (copy, ICP, price) get a default plus a deadline, then ship.
- Defects found by a walk are fixed in small `compounding` PRs, each leaving a
  guard. Loop until certified, or until something genuinely needs Tim.

## Machinery (one implementation, small per-app config)

| Piece | Where |
|---|---|
| This policy | `canon/PUBLIC-APP-CERTIFICATION.md` |
| App registry (every public surface is classified) | `canon/public-apps.json` |
| Per-app config schema and validator | `certify/schema/app-cert.schema.json`, `certify/config.mjs` |
| Runtime kit (walk, frame judge, buyer eval, privacy, voice, receipts) | `certify/` |
| Reusable workflow (static checks in app CI) | `.github/workflows/public-app-certification.yml` |
| Guard in every consumer | `guards/plugins/public-app-certification.mjs` |
| Launch guard and freshness scan | `scripts/public-app-scan.mjs`, `.github/workflows/public-app-scan.yml` |
| Scaffold for new apps (on by default) | `templates/public-app/`, run by `pin-bump.yml` |

Per-app config lives at the path in the registry (default
`certification/app.json`): golden-path stages and flow module, personas and
calibration set, paid outcome and its price source, data class and privacy
profile, tracker registry, customer channels, waste and capacity ids.

## Inherit by default

- Registering a public app means adding it to `canon/public-apps.json`. On the
  next pin bump the consumer gets the scaffold (cert config stub, workflows,
  tracker registry, customer-voice route, waste and capacity registration).
  No per-app opt-in.
- Every public domain and every canonical Vercel project in
  `canon/resources.json` must be classified in `canon/public-apps.json` (as an
  app surface, or as internal or non-paid with a reason). An unclassified
  surface fails the launch scan.
- An app at stage `public` needs a passing receipt younger than
  `maxReceiptAgeDays`. Stage `prelaunch` needs a valid config only. Moving an
  app to `public` without a passing receipt fails the launch scan.
- Receipts are data, not code: the runner records them as a GitHub deployment
  on the app repo (environment `certification`, status `success` only for a
  certified receipt, payload = receipt digest and summary). The guard reads
  them from there.
- New apps get an `enforceFrom` date at registration (default: 7 days).
  Before it, a missing receipt warns; after it, it fails.
