# Portable mutation heatmap + surface tokens

Source: JovieInc/Jovie #26159 (heatmap Mut baseline feed, surface-token
matcher, canonical `scoreMutants`).

**Distribution (JOV-6555):** consumers pin a full commit SHA of `JovieInc/ci`
and adopt via separate upgrade PRs. Nothing here changes branch protection,
credentials, or live controllers. Never weaken required gates.

**Not summer-config:** inheritance surface is **this repository**.

## Libraries

| Module | Role |
| --- | --- |
| `lib/mutation-score-math.mjs` | `scoreMutants` — CompileError out of denominator; Timeout/Ignored/Pending withhold score |
| `lib/mutation-heatmap-scores.mjs` | Live Stryker overlays committed floors; incomplete live scores defer to baseline |
| `lib/coverage-surface-tokens.mjs` | Stem tokens + `apps/<pkg>/` prefix + symmetric `[/._-]` boundaries |

## Pin / adopt (sibling repos)

1. Pin `JovieInc/ci` at the merge SHA of this change (full 40-char commit).
2. Copy or vendor-import the three `lib/*.mjs` files into the consumer's scripts
   tree (Jovie keeps them under `scripts/lib/` and may re-export). Prefer a thin
   re-export that imports from a vendored pin directory rather than rewriting
   scoring math in-repo.
3. Wire the consumer heatmap / risk audit to call
   `readMutationHeatmapScores({ repoRoot, baselinePath, strykerPath, webRoot })`.
4. Attribute inventory tests with `testPathMatchesSurface(path, surface)`.
5. Keep a shrink-only / lock-up `mutation-score-baseline.json` in the consumer;
   floors only rise.

## Contract tests

```bash
node --test \
  test/mutation-score-math.test.mjs \
  test/mutation-heatmap-scores.test.mjs \
  test/coverage-surface-tokens.test.mjs
```

Workflow: `.github/workflows/mutation-heatmap.yml` (path-filtered).

## Template notes

See [templates/mutation-heatmap](../templates/mutation-heatmap/README.md) for a
consumer checklist. YAML fragments are documentation-only; consumers own their
required checks.
