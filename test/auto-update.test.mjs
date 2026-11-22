import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseDependabot, holdFindings, unpinnedActions, run } from '../guards/plugins/auto-update.mjs';

const NOW = Date.parse('2026-11-22T00:00:00Z');
const SHA = 'a'.repeat(40);

function repo(t, files) {
  const d = mkdtempSync(join(tmpdir(), 'auto-update-'));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(dirname(join(d, f)), { recursive: true });
    writeFileSync(join(d, f), body);
  }
  return { cwd: d, files: Object.keys(files) };
}

const CLEAN = `version: 2
updates:
  - package-ecosystem: 'npm'
    directories:
      - '/apps/*'
    cooldown:
      default-days: 3
    ignore:
      # Held 2026-11-01: upstream bug, re-evaluate at 2.0.1.
      - dependency-name: 'left-pad'
      # JOV-123 tracks this one.
      - dependency-name: 'right-pad'
  - package-ecosystem: 'github-actions'
    directory: '/'
`;
const WORKFLOW = `on: pull_request\njobs:\n  a:\n    steps:\n      - uses: dependabot/fetch-metadata@${SHA} # v3\n      - uses: ./local\n`;

test('parseDependabot reads ecosystems, directories, cooldown and limits', () => {
  const e = parseDependabot(CLEAN + "  - package-ecosystem: 'pip'\n    directory: '/'\n    open-pull-requests-limit: 0\n");
  assert.deepEqual(e.map((x) => [x.ecosystem, x.directories, x.cooldown, x.limit]), [
    ['npm', ['/apps/*'], true, null], ['github-actions', ['/'], false, null], ['pip', ['/'], false, 0],
  ]);
});

test('holds need a date or Linear key, and dated holds expire', () => {
  assert.deepEqual(holdFindings(CLEAN, { now: NOW, maxAgeDays: 60 }), []);
  const old = "ignore:\n  # Held 2026-08-01.\n  - dependency-name: 'x'\n  - package-ecosystem: 'npm'\n  ignore:\n  - dependency-name: 'y'\n";
  const f = holdFindings(old, { now: NOW, maxAgeDays: 60 });
  assert.equal(f.length, 2);
  assert.match(f[0], /x dated 2026-08-01 is 113 days old/);
  assert.match(f[1], /y has no dated re-evaluate note/);
});

test('unpinnedActions flags tags and skips local, docker and placeholders', () => {
  const text = `steps:\n  - uses: actions/checkout@v7\n  - uses: a/b@${SHA}\n  - uses: ./x\n  - uses: docker://alpine:3\n  - uses: o/r/.github/workflows/w.yml@<sha>\n`;
  assert.deepEqual(unpinnedActions('w.yml', text), ['w.yml: actions/checkout@v7 is not pinned to a full commit SHA']);
});

test('a compliant repo is clean', async (t) => {
  const r = repo(t, {
    '.github/dependabot.yml': CLEAN,
    '.github/workflows/dependabot.yml': WORKFLOW,
    'apps/web/package.json': JSON.stringify({ dependencies: { a: '1.0.0' } }),
    '.nvmrc': '26.1.0\n',
    'worker/wrangler.toml': 'name = "w"\ncompatibility_date = "2026-11-01"\n',
  });
  assert.deepEqual((await run({ ...r, now: NOW })).fails, []);
});

test('a repo with no config, loose pins, old Node and stale wrangler is flagged', async (t) => {
  const r = repo(t, {
    '.github/workflows/ci.yml': 'jobs:\n  a:\n    steps:\n      - uses: actions/checkout@v7\n',
    'package.json': JSON.stringify({ devDependencies: { a: '1.0.0' } }),
    '.nvmrc': '24.22.3\n',
    'wrangler.toml': 'compatibility_date = "2026-01-01"\n',
  });
  const fails = (await run({ ...r, now: NOW })).fails.join('\n');
  assert.match(fails, /actions\/checkout@v7 is not pinned/);
  assert.match(fails, /no auto-update config/);
  assert.match(fails, /Node 24 is behind the Active LTS major 26/);
  assert.match(fails, /compatibility_date 2026-01-01 is 325 days old/);
});

test('uncovered ecosystems, missing cooldowns and a missing lane are flagged', async (t) => {
  const r = repo(t, {
    '.github/dependabot.yml': "version: 2\nupdates:\n  - package-ecosystem: 'npm'\n    directory: '/apps/web'\n",
    '.github/workflows/ci.yml': `jobs:\n  a:\n    steps:\n      - uses: a/b@${SHA}\n`,
    'apps/web/package.json': JSON.stringify({ dependencies: { a: '1' } }),
    'apps/api/package.json': JSON.stringify({ dependencies: { a: '1' } }),
    'requirements.txt': 'pyyaml\n',
  });
  const fails = (await run({ ...r, now: NOW })).fails.join('\n');
  assert.match(fails, /npm manifest in \/apps\/api is not covered/);
  assert.match(fails, /no pip entry/);
  assert.match(fails, /no github-actions entry/);
  assert.match(fails, /npm \/apps\/web has no cooldown/);
  assert.match(fails, /no Dependabot auto-merge lane/);
});

test('a pnpm workspace root covers nested packages', async (t) => {
  const r = repo(t, {
    '.github/dependabot.yml': "version: 2\nupdates:\n  - package-ecosystem: 'npm'\n    directory: '/'\n    cooldown:\n      default-days: 1\n",
    'pnpm-workspace.yaml': "packages: ['apps/*']\n",
    'apps/web/package.json': JSON.stringify({ dependencies: { a: '1' } }),
  });
  const fails = (await run({ ...r, now: NOW })).fails;
  assert.ok(!fails.some((f) => /not covered/.test(f)), fails.join('\n'));
});
