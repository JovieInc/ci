// App-owned flows supply behavior; this recorder supplies the shared evidence contract.
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, renameSync, statSync, readdirSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { appFile, requiredStages } from '../judge/artifacts.mjs';

export function resolveAccount(config, env = process.env, supplied) {
  const policy = config.goldenPath?.accounts;
  if (policy?.policy !== 'canary-only' || !policy.emailPattern) {
    throw new Error('canary-only policy and emailPattern are required');
  }
  const account = {
    email: env[policy.env?.email ?? 'CERT_CANARY_EMAIL'],
    password: env[policy.env?.password ?? 'CERT_CANARY_PASSWORD'],
  };
  if (!account.email || !new RegExp(policy.emailPattern, 'u').test(account.email)) {
    throw new Error('refusing account: email does not match canary policy');
  }
  if (supplied && (supplied.email !== account.email || supplied.password !== account.password)) {
    throw new Error('account credentials must come from configured environment variables');
  }
  return account;
}

export async function loadPlaywright(cwd) {
  const require = createRequire(join(resolve(cwd), 'package.json'));
  const entry = require.resolve('playwright');
  const rel = relative(realpathSync(resolve(cwd, 'node_modules')), realpathSync(entry));
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('playwright must be installed in the app repo node_modules');
  // Resolve from the consumer, never the kit's dependency tree.
  return import(pathToFileURL(entry).href);
}

function localSha(cwd) {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
}

export async function runWalk({ cwd = process.cwd(), config, surface = 'web', baseUrl,
  outDir, account, env = process.env, playwright, now = Date.now, sourceSha } = {}) {
  account = resolveAccount(config, env, account);
  const stages = requiredStages(config, surface);
  const flowPath = appFile(cwd, config.goldenPath.flows[surface]);
  if (!outDir || !baseUrl) throw new Error('outDir and baseUrl are required');
  new URL(baseUrl);
  outDir = resolve(outDir);
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  if (readdirSync(outDir).length) throw new Error('outDir must be empty; evidence cannot overwrite a previous walk');
  mkdirSync(join(outDir, 'dom'), { mode: 0o700 });
  mkdirSync(join(outDir, 'video'), { mode: 0o700 });
  const write = (file, value) => writeFileSync(join(outDir, file), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  const walkId = randomUUID();
  const tStartMs = now();
  const steps = [];
  const errors = [];
  write('steps.json', steps);
  let browser, context, page, video, tVideoStartMs;
  try {
    const pw = playwright ?? await loadPlaywright(cwd);
    browser = await pw.chromium.launch({ headless: true });
    const viewport = config.goldenPath.viewport ?? { width: 1440, height: 900 };
    context = await browser.newContext({ viewport, recordVideo: { dir: join(outDir, 'video'), size: viewport } });
    tVideoStartMs = now();
    page = await context.newPage();
    video = page.video();
    const snap = async (stageId, label = stageId) => {
      if (!stages.some(stage => stage.id === stageId)) throw new Error('snap cites unknown stage');
      const start = now();
      const step = String(steps.length + 1).padStart(2, '0');
      await page.screenshot({ path: join(outDir, `${step}.png`) });
      const text = await page.locator('body').innerText();
      writeFileSync(join(outDir, 'dom', `${step}.txt`), text, { mode: 0o600 });
      const row = { walkId, step, stageId, title: label, screenshot: `${step}.png`,
        video: 'walk.webm', url: page.url(), videoOffsetSec: (start - tVideoStartMs) / 1000,
        tStartMs: start, tEndMs: now(), status: 'passed' };
      steps.push(row);
      write('steps.json', steps);
      return row;
    };
    const flow = await import(pathToFileURL(flowPath).href);
    if (typeof flow.default !== 'function') throw new Error('flow must export a default function');
    await flow.default({ page, snap, settle: (ms = 1500) => page.waitForTimeout(ms), account, config, baseUrl });
  } catch {
    // Flow exceptions may contain entered credentials; keep them out of artifacts.
    errors.push('flow or capture failed');
  } finally {
    try { await context?.close(); } catch { errors.push('context close failed'); }
    try {
      if (!video) throw new Error('video missing');
      renameSync(await video.path(), join(outDir, 'walk.webm'));
      if (!statSync(join(outDir, 'walk.webm')).size) throw new Error('video empty');
    } catch { errors.push('video missing or empty'); }
    try { await browser?.close(); } catch { errors.push('browser close failed'); }
  }
  const checks = stages.map(stage => ({ stageId: stage.id,
    status: steps.some(step => step.stageId === stage.id && step.status === 'passed') ? 'passed' : 'failed' }));
  const passed = checks.length > 0 && checks.every(check => check.status === 'passed') && errors.length === 0;
  const result = { schema: 'company.walk/v1', app: config.app, walkId, surface,
    sourceSha: sourceSha ?? env.CERT_SOURCE_SHA ?? localSha(cwd),
    walkSubject: env.CERT_WALK_SUBJECT ?? null, tStartMs, tVideoStartMs, tEndMs: now(),
    status: passed ? 'passed' : 'failed', checks, errors };
  write('walk.json', result);
  return result;
}
