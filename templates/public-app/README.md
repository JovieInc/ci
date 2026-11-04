# Public app scaffold

Run by `pin-bump.yml` for every repo that `canon/public-apps.json` registers an
app to. It adds, without overwriting anything:

- `certification/<app>.json`: the certification config stub (TODO markers fail validation until filled)
- `certification/personas.json`, `certification/calibration.json`: buyer-eval archetypes and calibration set
- `certification/tracker-registry.json`: the app's tracker registry
- `certification/flows/web.mjs`: golden-path flow stub for the walker
- `.github/workflows/public-app-certification.yml`: the shared certification workflow, pinned

The customer-voice route, waste and capacity ids are required fields of the
config, so a scaffolded app is red until they exist. Policy:
`canon/PUBLIC-APP-CERTIFICATION.md`. Manual run:

    node templates/public-app/bootstrap.mjs --repo JovieInc/X --target ../X --sha $(git rev-parse HEAD)
