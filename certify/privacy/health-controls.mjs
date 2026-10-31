import { cleanControlSnapshot, CONTROL_REGISTRY } from './controls.mjs';
import { HEALTH_RULES } from './health-rules.mjs';

export function runHealthControls(evaluateFn) {
  const config = { privacy: { profile: 'health', crawl: [{ url: 'https://example.test/' }],
    policyUrl: 'https://example.test/privacy', healthPolicyUrl: 'https://example.test/health' } };
  const clean = () => {
    const s = cleanControlSnapshot();
    for (const p of s.pages) {
      p.third_party_requests = [];
      p.url = 'https://example.test/';
      p.links = [config.privacy.healthPolicyUrl];
    }
    s.policy_versions['p-privacy'].url = config.privacy.policyUrl;
    s.policy_versions['p-health'] = { ...s.policy_versions['p-privacy'], url: config.privacy.healthPolicyUrl };
    return s;
  };
  const seeds = {
    'health-no-ad-tracker': s => s.pages[1].third_party_requests.push({ host: 'connect.facebook.net', phase: 'other' }),
    'health-policy-linked': s => s.pages.forEach(p => { p.links = []; }),
    'health-no-health-fields-to-third-parties': s => s.pages[0].third_party_requests.push({ host: 'cdn.test', body: '{"weight":70}' }),
    'health-banned-claims': s => { s.pages[0].health_claim_hits = ['HIPAA compliant']; },
  };
  const results = evaluateFn(clean(), CONTROL_REGISTRY, config);
  const outcomes = [{ control: 'health-clean', ok: results.length > 0 && results.every(r => r.status === 'pass') }];
  for (const rule of Object.keys(HEALTH_RULES)) {
    const s = clean(); seeds[rule](s);
    outcomes.push({ control: rule, ok: evaluateFn(s, CONTROL_REGISTRY, config).some(r => r.rule === rule && r.status === 'fail') });
  }
  return outcomes;
}
