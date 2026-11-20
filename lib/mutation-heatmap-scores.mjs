// Merge live Stryker reports with a committed mutation-score baseline so a
// coverage heatmap Mut column is never blank for floors already measured.
// Live Stryker wins on conflict. Baseline keys are app-root-relative by default.
//
// Source: JovieInc/Jovie #26159 (`scripts/lib/mutation-heatmap-scores.mjs`).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scoreMutants } from './mutation-score-math.mjs';

export const DEFAULT_WEB_ROOT = 'apps/web';
export const DEFAULT_STRYKER_REL = 'apps/web/reports/stryker-incremental.json';
export const DEFAULT_BASELINE_REL = 'scripts/mutation-score-baseline.json';

/**
 * Live Stryker scores use the same contract as mutation floors: exclude
 * CompileError from the denominator, and skip a file when unknown statuses
 * (Timeout / Ignored / Pending / …) make the score incomplete so baseline
 * floors can fill the gap instead of understating Mut.
 * @param {string} filePath
 * @param {{ webRoot?: string }} [options]
 * @returns {Record<string, number> | null}
 */
export function scoresFromStrykerReport(filePath, options = {}) {
  if (!existsSync(filePath)) return null;
  const webRoot = options.webRoot ?? DEFAULT_WEB_ROOT;
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8'));
    if (!raw || typeof raw !== 'object' || !raw.files) return null;
    /** @type {Record<string, number>} */
    const scores = {};
    for (const [file, payload] of Object.entries(raw.files)) {
      const mutants = payload?.mutants ?? [];
      if (!Array.isArray(mutants) || mutants.length === 0) continue;
      const scored = scoreMutants(mutants);
      if (scored.score == null) continue;
      scores[normalizeRepoWebPath(file, webRoot)] = scored.score;
    }
    return Object.keys(scores).length > 0 ? scores : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} filePath
 * @param {{ webRoot?: string }} [options]
 * @returns {Record<string, number> | null}
 */
export function scoresFromMutationBaseline(filePath, options = {}) {
  if (!existsSync(filePath)) return null;
  const webRoot = options.webRoot ?? DEFAULT_WEB_ROOT;
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8'));
    if (!raw || typeof raw !== 'object' || !raw.files) return null;
    /** @type {Record<string, number>} */
    const scores = {};
    for (const [file, entry] of Object.entries(raw.files)) {
      const measured = entry?.measured;
      if (typeof measured !== 'number' || Number.isNaN(measured)) continue;
      scores[normalizeRepoWebPath(file, webRoot)] = Math.round(measured);
    }
    return Object.keys(scores).length > 0 ? scores : null;
  } catch {
    return null;
  }
}

/**
 * Prefer live Stryker; fill gaps from the committed baseline floors.
 * @param {{
 *   strykerPath?: string,
 *   baselinePath?: string,
 *   repoRoot?: string,
 *   webRoot?: string,
 * }} [options]
 * @returns {Record<string, number> | null}
 */
export function readMutationHeatmapScores(options = {}) {
  const repoRoot = options.repoRoot ?? process.cwd();
  const webRoot = options.webRoot ?? DEFAULT_WEB_ROOT;
  const strykerPath =
    options.strykerPath ?? join(repoRoot, DEFAULT_STRYKER_REL);
  const baselinePath =
    options.baselinePath ?? join(repoRoot, DEFAULT_BASELINE_REL);

  const live = scoresFromStrykerReport(strykerPath, { webRoot });
  const baseline = scoresFromMutationBaseline(baselinePath, { webRoot });
  if (!live && !baseline) return null;
  return { ...(baseline ?? {}), ...(live ?? {}) };
}

/**
 * Normalize app-relative, repo-relative, or absolute paths to
 * `<webRoot>/...` so they match surface file inventories.
 * @param {string} file
 * @param {string} [webRoot]
 * @returns {string}
 */
export function normalizeRepoWebPath(file, webRoot = DEFAULT_WEB_ROOT) {
  const root = String(webRoot).replaceAll('\\', '/').replace(/\/$/u, '');
  const normalized = String(file).replaceAll('\\', '/');
  const marker = `/${root}/`;
  const idx = normalized.lastIndexOf(marker);
  if (idx !== -1) {
    return normalized.slice(idx + 1);
  }
  if (normalized.startsWith(`${root}/`)) {
    return normalized;
  }
  return `${root}/${normalized.replace(/^\.\//u, '')}`;
}
