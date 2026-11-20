/**
 * Asserted-docs ratchet helpers (JovieInc/Jovie #26117 / JOV-12618).
 *
 * When structural suites assert tracked markdown / rule paths, those paths
 * must appear in the structural control-path pattern (or an explicit
 * exclusion). Otherwise a docs-only merge group can skip the assertions.
 *
 * Consumers own suite scanning; this module validates coverage once paths are
 * known. Prefer one ERE alternative per line in the control-path file.
 */

/**
 * Parse a structural-control-paths.ere body into a joined ERE pattern.
 * Blank lines and `#` comments are ignored.
 * @param {string} text
 * @returns {string}
 */
export function joinControlPathAlternatives(text) {
  return String(text || '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .join('|');
}

/**
 * @param {string} pattern joined ERE
 * @param {string} path repo-relative path
 * @returns {boolean}
 */
export function controlPathMatches(pattern, path) {
  if (!pattern) return false;
  try {
    return new RegExp(pattern).test(path);
  } catch {
    return false;
  }
}

/**
 * Fail when a tracked asserted doc path is neither covered nor excluded.
 * @param {{
 *   assertedPaths: readonly string[],
 *   controlPattern: string,
 *   exclusions?: readonly string[],
 * }} input
 * @returns {{ok: boolean, missing: string[]}}
 */
export function assertAssertedDocsCovered({
  assertedPaths,
  controlPattern,
  exclusions = [],
}) {
  const excluded = new Set(exclusions);
  const missing = [];
  for (const path of assertedPaths) {
    if (excluded.has(path)) continue;
    if (!controlPathMatches(controlPattern, path)) missing.push(path);
  }
  return { ok: missing.length === 0, missing };
}

/**
 * Example control-path lines consumers can adapt (not Jovie-complete).
 * Keep repo-specific asserted docs in the consumer's own .ere file.
 */
export const ASSERTED_DOCS_CONTROL_PATH_EXAMPLE = Object.freeze([
  '# Tracked markdown / rules asserted by structural suites must select structural',
  '# so docs-only merge groups cannot skip those assertions (JOV-12618).',
  '^AGENTS\\.md$',
  '^README\\.md$',
  '^CONTRIBUTING\\.md$',
  '^docs/[^/]+\\.md$',
]);
