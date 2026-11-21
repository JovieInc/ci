/**
 * Docs-only classifier + structural skip decision (JovieInc/Jovie #26117 /
 * JOV-12618).
 *
 * A merge group may skip structural work only when:
 * 1. the trusted-base classifier marks every changed path documentation, AND
 * 2. the structural path decision, rerun against the group's exact classified
 *    base, selects nothing.
 *
 * Missing classifier output, unusable base, empty diff, or any structural
 * control hit fails closed (runs structural). Never skip on PR events via this
 * helper — PRs keep the full path decision.
 */

/**
 * Conservative markdown doc predicate. Consumers should tighten with their own
 * product/path rules (Jovie uses a richer classifier). Paths under `.github/`
 * are never docs-only here.
 * @param {string} path
 * @param {{deny?: RegExp[], allowExtra?: (path: string) => boolean}} [opts]
 * @returns {boolean}
 */
export function isMarkdownDocPath(path, opts = {}) {
  const normalized = String(path || '').replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('.github/')) return false;
  for (const deny of opts.deny ?? []) {
    if (deny.test(normalized)) return false;
  }
  if (opts.allowExtra?.(normalized)) return true;
  return /\.md$/i.test(normalized);
}

/**
 * @param {{
 *   changedPaths: readonly string[],
 *   isDocPath?: (path: string) => boolean,
 * }} input
 * @returns {boolean}
 */
export function isDocumentationOnly({
  changedPaths,
  isDocPath = isMarkdownDocPath,
}) {
  return (
    Array.isArray(changedPaths) &&
    changedPaths.length > 0 &&
    changedPaths.every(path => isDocPath(path))
  );
}

/**
 * Fail-closed structural skip decision for merge groups.
 * @param {{
 *   eventName: string,
 *   docsOnly: boolean | string,
 *   diffBaseUsable: boolean,
 *   changedFilesEmpty: boolean,
 *   structuralSelected: boolean,
 * }} input
 * @returns {{skip: boolean, reason: string}}
 */
export function decideStructuralSkip(input) {
  const eventName = String(input.eventName || '');
  const docsOnly =
    input.docsOnly === true || String(input.docsOnly).toLowerCase() === 'true';

  if (eventName === 'pull_request') {
    // PRs always evaluate control paths; this helper does not authorize skip.
    return {
      skip: false,
      reason: 'pull_request: evaluate structural control paths',
    };
  }

  if (eventName !== 'merge_group') {
    return { skip: false, reason: `${eventName || 'unknown'}: run structural` };
  }

  if (!docsOnly) {
    return {
      skip: false,
      reason: 'merge_group: classifier not docs_only (fail closed)',
    };
  }

  if (!input.diffBaseUsable) {
    return {
      skip: false,
      reason: 'merge_group: unusable classified base (fail closed)',
    };
  }

  if (input.changedFilesEmpty) {
    return {
      skip: false,
      reason: 'merge_group: empty diff is not proof of docs-only',
    };
  }

  if (input.structuralSelected) {
    return {
      skip: false,
      reason: 'merge_group: structural control path selected',
    };
  }

  return {
    skip: true,
    reason: 'merge_group: docs_only and no structural control paths',
  };
}

/**
 * GITHUB_OUTPUT line for docs_only (missing → false).
 * @param {boolean} docsOnly
 * @returns {string}
 */
export function docsOnlyOutput(docsOnly) {
  return `docs_only=${docsOnly ? 'true' : 'false'}`;
}
