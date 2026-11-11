// Company guard: vacuous verdicts (the false-green class).
//
// A gate is false green when it confirms something HAPPENED without confirming
// it was the RIGHT thing. Two shapes are statically detectable and precise:
//
//   fold-not-failed   pass is decided by every-check-is-not-'failed'.
//                     [].every(...) is true, and skipped/blocked/unknown
//                     statuses are not 'failed', so "nothing ran" is green.
//                     Fold with: pass = checks.length > 0 &&
//                     checks.every(c => c.status === 'passed').
//   default-to-pass   a missing status/result nullish-defaults to passed/ok:
//                     a missing result becomes a pass. Default to 'blocked'.
//
// Motivating incident (Jovie JOV-9625, 2026-10-31): the prod golden path
// certified a chat reply that said "You have reached your weekly AI message
// limit" because the check asserted only that a reply rendered. Content-level
// oracles live in each product repo (Jovie scripts/lib/outcome-verifier.mjs);
// this guard catches the structural verdict bugs in every repo.
//
// Test files are exempt (assertions on fixtures are not verdicts). Existing
// sites are baselined in the consumer at .company-guards/vacuous-verdict-baseline.json
// ({ "<path>": <count> }); a new site, or more sites in a file, fails.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const name = 'vacuous-verdict';

const SOURCE = /\.(?:[cm]?js|jsx|ts|tsx|mts|cts)$/;
const TEST_PATH = /(?:^|\/)(?:__tests__|tests?|e2e|fixtures?)\/|\.(?:test|spec)\.[^/]+$/;

export const RULES = Object.freeze([
  {
    id: 'fold-not-failed',
    pattern:
      /\.every\(\s*\(?\s*\w+\s*\)?\s*=>\s*[\w.?]+\s*!==?\s*['"`](?:failed|failure|fail|error|red)['"`]\s*\)/g,
  },
  {
    id: 'default-to-pass',
    // Left side must name a verdict; `summary ?? 'ok'` (display text) is fine.
    pattern:
      /\b(?:status|state|verdict|result|outcome|conclusion)\)?\s*(?:\?\?|\|\|)\s*['"`](?:passed|pass|ok|green|success|healthy)['"`]/gi,
  },
]);

/** Count rule hits in one file's text. */
export function scanText(text) {
  const hits = [];
  for (const rule of RULES) {
    for (const match of text.matchAll(rule.pattern)) {
      const line = text.slice(0, match.index).split('\n').length;
      hits.push({ rule: rule.id, line, snippet: match[0] });
    }
  }
  return hits;
}

export function isScannable(path) {
  return SOURCE.test(path) && !TEST_PATH.test(path) && !path.includes('node_modules/');
}

/** Compare per-file hit counts against the baseline; return failure strings. */
export function compare(current, baseline) {
  const fails = [];
  for (const [path, hits] of Object.entries(current)) {
    const allowed = baseline[path] ?? 0;
    if (hits.length > allowed) {
      const where = hits.map((h) => `${h.rule}@${h.line}`).join(', ');
      fails.push(`${path}: ${hits.length} vacuous verdict site(s), baseline ${allowed} (${where}). Pass needs >=1 check and every check === 'passed'; default missing results to 'blocked'.`);
    }
  }
  return fails;
}

function trackedFiles(cwd) {
  try {
    return execFileSync('git', ['ls-files'], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  }
}

export async function run({ cwd = '.', baselineDir = '.company-guards', files } = {}) {
  const current = {};
  for (const path of (files ?? trackedFiles(cwd)).filter(isScannable)) {
    let text;
    try {
      text = readFileSync(join(cwd, path), 'utf8');
    } catch {
      continue;
    }
    const hits = scanText(text);
    if (hits.length) current[path] = hits;
  }
  const baselinePath = join(cwd, baselineDir, `${name}-baseline.json`);
  const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : {};
  return { fails: compare(current, baseline), current };
}
