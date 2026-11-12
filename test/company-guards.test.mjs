import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractMentions, checkMentions, recordMentions } from '../guards/mention.mjs';
import { canCreate } from '../guards/resources.mjs';
import { measure, compare } from '../guards/size.mjs';
import { evaluate } from '../guards/drift.mjs';
import { classify } from '../scripts/resource-drift.mjs';

const al = JSON.parse(readFileSync(new URL('../canon/mention-allowlist.json', import.meta.url)));
const reg = JSON.parse(readFileSync(new URL('../canon/resources.json', import.meta.url)));

test('mentions: extracts logins, skips code, scopes, emails', () => {
  assert.deepEqual(extractMentions('hi @timwhite and `@foo` and @types/node a@b.com ```\n@bar\n```'), ['timwhite']);
});
test('mentions: stranger refused, Tim allowed once per hour, bots ok', () => {
  assert.equal(checkMentions('@timwhite ping', al)[0].reason, 'not-allowlisted');
  assert.equal(checkMentions('@itstimwhite @dependabot[bot]', al).length, 0);
  const st = recordMentions('@itstimwhite', al, {}, 1000);
  assert.equal(checkMentions('@itstimwhite', al, { state: st, now: 2000 })[0].reason, 'rate-limited');
  assert.equal(checkMentions('@itstimwhite', al, { state: st, now: 1000 + 3600_001 }).length, 0);
});
test('resources: same purpose or alias refused, new purpose ok', () => {
  assert.equal(canCreate(reg, { kind: 'vercel-project', name: 'summer-2', purposeKey: 'summer-agent-app' }).ok, false);
  assert.equal(canCreate(reg, { kind: 'vercel-project', name: 'web', purposeKey: 'x' }).ok, false);
  assert.equal(canCreate(reg, { kind: 'vercel-project', name: 'brand-new', purposeKey: 'brand-new' }).ok, true);
});
test('size: new over-limit fails, growth fails, shrink ok', () => {
  const big = 'x\n'.repeat(600);
  const cur = measure(['a.ts', 'b.ts', 'c.md'], () => big);
  assert.deepEqual(Object.keys(cur), ['a.ts', 'b.ts']);
  assert.equal(compare(cur, { 'a.ts': 600 }).length, 1);
  assert.equal(compare(cur, { 'a.ts': 600, 'b.ts': 700 }).length, 0);
  assert.equal(compare(cur, { 'a.ts': 500, 'b.ts': 700 }).length, 1);
});
test('drift: within grace ok, stale fails', () => {
  const now = Date.parse('2026-10-29T00:00:00Z');
  const c = [{ sha: 'n', date: '2026-10-28T00:00:00Z' }, { sha: 'p', date: '2026-10-01T00:00:00Z' }];
  assert.equal(evaluate('n', c, now).ok, true);
  assert.equal(evaluate('p', c, now).ok, true);
  assert.equal(evaluate('p', c, Date.parse('2026-11-05T00:00:00Z')).ok, false);
});
test('drift scan: flags unregistered, duplicate, orphaned', () => {
  const f = classify(reg, { 'vercel-project': ['jovie', 'web', 'mystery'], 'github-repo': ['meetjovie/x'] });
  const types = f.map((x) => `${x.name}:${x.type}`);
  assert.ok(types.includes('web:duplicate') && types.includes('mystery:unregistered') && types.includes('summer:orphaned') && types.includes('meetjovie/x:unregistered'));
});

test('drift scan: unseen GitHub repositories are unknown, not orphaned', () => {
  const registry = { nonCanonicalGithubOwners: [], resources: [
    { kind: 'github-repo', name: 'example/visible', status: 'canonical' },
    { kind: 'github-repo', name: 'example/private', status: 'canonical' },
    { kind: 'github-repo', name: 'example/beyond-list-limit', status: 'canonical' },
  ] };
  const findings = classify(registry, { 'github-repo': ['EXAMPLE/visible'] });
  assert.deepEqual(findings.map(({ name, type }) => ({ name, type })), [
    { name: 'example/private', type: 'unknown' },
    { name: 'example/beyond-list-limit', type: 'unknown' },
  ]);
  for (const finding of findings) {
    assert.match(finding.proposedAction, /verify.*access.*coverage/i);
    assert.doesNotMatch(finding.proposedAction, /remove entry|recreate/i);
  }
  assert.deepEqual(classify(registry, {}), [], 'a skipped source is not a complete inventory');
});

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

