# Mutation heatmap adoption checklist

Pin `JovieInc/ci@<full-sha>` after this package lands. Then:

1. **Score math** — import `scoreMutants` from
   `lib/mutation-score-math.mjs` (or a vendored copy). Do not reimplement
   kill/CompileError/Timeout rules.
2. **Heatmap feed** — call `readMutationHeatmapScores` so committed floors fill
   Mut when live Stryker is absent or incomplete.
3. **Surface tokens** — use `extractSurfaceTokens` + `testPathMatchesSurface`
   so single-file surfaces (`proxy.ts` → `proxy`) match E2E inventory under
   `apps/<pkg>/` only.
4. **Baseline** — keep `direction: lock_up`; measured ≥ floor; floor only rises.
5. **Gates** — never lower a required Mut floor or skip Mutation Diff to land.

Optional path filter for self-tests:

```yaml
# templates/mutation-heatmap/fragments/contract-paths.yml
paths:
  - 'lib/mutation-score-math.mjs'
  - 'lib/mutation-heatmap-scores.mjs'
  - 'lib/coverage-surface-tokens.mjs'
  - 'test/mutation-score-math.test.mjs'
  - 'test/mutation-heatmap-scores.test.mjs'
  - 'test/coverage-surface-tokens.test.mjs'
  - 'docs/mutation-heatmap.md'
  - 'templates/mutation-heatmap/**'
```
