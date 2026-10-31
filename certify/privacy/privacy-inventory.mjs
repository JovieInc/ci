// Config-driven privacy crawl. Playwright is loaded only inside crawl from the app checkout.
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pageProbe } from './page-probe.mjs';
import { healthFieldKeys, analyzeHealthClaims, HEALTH_CLAIMS } from './health-rules.mjs';
import { analyzePolicy } from './privacy-rules.mjs';

export const SCENARIOS = ['us-default', 'us-gpc', 'eu', 'eu-accept'];
export const SNAPSHOT_SCHEMA = 'company.privacy-inventory/v1';

const TRACKER_GLOBALS = [
  'fbq',
  'gtag',
  'dataLayer',
  'ttq',
  'snaptr',
  'twq',
  'pintrk',
  'lintrk',
  'Intercom',
  '$crisp',
  'posthog',
  'hj',
  'clarity',
  'mixpanel',
  'analytics',
  'FS',
  'LogRocket',
  'Sentry',
  '__SENTRY__',
  'statsig',
  'zE',
  'drift',
];
const DNS_LINK =
  /do not sell|your privacy choices|opt[- ]out of (the )?(sale|sharing)/i;
const GPC_CONFIRM = /global privacy control|\bGPC\b/i;

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}


export function isFirstParty(host, firstParty) {
  return firstParty.some(d => host === d || host.endsWith(`.${d}`));
}

async function newContext(browser, scenario, privacy) {
  const gpc = scenario === 'us-gpc';
  const context = await browser.newContext({
    locale: 'en-US',
    timezoneId: scenario.startsWith('eu')
      ? 'Europe/Berlin'
      : 'America/Los_Angeles',
    extraHTTPHeaders: gpc ? { 'Sec-GPC': '1' } : {},
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 CompanyPrivacyInventory/1',
  });
  if (gpc) {
    await context.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'globalPrivacyControl', {
        get: () => true,
      });
    });
  }
  const cookie = privacy.consentRegionCookie;
  if (cookie) {
    await context.addInitScript(({ name, value }) => {
      document.cookie = `${encodeURIComponent(name)}=${encodeURIComponent(value)}; path=/`;
    }, { name: cookie.name, value: scenario.startsWith('eu') ? cookie.required : cookie.optional });
  }
  return context;
}

async function crawlOne(browser, surface, scenario, firstParty, privacy) {
  const context = await newContext(browser, scenario, privacy);
  const page = await context.newPage();
  const requests = [];
  let requestCaptureError = false;
  page.on('request', req => {
    try {
      const u = new URL(req.url());
      if (!/^https?:$/.test(u.protocol)) return;
      requests.push({
        host: u.hostname,
        type: req.resourceType(),
        phase: 'load',
        health_field_keys: healthFieldKeys({ url: req.url(), body: req.postData() }),
      });
    } catch { requestCaptureError = true; }
  });
  let status = null;
  let error = null;
  try {
    const res = await page.goto(surface.url, {
      waitUntil: 'load',
      timeout: 45_000,
    });
    status = res?.status() ?? null;
    await page
      .waitForLoadState('networkidle', { timeout: 15_000 })
      .catch(() => {});
    await page.waitForTimeout(2500);
  } catch (e) {
    error = String(e.message || e).slice(0, 200);
  }
  const probeArgs = {
    globals: TRACKER_GLOBALS,
    dnsSource: DNS_LINK.source,
    gpcSource: GPC_CONFIRM.source,
    healthClaims: HEALTH_CLAIMS,
  };
  let probe = error
    ? null
    : await page
        .evaluate(pageProbe, probeArgs)
        .catch(e => ({ probe_error: String(e).slice(0, 200) }));
  let accepted = null;
  if (scenario === 'eu-accept' && probe?.consent_banner?.visible) {
    const before = requests.length;
    const btn = page
      .getByRole('button', { name: /^(accept|allow|agree)/i })
      .first();
    accepted = await btn.click({ timeout: 5000 }).then(
      () => true,
      () => false
    );
    await page
      .waitForLoadState('networkidle', { timeout: 10_000 })
      .catch(() => {});
    await page.waitForTimeout(2500);
    for (const r of requests.slice(before)) r.phase = 'after-accept';
    probe = await page.evaluate(pageProbe, probeArgs).catch(() => ({ ...probe, probe_error: 'Post-consent DOM probe failed' }));
  }
  const cookies = (await context.cookies()).map(c => ({
    name: c.name,
    domain: c.domain.replace(/^\./, ''),
    third_party: !isFirstParty(c.domain.replace(/^\./, ''), firstParty),
  }));
  const finalUrl = page.url();
  await context.close();
  const thirdParty = new Map();
  for (const r of requests) {
    if (isFirstParty(r.host, firstParty)) continue;
    const key = `${r.host}|${r.phase}`;
    const cur = thirdParty.get(key) ?? {
      host: r.host,
      phase: r.phase,
      count: 0,
      types: new Set(),
      health_field_keys: new Set(),
    };
    cur.count += 1;
    cur.types.add(r.type);
    r.health_field_keys.forEach(k => cur.health_field_keys.add(k));
    thirdParty.set(key, cur);
  }
  return {
    surface: surface.id,
    product: surface.product,
    url: surface.url,
    scenario,
    status,
    error,
    request_capture_error: requestCaptureError,
    final_url: new URL(finalUrl).origin + new URL(finalUrl).pathname,
    declared_inputs: surface.inputs ?? [],
    young_audience: Boolean(surface.young_audience),
    accepted,
    ...(probe ?? {}),
    cookies: cookies.sort((a, b) => a.name.localeCompare(b.name)),
    third_party_requests: [...thirdParty.values()]
      .map(v => ({ ...v, types: [...v.types].sort(), health_field_keys: [...v.health_field_keys].sort() }))
      .sort((a, b) => a.host.localeCompare(b.host)),
  };
}

