import { readFileSync } from 'node:fs';
import { appFile } from '../judge/artifacts.mjs';

export function readOutcome({ cwd = process.cwd(), config }) {
  const paid = config.paidOutcome;
  if (!paid || !Number.isFinite(paid.price) || paid.price < 0 || !paid.plan || !paid.currency ||
      !['month', 'year', 'week', 'once'].includes(paid.interval) || !paid.freeAlternative) {
    throw new Error('invalid paid outcome');
  }
  const source = readFileSync(appFile(cwd, paid.priceSource), 'utf8');
  if (paid.pricePattern !== undefined) {
    const matches = [...source.matchAll(new RegExp(paid.pricePattern, 'gu'))];
    if (matches.length !== 1 || !matches[0][1]?.trim() || !/^\d+(?:\.\d+)?$/.test(matches[0][1]) ||
        Number(matches[0][1]) !== paid.price) throw new Error('live price unparseable, ambiguous or differs from config');
  } else {
    const escaped = String(paid.price).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!new RegExp(`(?:^|[^\\d.])${escaped}(?![\\d.]|,\\d)`, 'u').test(source)) {
      throw new Error('price source does not contain configured price string');
    }
  }
  if (paid.trialDays !== undefined && (!Number.isInteger(paid.trialDays) || paid.trialDays < 0)) throw new Error('invalid trialDays');
  return { kind: 'paid_conversion', ...paid, horizonDays: paid.horizonDays ?? 14 };
}

export function describeOutcome(outcome) {
  return `Outcome: pay for "${outcome.plan}" at ${outcome.currency} ${outcome.price}/${outcome.interval} within ${outcome.horizonDays} days, instead of ${outcome.freeAlternative}. Card charged, not a trial start.${outcome.trialDays ? ` A ${outcome.trialDays}-day trial is available.` : ''}`;
}
