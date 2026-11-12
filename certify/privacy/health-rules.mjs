// Health profile adds to (never replaces) the shared privacy rules.
import { vendorFor } from './privacy-rules.mjs';

export const HEALTH_RULES = {
  'health-no-ad-tracker': 'No pixel, ads or replay on any page without counsel sign-off.',
  'health-policy-linked': 'Homepage links a distinct consumer health data policy.',
  'health-no-health-fields-to-third-parties': 'No health field keys in third-party requests.',
  'health-banned-claims': 'No prohibited health claims on pages or policies.',
};
export const HEALTH_FIELDS = ['weight', 'body_fat', 'bodyFat', 'lean_mass', 'bmi',
  'ffmi', 'dob', 'birthdate', 'height', 'waist', 'glp1', 'healthkit'];
const fields = new Set(HEALTH_FIELDS.map(k => k.toLowerCase()));
export const HEALTH_CLAIMS = ['HIPAA[- ]compliant', 'medical advice', 'clinically proven',
  'we never share your health data'];

export function analyzeHealthClaims(text = '') {
  const visibleText = String(text).replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ');
  return HEALTH_CLAIMS.filter(pattern => new RegExp(pattern, 'i').test(visibleText));
}

// Inspect transient payloads; persist only matching field names, never values.
export function healthFieldKeys(request) {
  const found = new Set();
  function key(value) {
    for (const token of String(value).split(/[^a-zA-Z0-9_]+/)) {
      if (fields.has(token.toLowerCase())) found.add(token.toLowerCase());
    }
  }
  function visit(value) {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) { key(k); visit(v); }
    } else if (typeof value === 'string') {
      key(value);
      try { visit(JSON.parse(value)); } catch { /* Not JSON. */ }
    }
  }
  for (const k of request.health_field_keys ?? []) key(k);
  if (request.url) {
    try {
      const url = new URL(request.url);
      key(decodeURIComponent(url.pathname));
      for (const [k, v] of url.searchParams) { key(k); visit(v); }
    } catch { key(request.url); }
  }
  for (const payload of [request.query, request.body, request.postData]) {
    visit(payload);
    if (typeof payload === 'string') {
      for (const [k, v] of new URLSearchParams(payload)) { key(k); visit(v); }
    }
  }
  return [...found].sort();
}

export function evaluateHealth(snapshot, registry, config = {}) {
  const p = config.privacy;
  if (p?.profile !== 'health') return [];
  const results = [];
  const add = (rule, pass, page, detail = '') => results.push({ rule,
    status: pass ? 'pass' : 'fail', surface: page?.surface ?? null,
    scenario: page?.scenario ?? null, detail });
  const signed = typeof p.counselSignoff === 'string' && p.counselSignoff.trim().length > 0;
  for (const page of snapshot.pages ?? []) {
    const requests = page.third_party_requests ?? [];
    const ads = requests.filter(r => ['pixel', 'ads', 'replay'].includes(vendorFor(r.host, registry)?.category));
    add('health-no-ad-tracker', signed || ads.length === 0, page,
      ads.length ? 'Ad/replay vendor observed on a health app surface' : '');
    const hits = requests.flatMap(healthFieldKeys);
    add('health-no-health-fields-to-third-parties', hits.length === 0, page, [...new Set(hits)].join(', '));
    const claims = [...(page.health_claim_hits ?? []), ...analyzeHealthClaims(page.text ?? page.html)];
    add('health-banned-claims', claims.length === 0, page, claims.join(', '));
  }
  const homepage = p.homepageUrl ?? p.crawl?.find(s => s.homepage)?.url ?? p.crawl?.[0]?.url;
  const homes = (snapshot.pages ?? []).filter(page => page.url === homepage && page.scenario === 'us-default');
  const distinct = Boolean(p.healthPolicyUrl && p.healthPolicyUrl !== p.policyUrl);
  add('health-policy-linked', distinct && homes.length > 0 && homes.every(page =>
    !page.error && (page.links ?? []).some(link => {
      try { return new URL(typeof link === 'string' ? link : link.href, page.url).href === new URL(p.healthPolicyUrl).href; }
      catch { return false; }
    })), homes[0], 'Homepage must link the distinct configured health policy');
  for (const [id, policy] of Object.entries(snapshot.policy_versions ?? {})) {
    const claims = [...(policy.health_claim_hits ?? []), ...analyzeHealthClaims(policy.text ?? policy.html)];
    add('health-banned-claims', !policy.error && claims.length === 0, { surface: id }, claims.join(', '));
  }
  return results;
}
