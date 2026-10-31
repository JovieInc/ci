import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { digestOf } from '../judge/receipt.mjs';
import { RECEIPT_SCHEMA } from './rubric.mjs';

export function stateDir(config) {
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(config.app)) throw new Error('invalid app id');
  return join(homedir(), '.local', 'state', `${config.app}-buyer-eval`);
}
export function sealReceipt(receipt) {
  const { id, ...body } = receipt;
  return { ...body, id: digestOf(body) };
}
export function validReceipt(receipt) {
  if (!receipt || receipt.schema !== RECEIPT_SCHEMA) return false;
  const { id, ...body } = receipt;
  return typeof id === 'string' && id === digestOf(body);
}
export function writeReceipt(receipt, { config, cwd, state = stateDir(config) }) {
  const rel = relative(resolve(cwd), resolve(state));
  if (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))) throw new Error('buyer state must be outside app repository');
  mkdirSync(join(state, 'receipts'), { recursive: true, mode: 0o700 });
  writeFileSync(join(state, 'receipts', `${receipt.id}.json`), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  appendFileSync(join(state, 'cost.jsonl'), `${JSON.stringify({ app: config.app, at: receipt.at, receipt: receipt.id, ...receipt.cost })}\n`, { mode: 0o600 });
}
export function readReceipts(state) {
  const dir = join(state, 'receipts');
  let names;
  try { names = readdirSync(dir); } catch { return []; }
  return names.filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(name => {
    try {
      const path = join(dir, name);
      if ((statSync(path).mode & 0o777) !== 0o600) return null;
      const row = JSON.parse(readFileSync(path, 'utf8'));
      return validReceipt(row) && `${row.id}.json` === name ? row : null;
    } catch { return null; }
  }).filter(Boolean).sort((a, b) => String(a.at).localeCompare(String(b.at)));
}
