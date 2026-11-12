// Shared semantic outcome checks, ported from the original false-green regression.
// @ts-check


export const FAILURE_SURFACE_RULES = Object.freeze([
  // Quota and rate-limit walls render into the same reply element as a real
  // answer (the quota regression false green).
  {
    id: 'quota.message-limit',
    kind: 'quota',
    pattern: /\b(?:weekly |daily |monthly )?(?:ai )?message limit\b/i,
  },
  {
    id: 'quota.out-of',
    kind: 'quota',
    pattern: /\bout of (?:messages|credits|requests|quota)\b/i,
  },
  {
    id: 'quota.limit-reached',
    kind: 'quota',
    pattern:
      /\b(?:usage |generation |chat |rate )?limit (?:reached|exceeded)\b|\breached your (?:\w+ ){0,3}limit\b/i,
  },
  {
    id: 'quota.paywall',
    kind: 'quota',
    pattern:
      /\brequires? (?:the |a )?\w+ plan\b|\bupgrade to (?:continue|unlock|keep)\b/i,
  },
  {
    id: 'quota.rate-limited',
    kind: 'quota',
    pattern:
      /\brate[- ]limited\b|\btoo many requests\b|\bquota (?:exceeded|reached)\b/i,
  },
  // Service unavailable / kill switch.
  {
    id: 'unavailable.temporarily',
    kind: 'unavailable',
    pattern:
      /\btemporarily unavailable\b|\bservice unavailable\b|\bunder maintenance\b/i,
  },
  {
    id: 'unavailable.paused',
    kind: 'unavailable',
    pattern:
      /\b(?:chat|service|it) is (?:currently )?paused\b|\bpaused while we\b/i,
  },
  // Generic error copy, including 200-with-error-body assistant messages.
  {
    id: 'error.went-wrong',
    kind: 'error',
    pattern: /\bsomething went wrong\b/i,
  },
  {
    id: 'error.framework',
    kind: 'error',
    pattern:
      /\bapplication error\b|\binternal server error\b|\bunhandled runtime error\b|\bserver-side exception\b|\bthis page could not be found\b/i,
  },
  {
    id: 'error.occurred',
    kind: 'error',
    pattern:
      /\ban? (?:unexpected |unknown )?error (?:has )?occurred\b|\bunexpected error\b/i,
  },
  {
    id: 'error.could-not',
    kind: 'error',
    pattern:
      /\b(?:could ?n[o']t|couldn’t|unable to|failed to|cannot|can['’]t) (?:\w+ ){0,2}?(?:load|start|save|verify|generate|process|complete|continue|connect|reach|fetch|record|find|create|send|retrieve|restore|access|authenticate|be (?:saved|verified|loaded|found|restored|completed|processed))\b/i,
  },
  {
    id: 'error.failed',
    kind: 'error',
    pattern:
      /\b(?:request|chat|challenge|operation|generation|upload|sync|import|lookup|check) failed\b|\bfailed\.?\s*$/i,
  },
  {
    id: 'error.auth',
    kind: 'error',
    pattern:
      /^\s*(?:unauthori[sz]ed|forbidden|access denied)\b|\bor unauthori[sz]ed\b|\b(?:admin )?role required\b|\bsign in (?:is )?required\b/i,
  },
  {
    id: 'error.invalid-request',
    kind: 'error',
    pattern:
      /^\s*(?:missing|invalid) [a-z]|\b(?:id|profileId|clientTurnId|field|parameter) (?:is )?required\b/i,
  },
  {
    id: 'error.reload',
    kind: 'error',
    pattern: /\breload to continue\b|\brefresh (?:the page )?to continue\b/i,
  },
  {
    id: 'unavailable.not-configured',
    kind: 'unavailable',
    pattern: /\b(?:is|are) not configured\b|^\s*client disconnected\b/i,
  },
  {
    id: 'error.try-again',
    kind: 'error',
    pattern:
      /\bplease (?:refresh (?:and|or) )?try again\b|\btry again (?:later|in a (?:few|moment|minute))\b/i,
  },
  {
    id: 'error.http-status',
    kind: 'error',
    pattern:
      /^\s*(?:4\d\d|5\d\d)\b|\b(?:HTTP|status(?: code)?) (?:4\d\d|5\d\d)\b|\b(?:404|500|502|503|504) (?:error|not found|bad gateway|service unavailable|gateway timeout)\b/i,
  },
  {
    id: 'error.not-found',
    kind: 'error',
    pattern:
      /\b(?:page|profile|release|user|resource|conversation) not found\b|\bnot found\.?\s*$/i,
  },
  // Placeholder, template and serialization leaks.
  {
    id: 'placeholder.serialization',
    kind: 'placeholder',
    pattern: /\[object Object\]|^\s*(?:undefined|null|NaN|true|false)\s*$/,
  },
  {
    id: 'placeholder.template',
    kind: 'placeholder',
    pattern:
      /\{\{[^}]*\}\}|\$\{[^}]*\}|\blorem ipsum\b|\bTODO\b|\bTBD\b|\bplaceholder\b/i,
  },
  {
    id: 'placeholder.pending',
    kind: 'placeholder',
    pattern:
      /\bcoming soon\b|\bstill in progress\b|\bstill (?:loading|processing|generating)\b/i,
  },
  {
    id: 'placeholder.loading',
    kind: 'placeholder',
    pattern: /^\s*(?:loading|thinking|please wait|coming soon)(?:\.{3}|…)?\s*$/i,
  },
  // Empty states presented as content.
  {
    id: 'empty.no-results',
    kind: 'empty',
    pattern:
      /^\s*(?:no (?:results|releases|data|items|content|messages|[a-z]+ links)(?: (?:found|yet|available))?|nothing (?:here|to show)(?: yet)?)\b(?:[.!]|\s+on your|\s*$)/i,
  },
]);