for (const target of [null, 'AGENTS.md', 'missing.md', 'CLAUDE.md']) {
  test(`agents: CLAUDE.md target ${target}`, (t) => {
    const cwd = mkdtempSync(join(tmpdir(), 'agents-guard-'));
    t.after(() => rmSync(cwd, { recursive: true, force: true }));
    execFileSync('git', ['init', '-q'], { cwd });
    writeFileSync(join(cwd, 'AGENTS.md'), 'Company canon: JovieInc/ci canon/COMPANY.md\n');
    if (target) symlinkSync(target, join(cwd, 'CLAUDE.md'));
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../guards/run.mjs', import.meta.url))], {
      cwd, encoding: 'utf8', env: { ...process.env, PR_BODY: '', GITHUB_EVENT_NAME: '', GITHUB_REPOSITORY: 'JovieInc/agents-guard-test' },
    });
    const valid = target === null || target === 'AGENTS.md';
    assert.equal(result.status, valid ? 0 : 1, result.stderr);
    if (!valid) assert.match(result.stderr, /CLAUDE.md must be a symlink to AGENTS.md/);
  });
}
import { validate as validateTooling, diff as diffTooling } from '../scripts/tooling-drift.mjs';
const tooling = JSON.parse(readFileSync(new URL('../canon/tooling.json', import.meta.url)));
test('tooling: registry valid; drift flags unregistered and missing', () => {
  assert.deepEqual(validateTooling(tooling), []);
  const e = tooling.entries.find((x) => x.kind === 'mcp' && x.status === 'active');
  assert.deepEqual(diffTooling(tooling, { mcp: ['brand-new'] }).unregistered, ['mcp:brand-new']);
  assert.ok(diffTooling(tooling, { mcp: [] }).missing.includes(e.id));
});

import { inventory } from '../scripts/tooling-drift.mjs';

test('tooling: hook inventory preserves script names with arguments, quotes and redirects', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'tooling-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, '.claude'));
  const commands = [
    'bash "$HOME/hooks/first.sh" --quiet',
    "python3 '/hooks with spaces/second.py' --mode fast",
    'node --no-warnings /hooks/third.js --config other.js',
    'node /hooks/fourth.cjs > /tmp/hook.log 2>&1',
    '"$HOME/hooks/fifth.mjs"',
    '/hooks/sixth --quiet',
    '/hooks/first.sh --again',
  ];
  writeFileSync(join(home, '.claude/settings.json'), JSON.stringify({
    hooks: { Stop: [{ hooks: commands.map(command => ({ type: 'command', command })) }] },
  }));
  const found = inventory(home);
  assert.deepEqual(found.hook, ['first', 'second', 'third', 'fourth', 'fifth', 'sixth']);
  const entries = found.hook.map(name => ({ id: `hook:${name}`, kind: 'hook', name, status: 'active', source: '~/.claude/settings.json' }));
  assert.deepEqual(diffTooling({ entries }, found), { missing: [], unregistered: [] });
  assert.deepEqual(diffTooling({ entries: entries.slice(1) }, found).unregistered, ['hook:first']);
});

import { policyFor, checkPr, ratchet } from '../guards/plugins/data-paths.mjs';
const dp = policyFor(JSON.parse(readFileSync(new URL('../canon/data-paths.json', import.meta.url))), 'Jovie');
const f = (filename, additions = 1, deletions = 0, status = 'modified') => ({ filename, additions, deletions, status });
test('data-paths: wins-only PR fails, mixed passes, label waives', () => {
  assert.equal(checkPr([f('canon/wins/wins.jsonl'), f('docs/metrics/wins-latest.json')], dp).length, 1);
  assert.equal(checkPr([f('canon/wins/wins.jsonl'), f('scripts/x.mjs')], dp).length, 0);
  assert.equal(checkPr([f('canon/wins/wins.jsonl')], dp, ['data-exception']).length, 0);
});
test('data-paths: append-only registry row alone fails, edits to rows pass', () => {
  assert.equal(checkPr([f('canon/automation-registry.jsonl')], dp).length, 1);
  assert.equal(checkPr([f('canon/automation-registry.jsonl', 1, 1)], dp).length, 0);
});
test('data-paths: ratchet only shrinks', () => {
  assert.equal(ratchet(['canon/wins/a.jsonl'], dp, { files: [] }).fails.length, 1);
  assert.equal(ratchet(['canon/wins/a.jsonl'], dp, { files: ['canon/wins/a.jsonl'] }).fails.length, 0);
  assert.equal(ratchet([], dp, { files: ['canon/wins/a.jsonl'] }).fails.length, 0);
});

