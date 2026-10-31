// Per-app certification config: load and validate (zero dependencies).
//
// The JSON Schema in certify/schema/app-cert.schema.json documents the same
// contract for editors; this validator is what CI enforces. A config is valid
// only when every required section is present AND filled: the scaffold writes
// TODO markers, and a TODO anywhere is an error, so a stub can never pass.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const SCHEMA = 'company.public-app-cert/v1';
export const STAGES = ['prelaunch', 'public', 'dormant'];
export const DATA_CLASSES = ['standard', 'health'];
export const REQUIRED_STAGE_KINDS = ['entry', 'signup', 'onboarding', 'first-value', 'paid-conversion'];
export const CHANNEL_KINDS = ['email', 'in-app-feedback', 'chat', 'app-store-review', 'sms', 'social-dm'];
const TODO = /\bTODO\b/;

const isStr = (v) => typeof v === 'string' && v.trim().length > 0;
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

function findTodos(value, path, out) {
  if (typeof value === 'string') {
    if (TODO.test(value)) out.push(`${path}: still a TODO stub`);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => findTodos(v, `${path}[${i}]`, out));
  } else if (isObj(value)) {
    for (const [k, v] of Object.entries(value)) findTodos(v, path ? `${path}.${k}` : k, out);
  }
  return out;
}

/**
 * Validate a parsed config. Returns { errors: string[] }.
 * @param {any} c parsed config
 * @param {{ cwd?: string, registryEntry?: any }} [opts] cwd enables file-existence checks
 */
export function validateConfig(c, { cwd, registryEntry } = {}) {
  const e = [];
  if (!isObj(c)) return { errors: ['config is not a JSON object'] };
  if (c.schema !== SCHEMA) e.push(`schema must be "${SCHEMA}"`);
  if (!isStr(c.app)) e.push('app: required');
  if (registryEntry && c.app !== registryEntry.id) e.push(`app "${c.app}" does not match registry id "${registryEntry.id}"`);
  if (!STAGES.includes(c.stage)) e.push(`stage must be one of ${STAGES.join(', ')}`);
  if (registryEntry && c.stage !== registryEntry.stage) e.push(`stage "${c.stage}" disagrees with canon/public-apps.json ("${registryEntry.stage}"); the registry is the source of truth`);
  if (!DATA_CLASSES.includes(c.dataClass)) e.push(`dataClass must be one of ${DATA_CLASSES.join(', ')}`);
  if (registryEntry && c.dataClass !== registryEntry.dataClass) e.push(`dataClass "${c.dataClass}" disagrees with the registry ("${registryEntry.dataClass}")`);

  const gp = c.goldenPath;
  if (!isObj(gp)) e.push('goldenPath: required');
  else {
    const stages = Array.isArray(gp.stages) ? gp.stages : [];
    if (!stages.length) e.push('goldenPath.stages: at least one stage');
    const kinds = new Set(stages.map((s) => s?.kind));
    for (const k of REQUIRED_STAGE_KINDS) if (!kinds.has(k)) e.push(`goldenPath.stages: missing a "${k}" stage`);
    stages.forEach((s, i) => {
      if (!isStr(s?.id)) e.push(`goldenPath.stages[${i}].id: required`);
      if (!isStr(s?.oracle)) e.push(`goldenPath.stages[${i}].oracle: required (the semantic outcome this stage must show, never presence alone)`);
    });
    if (!isObj(gp.flows) || !Object.keys(gp.flows).length) e.push('goldenPath.flows: map surface -> flow module path');
    if (!isObj(gp.accounts) || gp.accounts.policy !== 'canary-only') e.push('goldenPath.accounts.policy must be "canary-only"');
  }

  const po = c.paidOutcome;
  if (!isObj(po)) e.push('paidOutcome: required');
  else {
    if (!isStr(po.plan)) e.push('paidOutcome.plan: required');
    if (!(typeof po.price === 'number' && po.price >= 0)) e.push('paidOutcome.price: number required');
    if (!isStr(po.currency)) e.push('paidOutcome.currency: required');
    if (!['month', 'year', 'week', 'once'].includes(po.interval)) e.push('paidOutcome.interval: month|year|week|once');
    if (!isStr(po.priceSource)) e.push('paidOutcome.priceSource: path of the file the live price is read from (fails closed if unparseable)');
    if (!isStr(po.freeAlternative)) e.push('paidOutcome.freeAlternative: what the buyer does instead of paying');
  }

  const b = c.buyer;
  if (!isObj(b)) e.push('buyer: required');
  else {
    if (!isStr(b.personas) && !(Array.isArray(b.personas) && b.personas.length > 0 && b.personas.every(p => isStr(p?.id) && isStr(p?.brief)))) e.push('buyer.personas: path or nonempty archetype list (public, no PII)');
    if (!isStr(b.calibration) && !(isObj(b.calibration) && Array.isArray(b.calibration.holdouts) && Array.isArray(b.calibration.positiveCanaries))) e.push('buyer.calibration: path or calibration set with holdouts and positiveCanaries');
  }

  const p = c.privacy;
  if (!isObj(p)) e.push('privacy: required');
  else {
    if (!['standard', 'health'].includes(p.profile)) e.push('privacy.profile: standard|health');
    if (c.dataClass === 'health' && p.profile !== 'health') e.push('privacy.profile must be "health" when dataClass is health');
    if (!isStr(p.registry)) e.push('privacy.registry: path to the tracker registry');
    if (!Array.isArray(p.crawl) || !p.crawl.length) e.push('privacy.crawl: at least one page to crawl');
    if (!isStr(p.policyUrl)) e.push('privacy.policyUrl: required');
    if (p.profile === 'health' && !isStr(p.healthPolicyUrl)) e.push('privacy.healthPolicyUrl: required for the health profile (consumer health data privacy policy)');
  }

  const v = c.customerVoice;
  if (!isObj(v)) e.push('customerVoice: required');
  else {
    if (!Array.isArray(v.channels) || !v.channels.length) e.push('customerVoice.channels: list every channel customers can write on');
    (v.channels || []).forEach((ch, i) => {
      if (!CHANNEL_KINDS.includes(ch?.kind)) e.push(`customerVoice.channels[${i}].kind: one of ${CHANNEL_KINDS.join(', ')}`);
      if (!isStr(ch?.route)) e.push(`customerVoice.channels[${i}].route: where the message is captured (handler path or service)`);
    });
    if (v.approval !== 'tim') e.push('customerVoice.approval must be "tim" (no reply goes out without his approval)');
  }

  if (!isObj(c.waste) || !isStr(c.waste.appId)) e.push('waste.appId: register the app in the waste registry');
  if (!isObj(c.capacity) || !isStr(c.capacity.appId)) e.push('capacity.appId: register the app in the capacity collector');

  e.push(...findTodos(c, '', []));

  if (cwd) {
    const paths = [
      ...Object.values(gp?.flows ?? {}),
      po?.priceSource, b?.personas, b?.calibration, p?.registry,
    ].filter(isStr);
    for (const rel of paths) if (!TODO.test(rel) && !existsSync(join(cwd, rel))) e.push(`${rel}: referenced file does not exist`);
  }
  return { errors: e };
}

export function loadConfig(cwd, rel) {
  const path = join(cwd, rel);
  if (!existsSync(path)) return { config: null, errors: [`${rel}: missing (public apps must have a certification config)`] };
  let config;
  try { config = JSON.parse(readFileSync(path, 'utf8')); } catch (err) {
    return { config: null, errors: [`${rel}: not valid JSON (${err.message})`] };
  }
  return { config, errors: [] };
}
