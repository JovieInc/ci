export function appConfig() {
  return {
    schema: 'company.public-app-cert/v1', app: 'sample-app', stage: 'prelaunch', dataClass: 'standard',
    goldenPath: { stages: ['entry', 'signup', 'onboarding', 'first-value', 'paid-conversion'].map(kind => ({ id: kind, kind, oracle: `Canary completes ${kind}` })),
      flows: { web: 'flow.mjs' }, accounts: { policy: 'canary-only' } },
    paidOutcome: { plan: 'Plus', price: 7, currency: 'USD', interval: 'month', priceSource: 'prices.json', freeAlternative: 'manual' },
    buyer: { personas: 'personas.json', calibration: 'calibration.json' },
    calibration: { positiveCanaries: [] },
    privacy: { profile: 'standard', registry: 'registry.json', firstPartyDomains: ['example.test'],
      crawl: [{ url: 'https://example.test/', input: false }], policyUrl: 'https://example.test/privacy' },
    customerVoice: { channels: [{ id: 'support', kind: 'email', route: 'support-handler' }, { id: 'chat', kind: 'chat', route: 'chat-handler' }],
      approval: 'tim', sink: 'VOICE_SINK_URL' },
    waste: { appId: 'sample-app' }, capacity: { appId: 'sample-app' },
  };
}
export function receiptInput(config = appConfig()) {
  return {
    walk: { sha: 'a'.repeat(40), runId: 'walk-test', startedAt: '2026-10-31T10:00:00Z', finishedAt: '2026-10-31T10:01:00Z',
      stages: config.goldenPath.stages.map((s, i) => ({ id: s.id, kind: s.kind, verdict: 'passed', tStartMs: i * 100, tEndMs: i * 100 + 50, evidence: { oracle: 'passed', frame: `frame-${i}` } })),
      voice: { channelsCovered: ['support', 'chat'] } },
    buyer: { verdicts: [{ verdict: 'no_pay', objections: ['insufficient value'] }],
      calibration: { holdoutsNoPay: 3, controlNoPay: true, positiveCanary: false }, gate: 'blocked' },
    privacy: { schema: 'company.privacy-record/v1', app: config.app, pass: true, controls_ok: true,
      controls: [{ control: 'known-bad', ok: true }], results: [{ rule: 'test', status: 'pass' }] },
  };
}