import { scanText, compare as vvCompare, isScannable, run as vacuousRun, name as vacuousName } from '../guards/plugins/vacuous-verdict.mjs';
const guardsReg = JSON.parse(readFileSync(new URL('../canon/guards.json', import.meta.url)));

test('vacuous-verdict: red before green on the real false-green shapes', () => {
  // Deliberate-red fixtures: Jovie ship-verify fold and prod-cert runCheck default.
  const bad = [
    "status: checks.every(check => check.status !== 'failed') ? 'passed' : 'failed',",
    "passed: checks.every((item) => item.status != 'fail'),",
    "const status = outcome?.status ?? 'passed';",
    "return result.state || 'ok';",
  ];
  for (const line of bad) assert.equal(scanText(line).length, 1, line);
  // Strict folds and fail-closed defaults stay green.
  const good = [
    "const ok = checks.length > 0 && checks.every((c) => c.status === 'passed');",
    "const status = outcome?.status ?? 'blocked';",
    "if (checks.some((c) => c.status === 'failed')) return 'failed';",
    "const label = name ?? 'unnamed';",
    "summary: outcome?.summary ?? 'ok',",
    "console.log(`quality: ${quality.output || 'ok'}`);",
  ];
  for (const line of good) assert.equal(scanText(line).length, 0, line);
});
test('vacuous-verdict: test files exempt, source scanned', () => {
  assert.equal(isScannable('scripts/ship-verify.mjs'), true);
  assert.equal(isScannable('apps/web/lib/seo/page-certification.ts'), true);
  for (const p of ['a/__tests__/x.mjs', 'x.test.ts', 'tests/e2e/a.spec.ts', 'node_modules/x/y.js', 'README.md']) {
    assert.equal(isScannable(p), false, p);
  }
});
test('vacuous-verdict: ratchet fails new or more sites, baseline ok, shrink ok', () => {
  const cur = { 'a.mjs': [{ rule: 'fold-not-failed', line: 3 }] };
  assert.equal(vvCompare(cur, {}).length, 1);
  assert.equal(vvCompare(cur, { 'a.mjs': 1 }).length, 0);
  assert.equal(vvCompare(cur, { 'a.mjs': 2 }).length, 0);
  assert.equal(vvCompare({ 'a.mjs': [{}, {}] }, { 'a.mjs': 1 }).length, 1);
});
test('vacuous-verdict: run scans given files and is registered in shadow', async () => {
  const r = await vacuousRun({ cwd: new URL('..', import.meta.url).pathname, files: ['guards/plugins/vacuous-verdict.mjs', 'guards/run.mjs'] });
  assert.deepEqual(r.fails, []);
  assert.equal(guardsReg.guards.find((g) => g.id === vacuousName)?.mode, 'shadow');
});

import { scanSites, inlineRegistration, evaluate as srEvaluate, run as srRun, name as srName } from '../guards/plugins/schedule-registration.mjs';