const DEFAULT_MIN_CHARS = 2;

function excerptAround(text, match) {
  const start = Math.max(0, match.index - 40);
  return text.slice(start, match.index + match[0].length + 40).trim();
}

export function detectFailureSurface(text, { extraFailurePatterns = [] } = {}) {
  const value = typeof text === 'string' ? text : '';
  if (value.trim().length === 0) {
    return { kind: 'empty', rule: 'empty.blank', excerpt: '' };
  }
  const extra = extraFailurePatterns.map((rule, i) => ({
    id: rule.id ?? `app.failure-${i}`, kind: rule.kind ?? 'error',
    pattern: rule instanceof RegExp ? rule : new RegExp(typeof rule === 'string' ? rule : rule.pattern, 'i'),
  }));
  for (const rule of [...FAILURE_SURFACE_RULES, ...extra]) {
    rule.pattern.lastIndex = 0;
    const match = rule.pattern.exec(value);
    if (match) {
      return {
        kind: rule.kind,
        rule: rule.id,
        excerpt: excerptAround(value, match),
      };
    }
  }
  return null;
}

function oracleHolds(oracle, text) {
  if (oracle instanceof RegExp) {
    oracle.lastIndex = 0;
    return oracle.test(text);
  }
  return oracle(text) === true;
}

export function verifyOutcome(observed, options) {
  const { label, minChars = DEFAULT_MIN_CHARS, allowKinds = [] } = options;
  const text = typeof observed === 'string' ? observed : '';
    const reasons = [];
  const trimmed = text.replace(/\s+/g, ' ').trim();

  let failure = detectFailureSurface(text, options);
  if (failure && allowKinds.includes(failure.kind)) failure = null;
  if (failure) {
    reasons.push(
      `${label}: observed a ${failure.kind} surface (${failure.rule}), not the expected outcome: "${failure.excerpt.slice(0, 160)}"`
    );
  } else if (trimmed.length < minChars) {
    reasons.push(
      `${label}: observed ${trimmed.length} characters, need at least ${minChars}`
    );
  }
  if (options.expect && !oracleHolds(options.expect, text)) {
    const want = options.expectDescription ?? String(options.expect);
    reasons.push(
      `${label}: expected outcome not observed (${want}); got "${trimmed.slice(0, 160)}"`
    );
  }
  return { ok: reasons.length === 0, label, reasons, failure };
}

export function assertOutcome(observed, options) {
  const verdict = verifyOutcome(observed, options);
  if (!verdict.ok) throw new Error(verdict.reasons.join('; '));
  return (observed ?? '').trim();
}

export function foldVerdict(statuses) {
  if (!Array.isArray(statuses)) return 'blocked';
  if (statuses.some(status => status === 'failed')) return 'failed';
  if (statuses.length === 0) return 'blocked';
  return Array.from(statuses).every(status => status === 'passed') ? 'passed' : 'blocked';
}

