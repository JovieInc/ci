// Company guard: every PR body carries a Guardrail section (canon/COMPANY.md
// "Guardrail with every fix (ratchet)").
//
// Checked fields (in a `## Guardrail` section or a `Guardrail:` block):
//   Class          the failure class the change addresses
//   Mechanism      the new guard; or Existing: the guard that already covers it.
//                  Either must name a real path in this checkout or a guard id
//                  in canon/guards.json (a made-up path does not count).
//   Enforced at    where the guard runs (type, lint, CI, runtime, ...)
//   Status         NOW, or LATER with an issue link (URL, ABC-123 or #123)
//   Simulation     three named scenarios (trivial, high-volume, literal/gaming)
//                  plus a worst case. Trivial PRs that cite an Existing guard may
//                  write `Simulation: covered by <guard>`. A `## Simulation`
//                  section in the body is read together with the field.
//   Encoded in     required only when a line opens with "Resolves N review findings"
//
// Placeholders (N/A, none, TBD, -, template comments) never satisfy a field.
// Registered in canon/guards.json with required:false: guards/run.mjs reports
// its failures as warnings until it is promoted (>=20 consecutive clean runs or
// 7 days with zero false positives; auto-demote above 2% false positives).
// Outside a pull request (no PR_BODY) there is nothing to check.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'guardrail-section';

const FIELD = /^\s*(?:[-*]\s*)?\**\s*(class|mechanism|existing|enforced at|heals|status|simulation|encoded in)\s*\**\s*:\s*(.*)$/i;
const PLACEHOLDER = /^(?:n\/?a|none|nothing|tbd|todo|-+|\.+|\?+|null|no)\.?$/i;
const ISSUE = /(?:https?:\/\/\S+|\b[A-Z][A-Z0-9]+-\d+\b|#\d+)/;
// A line that opens with "Resolves/Fixes/Addresses [N] review finding(s)"; prose that merely mentions findings does not count.
const REVIEW_FINDINGS = /^\s*(?:[-*]\s*)?(?:resolves|fixes|addresses)\s+(?:\d+\s+)?review[- ]findings?\b/im;

const stripComments = (s) => s.replace(/<!--[\s\S]*?(?:-->|$)/g, '');
const clean = (v) => stripComments(v ?? '').replace(/[`*_]/g, ' ').replace(/\s+/g, ' ').trim();
export const isPlaceholder = (v) => !clean(v) || PLACEHOLDER.test(clean(v));

/** Text of a `## <title>` section (until the next heading of the same or higher level). */
function section(body, title) {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^#{1,4}\\s*${title}\\b`, 'i').test(l));
  if (start < 0) return null;
  const level = lines[start].match(/^#+/)[0].length;
  const end = lines.findIndex((l, i) => i > start && /^#{1,6}\s/.test(l) && l.match(/^#+/)[0].length <= level);
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n');
}

/** Parse Guardrail fields from a PR body. Returns null when there is no Guardrail section. */
export function parseGuardrail(rawBody) {
  const body = stripComments(rawBody ?? '');
  let text = section(body, 'Guardrail');
  if (text == null) {
    const m = body.match(/^\s*\**Guardrail\**\s*:?\s*$([\s\S]*?)(?=^#{1,6}\s|$(?![\s\S]))/im);
    if (!m) return null;
    text = m[1];
  }
  const fields = {};
  let last = null;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(FIELD);
    if (m) {
      last = m[1].toLowerCase();
      fields[last] = m[2];
    } else if (last && /^\s{2,}\S/.test(line)) {
      fields[last] += ` ${line.trim()}`; // indented continuation line
    } else if (!line.trim()) {
      last = last === 'simulation' ? last : null;
    }
  }
  const sim = section(body, 'Simulation');
  if (sim) fields.simulation = isPlaceholder(fields.simulation) ? sim : `${fields.simulation} ${sim}`;
  return fields;
}

/** Path-like or id-like tokens a Mechanism/Existing value cites. */
export function citedRefs(value) {
  const raw = stripComments(value ?? '');
  const refs = new Set();
  for (const m of raw.matchAll(/`([^`]+)`/g)) refs.add(m[1].trim());
  for (const m of raw.matchAll(/[\w./@-]+/g)) refs.add(m[0].replace(/[.,;:)]+$/, ''));
  return [...refs].filter(Boolean);
}

function simulationOk(value, usesExisting, isReal) {
  const v = clean(value);
  const covered = v.match(/^covered by\s+(.+)$/i);
  if (covered) return usesExisting && citedRefs(covered[1]).some(isReal);
  return /trivial/i.test(v) && /volume/i.test(v) && /(literal|gaming|gam(e|ing) agent)/i.test(v) && /worst/i.test(v);
}

/**
 * Evaluate a PR body. `isReal(ref)` says whether a cited path or guard id exists.
 * Returns failure strings (empty = pass).
 */
export function evaluate(body, isReal) {
  const f = parseGuardrail(body);
  if (!f) return ['no Guardrail section (add `## Guardrail` with Class, Mechanism or Existing, Enforced at, Status, Simulation; see canon/COMPANY.md)'];
  const fails = [];
  if (isPlaceholder(f.class)) fails.push('Class is empty or a placeholder');
  const usesExisting = !isPlaceholder(f.existing) || /^\s*existing\s*:/i.test(stripComments(f.mechanism ?? ''));
  const mech = !isPlaceholder(f.mechanism) ? f.mechanism : f.existing;
  if (isPlaceholder(mech)) fails.push('Mechanism (or Existing) is empty or a placeholder');
  else if (!citedRefs(mech).some(isReal)) fails.push(`Mechanism/Existing must name a real path in this repo or a guard id in canon/guards.json (got "${clean(mech)}")`);
  if (isPlaceholder(f['enforced at'])) fails.push('Enforced at is empty or a placeholder');
  const status = clean(f.status);
  if (!/^NOW\b/i.test(status) && !(/^LATER\b/i.test(status) && ISSUE.test(status))) fails.push('Status must be NOW, or LATER with an issue link');
  if (isPlaceholder(f.simulation)) fails.push('Simulation is empty or a placeholder');
  else if (!simulationOk(f.simulation, usesExisting, isReal)) fails.push('Simulation needs trivial, high-volume and literal/gaming scenarios plus a worst case (or "covered by <existing guard>" when citing Existing)');
  if (REVIEW_FINDINGS.test(stripComments(body)) && isPlaceholder(f['encoded in'])) fails.push('the PR resolves review findings, so Encoded in must name where each finding was encoded');
  return fails;
}

function guardIds() {
  try {
    const reg = JSON.parse(readFileSync(fileURLToPath(new URL('../../canon/guards.json', import.meta.url)), 'utf8'));
    return new Set(reg.guards.map((g) => g.id));
  } catch {
    return new Set();
  }
}

export async function run({ cwd = '.', body = process.env.PR_BODY } = {}) {
  if (!body) return { fails: [] };
  const ids = guardIds();
  const isReal = (ref) => {
    if (ids.has(ref)) return true;
    const path = ref.replace(/#.*$/, '').replace(/^\.?\//, '');
    // A path must look like one (a dot or slash plus a 2+ char name); `.`, `./` and `..` never count.
    return /[/.]/.test(path) && /\w{2,}/.test(path) && !path.split('/').includes('..') && existsSync(join(cwd, path));
  };
  return { fails: evaluate(body, isReal) };
}
