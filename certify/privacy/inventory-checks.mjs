// Completeness checks prevent partial crawls and unavailable policies going green.
export function inventoryChecks(snapshot, registry, config) {
  const out = [];
  const add = (rule, pass, detail) => out.push({ rule, status: pass ? 'pass' : 'fail', detail });
  add('inventory-schema', snapshot?.schema === 'company.privacy-inventory/v1', 'Company inventory schema required');
  add('inventory-present', Array.isArray(snapshot?.pages) && snapshot.pages.length > 0, 'At least one crawled page required');
  for (const page of snapshot.pages ?? []) {
    add('probe-complete', !page.request_capture_error && Array.isArray(page.third_party_requests) &&
      Array.isArray(page.input_kinds) && Array.isArray(page.prechecked) &&
      typeof page.consent_banner?.visible === 'boolean' && typeof page.gpc_confirmation === 'boolean',
      `${page.surface}: network, inputs and consent observations required`);
    if (config.privacy?.profile === 'health') add('health-probe-complete', Array.isArray(page.health_claim_hits) && Array.isArray(page.links), 'Health page probe required');
    add('crawl-complete', !page.error && !page.probe_error && Number.isInteger(page.status) &&
      page.status >= 200 && page.status < 400, `${page.surface}: usable response and DOM probe required`);
  }
  const policies = Object.values(snapshot.policy_versions ?? {});
  add('policy-evidence', policies.length > 0 && policies.every(p => !p.error && p.analysis && /^[a-f0-9]{64}$/.test(p.sha256)),
    'Analyzed, versioned policies required');
  if (config.app) add('inventory-app', snapshot.app === config.app, 'Inventory must belong to the configured app');
  for (const surface of config.privacy?.crawl ?? []) {
    for (const scenario of ['us-default', 'us-gpc', 'eu', 'eu-accept']) {
      add('crawl-coverage', (snapshot.pages ?? []).some(p => p.url === surface.url && p.scenario === scenario),
        `${surface.url}: ${scenario} missing`);
    }
  }
  for (const url of [config.privacy?.policyUrl, config.privacy?.healthPolicyUrl].filter(Boolean)) {
    add('policy-coverage', policies.some(p => p.url === url && !p.error && p.analysis), 'Configured policy must be analyzed');
  }
  for (const v of registry.vendors ?? []) {
    add('registry-rationale', Boolean(v.id && v.category && v.hosts?.length && v.rationale?.trim() && v.approved),
      `${v.id}: vendor hosts, rationale and approval required`);
  }
  return out;
}
