import { readFileSync, statSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { isAbsolute, relative, sep } from 'node:path';
import { appFile } from '../judge/artifacts.mjs';

export const PUBLIC_PERSONA_FIELDS = Object.freeze([
  'occupation', 'publicRole', 'publicLinkKinds', 'market', 'currentTools', 'publicGoals',
]);

export function publicPersonaBrief(facts) {
  if (!facts || typeof facts !== 'object' || Array.isArray(facts) || !Object.keys(facts).length) throw new Error('public facts required');
  for (const [key, value] of Object.entries(facts)) {
    if (!PUBLIC_PERSONA_FIELDS.includes(key)) throw new Error(`persona field not allowed: ${key}`);
    if (!(typeof value === 'string' || Number.isFinite(value) ||
        (Array.isArray(value) && value.every(item => typeof item === 'string')))) throw new Error('invalid public fact');
    if (/[\w.+-]+@[\w-]+\.[\w.]+/.test(JSON.stringify(value))) throw new Error('email is not a public persona fact');
  }
  return `Verified public facts: ${JSON.stringify(facts)}. Budget and willingness to pay are unknown; infer only from these facts.`;
}

export function readBuyerSetting(cwd, value) {
  return typeof value === 'string' ? JSON.parse(readFileSync(appFile(cwd, value), 'utf8')) : value;
}

export function archetypes({ cwd, config }) {
  const raw = readBuyerSetting(cwd, config.buyer.personas);
  const rows = Array.isArray(raw) ? raw : raw?.personas;
  if (!Array.isArray(rows) || !rows.length || rows.some(row => !/^[a-z0-9_-]+$/i.test(row.id) ||
      typeof row.brief !== 'string' || !row.brief.trim() || (row.control !== undefined && typeof row.control !== 'boolean')) ||
      new Set(rows.map(row => row.id)).size !== rows.length) throw new Error('invalid archetype personas');
  return rows.map(({ id, brief, control = false }) => ({ id, brief, control, tier: 'A', identityTokens: [] }));
}

export function loadPersona({ cwd, config, ref }) {
  const publicRow = archetypes({ cwd, config }).find(row => row.id === ref);
  if (publicRow) return publicRow;
  const dir = config.buyer.privatePersonaDir;
  if (!dir || !isAbsolute(dir)) throw new Error('privatePersonaDir must be an absolute private directory');
  const root = realpathSync(dir);
  const fromRepo = relative(realpathSync(cwd), root);
  if (fromRepo === '' || (!fromRepo.startsWith(`..${sep}`) && fromRepo !== '..' && !isAbsolute(fromRepo))) {
    throw new Error('private personas must live outside the app repository');
  }
  // Reject other git worktrees too; a private filename is not enough.
  const tracked = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (tracked.stdout?.trim() === 'true') throw new Error('private personas cannot live in git');
  return readPrivate(root, ref);
}

function readPrivate(root, ref) {
  const path = appFile(root, `${ref}.json`);
  if ((statSync(path).mode & 0o777) !== 0o600) throw new Error('private persona requires 0600 permissions');
  const file = JSON.parse(readFileSync(path, 'utf8'));
  const allowed = ['subjectId', 'facts', 'identityTokens'];
  if (Object.keys(file).some(key => !allowed.includes(key)) || !/^[a-z0-9_-]+$/i.test(file.subjectId) ||
      !Array.isArray(file.identityTokens ?? []) || (file.identityTokens ?? []).some(token => typeof token !== 'string')) {
    throw new Error('invalid private persona fields');
  }
  return { id: file.subjectId, tier: 'B', brief: publicPersonaBrief(file.facts), identityTokens: file.identityTokens ?? [] };
}
