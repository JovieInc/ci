#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// Match semver releases (including v-prefixed tags), not ranges or git SHAs.
function majorKey(version) {
  if (typeof version !== 'string') return null;
  const match = version.match(/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/);
  if (!match) return null;
  const parts = match.slice(1, 4);
  const firstNonZero = parts.findIndex((part) => part !== '0');
  return parts.slice(0, firstNonZero === -1 ? 3 : firstNonZero + 1).join('.');
}

function changesMajorKey(entry) {
  const previous = majorKey(entry.prevVersion);
  const next = majorKey(entry.newVersion);
  return previous !== null && next !== null && previous !== next;
}

export function declarations(updated) {
  return [...new Set(updated.filter(changesMajorKey).map((entry) =>
    `Dependency-Upgrade: ${entry.dependencyName} ${entry.prevVersion} -> ${entry.newVersion}`,
  ))].sort();
}

// Return matching gate records so callers retain their probe and Linear details.
export function gated(updated, gates = []) {
  const names = new Set(updated.filter(changesMajorKey).map((entry) => entry.dependencyName));
  return gates.filter((gate) => names.has(gate.package));
}

export function augmentBody(body, lines, gatedList) {
  const original = body.replace(/<!-- jov-13093:declare -->[\s\S]*?<!-- \/jov-13093:declare -->/g, '').trimEnd();
  const migrationLines = [...new Set(gatedList.map((gate) =>
    `Migration-Gate: ${gate.package} requires ${gate.probe.script} in ${gate.probe.repo} exit 0 (${gate.linear})`,
  ))].sort();
  const block = [
    '<!-- jov-13093:declare -->',
    'Refs JOV-13093',
    ...lines,
    ...migrationLines,
    '<!-- /jov-13093:declare -->',
  ].join('\n');
  return `${original ? `${original}\n\n` : ''}${block}\n`;
}

// Not import.meta.main: the reusable workflow runs on the runner image's default Node (20/22).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: {
      updated: { type: 'string' }, body: { type: 'string' },
      gates: { type: 'string' }, out: { type: 'string' },
    } });
    for (const option of ['updated', 'body', 'gates', 'out']) {
      if (!values[option]) throw new Error(`Missing --${option}`);
    }
    const updated = JSON.parse(readFileSync(values.updated, 'utf8'));
    if (!Array.isArray(updated)) throw new Error('Updated dependencies must be an array');
    let gates = [];
    try {
      gates = JSON.parse(readFileSync(values.gates, 'utf8')).gates;
      if (!Array.isArray(gates)) throw new Error('Migration gates must contain a gates array');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const lines = declarations(updated);
    const gatedList = gated(updated, gates);
    writeFileSync(values.out, augmentBody(readFileSync(values.body, 'utf8'), lines, gatedList));
    // Machine-readable summary also feeds the reusable workflow's major-bump report.
    console.log(JSON.stringify({
      declarations: lines.length,
      gated: gatedList.map((gate) => gate.package),
      updates: updated.map(({ dependencyName, prevVersion, newVersion }) =>
        ({ dependencyName, prevVersion, newVersion })),
    }, null, 2));
  } catch (error) {
    console.error(`dependabot-declare: ${error.message}`);
    process.exitCode = 1;
  }
}
