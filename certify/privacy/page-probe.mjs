// Runs inside the page. Must stay self-contained (serialized by Playwright).
export function pageProbe({ globals, dnsSource, gpcSource, healthClaims }) {
  const dns = new RegExp(dnsSource, 'i');
  const gpc = new RegExp(gpcSource, 'i');
  const visible = el => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return (
      r.width > 0 &&
      r.height > 0 &&
      s.visibility !== 'hidden' &&
      s.display !== 'none'
    );
  };
  const label = el =>
    (
      el.getAttribute('aria-label') ||
      el.getAttribute('name') ||
      el.id ||
      el.closest('label')?.textContent ||
      ''
    )
      .trim()
      .slice(0, 80);
  const kinds = new Set();
  for (const el of document.querySelectorAll(
    'input, textarea, [contenteditable="true"]'
  )) {
    if (!visible(el)) continue;
    const t = (el.getAttribute('type') || el.tagName).toLowerCase();
    if (
      [
        'hidden',
        'submit',
        'button',
        'checkbox',
        'radio',
        'image',
        'reset',
      ].includes(t)
    )
      continue;
    const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
    if (t === 'password' || ac.includes('password')) kinds.add('password');
    else if (t === 'email' || ac.includes('email')) kinds.add('email');
    else if (t === 'tel' || ac.includes('tel')) kinds.add('tel');
    else if (t === 'search') kinds.add('search');
    else if (t === 'textarea' || t === 'div') kinds.add('freeform');
    else kinds.add('text');
  }
  for (const f of document.querySelectorAll('iframe')) {
    if (/js\.stripe\.com|checkout\.stripe\.com/.test(f.src) && visible(f))
      kinds.add('payment');
  }
  const prechecked = [];
  for (const el of document.querySelectorAll(
    'input[type=checkbox], [role=checkbox], [role=switch]'
  )) {
    const on = el.matches('input')
      ? el.checked
      : el.getAttribute('aria-checked') === 'true';
    if (on && visible(el) && !el.disabled) prechecked.push(label(el));
  }
  const links = [...document.querySelectorAll('a, button')];
  const dnsLink = links.find(a => dns.test(a.textContent || ''));
  const buttons = links.filter(visible).map(b => (b.textContent || '').trim());
  const acceptButtons = buttons.filter(t =>
    /^(accept|allow|agree|ok, got it)/i.test(t)
  );
  const rejectButtons = buttons.filter(t =>
    /^(reject|decline|deny|refuse|necessary only|only necessary)/i.test(t)
  );
  const bodyText = document.body?.innerText || '';
  const bannerVisible =
    acceptButtons.length > 0 && /cookie|consent|privacy/i.test(bodyText);
  return {
    links: [...document.querySelectorAll('a[href]')].filter(visible).map(a => a.href),
    health_claim_hits: healthClaims.filter(pattern => new RegExp(pattern, 'i').test(bodyText.replace(/\s+/g, ' '))),
    input_kinds: [...kinds].sort(),
    prechecked,
    dns_link: dnsLink
      ? {
          text: dnsLink.textContent.trim().slice(0, 80),
          href: dnsLink.getAttribute('href'),
        }
      : null,
    consent_banner: {
      visible: bannerVisible,
      accept: acceptButtons.length,
      reject: rejectButtons.length,
    },
    gpc_confirmation: gpc.test(bodyText),
    globals: globals.filter(g => {
      try {
        return typeof window[g] !== 'undefined';
      } catch {
        return false;
      }
    }),
    local_storage_keys: Object.keys(localStorage).sort(),
    session_storage_keys: Object.keys(sessionStorage).sort(),
  };
}
