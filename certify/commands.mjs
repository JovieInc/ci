// Runtime subcommands are separate from the static config validator.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig, validateConfig } from './config.mjs';
import { crawl, loadRegistry } from './privacy/privacy-inventory.mjs';
import { buildRecord, toMarkdown } from './privacy/privacy-check.mjs';
import { buildReceipt, signReceipt, publishReceipt } from './receipt.mjs';

export async function runCommand(cmd, args, { cwd = process.cwd(), env = process.env,
  crawlFn = crawl, publishFn = publishReceipt } = {}) {
  const values = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i].startsWith('--') || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing value for ${args[i]}`);
    values[args[i].slice(2)] = args[i + 1];
  }
  if (!values.config) throw new Error('--config certification/<app>.json required');
  const { config, errors } = loadConfig(cwd, values.config);
  if (errors.length) throw new Error(errors.join('; '));
  const invalid = validateConfig(config, { cwd }).errors;
  if (invalid.length) throw new Error(invalid.join('; '));
  const read = name => {
    if (!values[name]) throw new Error(`--${name} required`);
    return JSON.parse(readFileSync(resolve(cwd, values[name]), 'utf8'));
  };
  const write = value => {
    if (!values.out) throw new Error('--out required');
    writeFileSync(resolve(cwd, values.out), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  };
  if (cmd === 'privacy') {
    if (!values.out) throw new Error('--out required');
    const registry = loadRegistry(config, cwd);
    const snapshot = await crawlFn({ config, registry, cwd });
    const record = buildRecord(snapshot, registry, config, { cwd });
    write(record);
    if (values.markdown) writeFileSync(resolve(cwd, values.markdown), toMarkdown(record), { mode: 0o600 });
    return record.pass ? 0 : 1;
  }
  if (cmd === 'receipt') {
    const walk = read('walk'), buyer = read('buyer'), privacy = read('privacy');
    const receipt = buildReceipt(config, { walk, buyer, privacy,
      voice: values.voice ? read('voice') : walk.voice, sha: values.sha ?? walk.sha,
      runId: values['run-id'] ?? walk.runId ?? walk.run_id });
    write(receipt);
    return 0; // Assembly writes an explicitly blocked, unsigned draft.
  }
  if (cmd === 'publish') {
    const calibration = JSON.parse(readFileSync(resolve(cwd, config.buyer.calibration), 'utf8'));
    const signed = signReceipt(read('receipt'), { config: { ...config, calibration }, key: env.CERT_RECEIPT_SIGNING_KEY });
    const result = await publishFn(signed, { repo: values.repo ?? env.GITHUB_REPOSITORY,
      token: env.GITHUB_TOKEN, key: env.CERT_RECEIPT_SIGNING_KEY });
    if (values.out) write({ receipt: signed, ...result });
    return signed.verdict === 'certified' ? 0 : 1;
  }
  throw new Error(`Unknown certification command: ${cmd}`);
}