async function fetchPolicyVersions(registry, policies, fetchImpl) {
  const out = {};
  for (const [id, url] of Object.entries(policies)) {
    try {
      const res = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(30_000) });
      const text = await res.text();
      if (res.ok && !text.replace(/<[^>]+>/g, '').trim()) throw new Error('Empty policy content');
      out[id] = res.ok
        ? {
            url,
            status: res.status,
            sha256: sha256(text),
            bytes: text.length,
            analysis: analyzePolicy(text, registry),
            health_claim_hits: analyzeHealthClaims(text),
          }
        : { url, status: res.status, error: `HTTP ${res.status}` };
    } catch (e) {
      out[id] = { url, error: String(e.message || e).slice(0, 160) };
    }
  }
  return out;
}

export async function crawl({
  config,
  cwd = process.cwd(),
  registry,
  fetchImpl = globalThis.fetch,
  only,
  scenarios = SCENARIOS,
  chromium,
}) {
  const privacy = config?.privacy;
  if (!config?.app || !privacy?.crawl?.length || !privacy.policyUrl) throw new Error('App privacy config required');
  if (!Array.isArray(privacy.firstPartyDomains) || !privacy.firstPartyDomains.length) throw new Error('privacy.firstPartyDomains required');
  if (!scenarios.length || scenarios.some(s => !SCENARIOS.includes(s))) throw new Error('Invalid scenarios');
  registry ??= loadRegistry(config, cwd);
  const surfaces = privacy.crawl.map((s, i) => ({ ...s, id: s.id ?? `page-${i}`, product: config.app,
    inputs: s.inputs ?? (s.input ? ['text'] : []) })).filter(s => !only || only.includes(s.id));
  if (!surfaces.length) throw new Error('No configured crawl surfaces selected');
  const policies = { [`${config.app}-privacy`]: privacy.policyUrl, ...(privacy.policies ?? {}) };
  if (privacy.healthPolicyUrl) policies[`${config.app}-health`] = privacy.healthPolicyUrl;
  if (!chromium) {
    const require = createRequire(join(cwd, 'package.json'));
    const pw = await import(pathToFileURL(require.resolve('playwright')).href);
    chromium = pw.chromium ?? pw.default?.chromium;
  }
  const startedAt = new Date().toISOString();
  const browser = await chromium.launch({ headless: true });
  const pages = [];
  try {
    for (const surface of surfaces) {
      for (const scenario of scenarios) {
        pages.push(
          await crawlOne(
            browser,
            surface,
            scenario,
            privacy.firstPartyDomains,
            privacy
          )
        );
      }
    }
  } finally {
    await browser.close();
  }
  return {
    schema: SNAPSHOT_SCHEMA,
    app: config.app,
    run_id: randomUUID(),
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    registry_sha256: sha256(JSON.stringify(registry)),
    policy_versions: await fetchPolicyVersions(registry, policies, fetchImpl),
    pages,
  };
}


export function loadRegistry(config, cwd = process.cwd()) {
  const root = realpathSync(cwd);
  const path = realpathSync(join(root, config.privacy.registry));
  const rel = relative(root, path);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Registry must be inside the app repo');
  return JSON.parse(readFileSync(path, 'utf8'));
}
