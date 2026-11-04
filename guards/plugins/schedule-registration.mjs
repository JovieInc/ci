// Company guard: schedule registration (one scheduler per platform).
//
// Tim 2026-10-31 (memory feedback_event_driven): N jobs polling on the same
// schedule become one job running N tasks; every check is event-driven unless
// no event exists, then it is a slow fail-safe. So a NEW schedule definition
// (GitHub `schedule:` cron, wrangler `crons`, vercel.json `crons`, systemd
// `.timer`, launchd plist interval) must say which shared scheduler it
// registers into and why an event cannot do the job. Registration is any of:
//   1. an inline marker in the file (comment):
//        scheduler: <id> why-not-event: <at least 30 chars>
//      (YAML/TOML/INI `#`, XML `<!-- -->`),
//   2. an entry in the consumer's .company-guards/schedules.json
//        { "<site key>": { "scheduler": "<id>", "whyNotEvent": "<...>" } }
//      (the only option for vercel.json, which has no comments),
//   3. a live entry in the consumer's canon/automation-registry.jsonl whose
//      trigger.source names the file and whose `clock` block has both fields.
// Existing sites are baselined in .company-guards/schedule-registration-baseline.json
// (an array of site keys); only new sites fail, and a baseline key whose site is
// gone must be dropped (the list only shrinks).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const name = 'schedule-registration';
export const WHY_MIN = 30;

const MARKER = /scheduler:\s*([\w:.-]+)\s+why-not-event:\s*(.{30,}?)(?:\s*-->)?\s*$/im;

/** Schedule sites in one file: [{key, kind}] (empty when the file defines none). */
export function scanSites(path, text) {
  const sites = [];
  if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(path) && /^\s*-\s*cron:/m.test(text))
    sites.push({ key: `github-cron:${path}`, kind: 'github-cron' });
  if (/(?:^|\/)wrangler[\w.-]*\.(?:toml|jsonc?)$/.test(path) && /^\s*"?crons"?\s*[=:]\s*\[\s*["']/m.test(text))
    sites.push({ key: `cloudflare-cron:${path}`, kind: 'cloudflare-cron' });
  if (/(?:^|\/)vercel\.json$/.test(path)) {
    try {
      for (const cron of JSON.parse(text).crons ?? [])
        if (cron?.path) sites.push({ key: `vercel-cron:${path}:${cron.path}`, kind: 'vercel-cron' });
    } catch {
      /* not JSON: nothing to register */
    }
  }
  if (path.endsWith('.timer') && /^\s*\[Timer\]/m.test(text))
    sites.push({ key: `systemd-timer:${path}`, kind: 'systemd-timer' });
  if (path.endsWith('.plist') && /<key>(?:StartInterval|StartCalendarInterval)<\/key>/.test(text))
    sites.push({ key: `launchd:${path}`, kind: 'launchd' });
  return sites;
}

export function inlineRegistration(text) {
  const m = text.match(MARKER);
  return m && m[2].trim().length >= WHY_MIN ? { scheduler: m[1], whyNotEvent: m[2].trim() } : null;
}

const valid = (r) => Boolean(r?.scheduler) && typeof r?.whyNotEvent === 'string' && r.whyNotEvent.trim().length >= WHY_MIN;

function registryClocks(cwd) {
  const file = join(cwd, 'canon/automation-registry.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((e) => e?.status === 'live' && valid(e.clock));
}

/** Failure strings for sites with no registration and no baseline. */
export function evaluate({ sites, baseline = [], schedules = {}, registry = [] }) {
  const fails = [];
  const base = new Set(baseline);
  for (const site of sites) {
    if (base.has(site.key)) continue;
    const path = site.key.split(':').slice(1).join(':').split(':')[0];
    const ok =
      site.inline ||
      valid(schedules[site.key]) ||
      registry.some((e) => String(e.trigger?.source ?? '').includes(path));
    if (!ok)
      fails.push(
        `${site.key}: new schedule has no registration. Register into the platform's shared scheduler instead of owning a timer, or add "scheduler: <id> why-not-event: <why no event/webhook/queue-insert can do it, >=${WHY_MIN} chars>" (comment in the file, or .company-guards/schedules.json for vercel.json).`
      );
  }
  const live = new Set(sites.map((s) => s.key));
  for (const key of base)
    if (!live.has(key)) fails.push(`${key}: baselined but the schedule is gone; remove it from schedule-registration-baseline.json (the list only shrinks).`);
  return fails;
}

function trackedFiles(cwd) {
  try {
    return execFileSync('git', ['ls-files'], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export async function run({ cwd = '.', baselineDir = '.company-guards', files } = {}) {
  const sites = [];
  for (const path of files ?? trackedFiles(cwd)) {
    if (path.includes('node_modules/')) continue;
    let text;
    try {
      text = readFileSync(join(cwd, path), 'utf8');
    } catch {
      continue;
    }
    const inline = inlineRegistration(text) !== null;
    for (const site of scanSites(path, text)) sites.push({ ...site, inline });
  }
  const baseline = readJson(join(cwd, baselineDir, `${name}-baseline.json`), []);
  const schedules = readJson(join(cwd, baselineDir, 'schedules.json'), {});
  return { fails: evaluate({ sites, baseline, schedules, registry: registryClocks(cwd) }), current: sites.map((s) => s.key) };
}