export const NEGATIVE_CONTROLS = Object.freeze([
  {
    id: 'quota-regression-quota-wall',
    text: 'You have reached your weekly AI message limit. Upgrade to Pro for 70 messages per week.',
    source: 'lib/rate-limit/limiters.ts; run 41165214531 false green',
  },
  {
    id: 'quota-alert-title',
    text: "You're out of messages for this week",
    source: 'components/service/components/ChatUsageAlert.tsx',
  },
  {
    id: 'chat-user-context',
    text: 'The service could not load your user context for this request. Please refresh and try again.',
    source: 'app/api/chat/route.ts (HTTP 200 stream)',
  },
  {
    id: 'chat-deterministic-fail',
    text: 'Something went wrong. Please try again.',
    source: 'app/api/chat/route.ts (HTTP 200 stream)',
  },
  {
    id: 'chat-kill-switch',
    text: 'The service chat is paused while we address an upstream issue. Please try again in a few minutes.',
    source: 'app/api/chat/route.ts',
  },
  {
    id: 'chat-start-failed',
    text: "We couldn't start your chat",
    source: 'onboarding /start error state',
  },
  {
    id: 'onboarding-save-failed',
    text: 'Your conversation could not be saved. Try again.',
    source: 'app/api/chat/onboarding-handler.ts',
  },
  {
    id: 'asset-limit',
    text: 'Asset generation limit reached. Please try again later.',
    source: 'app/api/chat/route.ts',
  },
  {
    id: 'next-app-error',
    text: 'Application error: a client-side exception has occurred (see the browser console for more information).',
    source: 'Next.js error overlay',
  },
  {
    id: 'next-not-found',
    text: '404 This page could not be found.',
    source: 'Next.js not-found page',
  },
  {
    id: 'gateway-502',
    text: '502 Bad Gateway',
    source: 'edge/proxy error body',
  },
  {
    id: 'json-error-200',
    text: '{"error":"Internal Server Error","status":500}',
    source: '200-with-error-body JSON',
  },
  { id: 'coming-soon', text: 'This feature is coming soon.', source: 'unfinished feature' },
  { id: 'blank', text: '   ', source: 'empty reply bubble' },
  {
    id: 'loading-stuck',
    text: 'Loading...',
    source: 'spinner text captured as content',
  },
  { id: 'object-leak', text: '[object Object]', source: 'serialization leak' },
  { id: 'undefined-leak', text: 'undefined', source: 'serialization leak' },
  {
    id: 'template-leak',
    text: 'Welcome back, {{userName}}!',
    source: 'unrendered template',
  },
  {
    id: 'empty-releases',
    text: 'No releases found.',
    source: 'empty catalog state',
  },
  {
    id: 'went-wrong-bare',
    text: 'Something went wrong',
    source: 'error boundary copy without a retry hint',
  },
  {
    id: 'paused-bare',
    text: 'The service is paused for maintenance',
    source: 'kill-switch copy without a retry hint',
  },
  {
    id: 'paywall-reply',
    text: 'Asset generation requires the Pro plan.',
    source: 'app/api/chat/route.ts (entitlement wall)',
  },
  {
    id: 'rate-limited',
    text: 'You are being rate limited.',
    source: 'provider/edge rate limit body',
  },
  {
    id: 'bare-try-again',
    text: 'Hmm, that did not work. Please try again.',
    source: 'generic assistant apology',
  },
  {
    id: 'profile-not-found',
    text: 'Profile not found.',
    source: 'public profile lookup miss',
  },
]);

export const POSITIVE_CONTROLS = Object.freeze([
  { id: 'probe-ok', text: 'ok' },
  {
    id: 'probe-ok-sentence',
    text: 'OK! What would you like to work on today?',
  },
  {
    id: 'confirm-user',
    text: 'Is this you? CANARY — I found 12 items, including "Test Item".',
  },
  {
    id: 'get-user',
    text: "Let's set up your user profile. Paste your account link and I'll pull in your releases.",
  },
  {
    id: 'no-errors-good-news',
    text: 'Good news: your profile has no errors and every release link resolves.',
  },
  {
    id: 'no-problem',
    text: 'No problem. I can help you plan your next release.',
  },
  {
    id: 'limit-word-legit',
    text: 'There is no limit to how many links you can add to your profile.',
  },
]);

export function acceptedNegativeControls(check) {
  return NEGATIVE_CONTROLS.filter(sample => {
    try {
      return check(sample.text) === true;
    } catch {
      return false;
    }
  }).map(sample => sample.id);
}
