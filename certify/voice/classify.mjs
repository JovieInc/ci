// Deterministic feedback and urgency classification.

export const URGENT_REASONS = [
  'bug',
  'billing',
  'angry',
  'public',
  'legal',
];

const URGENT_PATTERNS = {
  bug: [
    /\b(bug|broken|crash(?:ed|es|ing)?|error|doesn'?t work|does not work|not working|won'?t (?:load|work|open|let me)|can'?t (?:log ?in|sign ?in|access|load|see my)|stuck on|blank (?:page|screen)|500|404)\b/i,
  ],
  billing: [
    /\b(charged?|charging|refund|chargeback|invoice|billing|payment|card (?:was )?declined|double[- ]charged|cancel (?:my )?(?:subscription|plan)|subscription|overcharged|money back)\b/i,
  ],
  angry: [
    /\b(wtf|scam|ripoff|rip[- ]off|ridiculous|unacceptable|terrible|awful|worst|furious|pissed|disgusting|useless|garbage|fraud)\b/i,
    /!{3,}/,
  ],
  public: [
    /\b(twitter|tweet|x\.com|reddit|trustpilot|review(?:ed)? (?:you|this)|post(?:ing)? about|tell everyone|press|journalist|reporter|tiktok about)\b/i,
  ],
  legal: [
    /\b(lawyer|attorney|legal action|sue|suing|lawsuit|gdpr|ccpa|dmca|copyright|trademark|delete my (?:data|account)|data request|privacy violation|cease and desist|small claims)\b/i,
  ],
};

export function urgentReasons(text) {
  const reasons = [];
  for (const reason of URGENT_REASONS) {
    if (URGENT_PATTERNS[reason].some(pattern => pattern.test(text))) {
      reasons.push(reason);
    }
  }
  return reasons;
}

const FEEDBACK_PATTERNS = [
  // Price and value pushback, including the soft forms real people use.
  /\b(too (?:expensive|much|pricey)|a lot (?:of money|for)?|pricey|costs? too much|can'?t afford|not worth|why (?:would i |should i )?pay|cheaper|discount)\b/i,
  /(?:\$|usd|€|£)\s?\d+|\d+\s?(?:usd|dollars|bucks|\/mo|a month|per month)/i,
  /\b(try (?:it )?(?:first|before)|free trial|before i pay|see how it works|have a look first)\b/i,
  // Thin value, confusion, disappointment.
  /\b(just my name|only (?:shows|has) my|preview (?:is|was)|not (?:illuminating|helpful|clear|useful)|doesn'?t (?:show|do) (?:much|anything)|what (?:does|is) (?:this) (?:do|for)|confus(?:ed|ing)|don'?t (?:get|understand)|makes no sense|disappoint\w*|expected more|underwhelm\w*)\b/i,
  // Wow-as-shock and similar reactions at the start of a turn.
  /^\s*(?:wow|hmm+|ugh|meh|huh)\b[\s\S]*\?/i,
  // Bug-ish and asks to the team.
  /\b(bug|broken|not working|doesn'?t work|error|glitch|weird)\b/i,
  /\b(feature request|would be (?:nice|great|cool) if|please add|you should add|wish (?:it|you))\b/i,
  /\b(feedback|suggestion|complain\w*|support|talk to (?:a |someone|a human|the team|tim)|who (?:runs|made) this)\b/i,
];

export function isFeedbackTurn(text) {
  const trimmed = text.trim();
  if (trimmed.length < 8 || trimmed.length > 4000) return false;
  if (urgentReasons(trimmed).length) return true;
  return FEEDBACK_PATTERNS.some(pattern => pattern.test(trimmed));
}

export function isAutomatedEmail(input) {
  const from = input.from.toLowerCase();
  if (
    /(?:^|[<\s])(?:mailer-daemon|postmaster|no-?reply|do-?not-?reply|bounce[s]?|notifications?)@/.test(
      from
    )
  ) {
    return true;
  }
  const headers = Object.fromEntries(
    Object.entries(input.headers ?? {}).map(([key, value]) => [
      key.toLowerCase(),
      String(value).toLowerCase(),
    ])
  );
  if (headers['auto-submitted'] && headers['auto-submitted'] !== 'no') {
    return true;
  }
  if (headers['list-unsubscribe'] || headers['list-id']) return true;
  if (/^(?:bulk|list|junk|auto_reply)$/.test(headers.precedence ?? '')) {
    return true;
  }
  return /^(?:auto(?:matic)? ?reply|out of (?:the )?office|undeliverable|delivery status notification)/i.test(
    input.subject ?? ''
  );
}