const WHY = 'The provider sends no webhook for this state.';
test('schedule-registration: finds every schedule shape', () => {
  assert.equal(scanSites('.github/workflows/a.yml', "on:\n  schedule:\n    - cron: '*/5 * * * *'\n")[0].key, 'github-cron:.github/workflows/a.yml');
  assert.equal(scanSites('workers/x/wrangler.toml', '[triggers]\ncrons = ["* * * * *"]')[0].kind, 'cloudflare-cron');
  assert.equal(scanSites('apps/web/vercel.json', JSON.stringify({ crons: [{ path: '/api/cron/a', schedule: '* * * * *' }] }))[0].key, 'vercel-cron:apps/web/vercel.json:/api/cron/a');
  assert.equal(scanSites('u/x.timer', '[Timer]\nOnBootSec=1min')[0].kind, 'systemd-timer');
  assert.equal(scanSites('u/x.plist', '<key>StartInterval</key><integer>300</integer>')[0].kind, 'launchd');
  assert.deepEqual(scanSites('.github/workflows/b.yml', 'on:\n  push:\n'), []);
  assert.deepEqual(scanSites('apps/desktop/e.plist', '<key>com.apple.security.app-sandbox</key>'), []);
});
test('schedule-registration: red before green (negative control)', () => {
  const sites = [{ key: 'github-cron:.github/workflows/new.yml', kind: 'github-cron' }];
  assert.equal(srEvaluate({ sites }).length, 1, 'unregistered new cron fails');
  assert.equal(srEvaluate({ sites: [{ ...sites[0], inline: true }] }).length, 0);
  assert.equal(srEvaluate({ sites, baseline: [sites[0].key] }).length, 0, 'baselined passes');
  assert.equal(srEvaluate({ sites, schedules: { [sites[0].key]: { scheduler: 'gem:lanes-tick', whyNotEvent: 'short' } } }).length, 1, 'a one-word reason is not a reason');
  assert.equal(srEvaluate({ sites, schedules: { [sites[0].key]: { scheduler: 'gem:lanes-tick', whyNotEvent: WHY } } }).length, 0);
  const reg = [{ status: 'live', trigger: { source: '.github/workflows/new.yml' }, clock: { scheduler: 'github:production-continuity', whyNotEvent: WHY } }];
  assert.equal(srEvaluate({ sites, registry: reg }).length, 0, 'registry clock block registers it');
  assert.equal(srEvaluate({ sites: [], baseline: ['github-cron:gone.yml'] }).length, 1, 'baseline only shrinks');
});
test('schedule-registration: inline marker needs a real reason; plugin is registered in shadow', async () => {
  assert.ok(inlineRegistration(`# scheduler: gem:lanes-tick why-not-event: ${WHY}`));
  assert.equal(inlineRegistration('# scheduler: gem:lanes-tick why-not-event: no'), null);
  assert.equal(guardsReg.guards.find((g) => g.id === srName)?.mode, 'shadow');
  const r = await srRun({ cwd: new URL('..', import.meta.url).pathname, files: ['guards/run.mjs'] });
  assert.deepEqual(r.fails, []);
});

test('schedule-registration: flow YAML schedules are detected and require registration', () => {
  for (const text of [
    'on: {schedule: [{cron: "0 * * * *"}]}',
    "on:\n  schedule:\n    - { cron: '0 * * * *' }",
    "'on': {schedule: [{ 'cron': '0 * * * *' }]}",
    'on: {schedule: [{"cron": "0 * * * *"}]}',
  ]) {
    const sites = scanSites('.github/workflows/flow.yml', text);
    assert.equal(sites.length, 1, text);
    assert.equal(srEvaluate({ sites }).length, 1, 'unregistered flow cron must fail');
  }
});
test('schedule-registration: registry source must name the exact file with a valid live clock', () => {
  const sites = scanSites('wrangler.toml', '[triggers]\ncrons = ["0 * * * *"]');
  const entry = { status: 'live', trigger: { source: 'wrangler.toml' }, clock: { scheduler: 'cloudflare:shared', whyNotEvent: WHY } };
  assert.equal(srEvaluate({ sites, registry: [entry] }).length, 0);
  for (const source of ['workers/other/wrangler.toml', 'wrangler.toml.bak', 'not-wrangler.toml'])
    assert.equal(srEvaluate({ sites, registry: [{ ...entry, trigger: { source } }] }).length, 1, source);
  assert.equal(srEvaluate({ sites, registry: [{ ...entry, status: 'retired' }] }).length, 1);
  assert.equal(srEvaluate({ sites, registry: [{ ...entry, clock: {} }] }).length, 1);
});
