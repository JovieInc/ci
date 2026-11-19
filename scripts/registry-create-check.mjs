#!/usr/bin/env node
// JOV-13083: inspect signed relay events without trusting their payload shape.
import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { canCreate, keyOf, refOf, INACTIVE, DEFAULT_REGISTRY } from '../guards/resources.mjs';

const TEAM_ID = 'bdc09edc-f91c-4a06-b308-74b4fcf093f8';
const LABEL = 'registry-duplicate';
const warning = (message) => console.log(`::warning::${message.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')}`);
const names = (entry) => [entry.name, ...(entry.aliases || []), ...(entry.retiredNames || [])];

function payloadOf(event) {
  const payload = event?.client_payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const { kind, name } = payload;
  if (!['github-repo', 'vercel-project'].includes(kind) || typeof name !== 'string') return null;
  // Comparing the whole match also rejects a final newline (JS `$` permits one).
  if (name.match(/^[A-Za-z0-9_.\/-]{1,201}$/)?.[0] !== name) return null;
  if (kind === 'github-repo' && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(name)) return null;
  return { kind, name }; // Ignore all other relay fields.
}

export function decide(registry, { kind, name }) {
  const entries = registry.resources || [];
  if (entries.some((entry) => entry.kind === kind && !INACTIVE.has(entry.status)
    && [entry.name, ...(entry.aliases || [])].some((n) => n.toLowerCase() === name.toLowerCase()))) {
    return { action: 'registered' };
  }
  const result = canCreate(registry, { kind, name });
  if (result.ok) return { action: 'unregistered' };
  const normalized = keyOf(kind, name);
  // keyOf finds exact normalized twins, including retired names. Ask the guard
  // about individual entries for near-names rather than copying its edit-distance
  // rule. A placeholder refusal without entries must not implicate every entry.
  const checksEntries = canCreate({ resources: [] }, { kind, name }).ok;
  const conflicts = entries.filter((entry) => names(entry).some((n) => keyOf(entry.kind, n) === normalized)
    || (checksEntries && !canCreate({ resources: [entry] }, { kind, name }).ok)).map(refOf);
  return { action: 'duplicate', reason: result.reason, key: `${kind}:${normalized}`, conflicts: [...new Set(conflicts)] };
}

function issueText({ decision, kind, name, runUrl }) {
  const marker = `registry-duplicate: ${decision.key}`;
  return {
    marker,
    title: `${marker} — ${kind} "${name}" collides with ${decision.conflicts.join(', ')}`,
    body: [
      `Kind: ${kind}`, `Name: ${name}`, `Reason: ${decision.reason}`,
      `Conflicts: ${decision.conflicts.join(', ') || 'none (placeholder or reserved token)'}`,
      'Rule: registry-check can-create; exit 1 = reuse, never auto-delete; deletion/rename is a Tim per-item yes.',
      `Run: ${runUrl}`, 'Linear parent: JOV-13051 / JOV-13083',
    ].join('\n\n'),
  };
}

async function jsonResponse(fetch, url, init) {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

export async function upsertLinearIssue({ fetch, apiKey, teamId = TEAM_ID, decision, kind, name, runUrl }) {
  if (!apiKey) return { mode: 'fallback' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  const { marker, title, body } = issueText({ decision, kind, name, runUrl });
  async function graphql(query, variables) {
    const response = await jsonResponse(fetch, 'https://api.linear.app/graphql', {
      method: 'POST', signal: controller.signal,
      headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    if (response.errors?.length || !response.data) throw new Error('GraphQL error or missing data');
    return response.data;
  }
  try {
    const data = await graphql(`query RegistryDuplicate($teamId: ID!, $marker: String!) {
      issues(filter: {team: {id: {eq: $teamId}}, title: {contains: $marker},
        state: {type: {nin: ["completed", "canceled"]}}}, first: 1) {
        nodes { id identifier }
      }
    }`, { teamId, marker });
    if (!Array.isArray(data.issues?.nodes)) throw new Error('Missing issue search result');
    const existing = data.issues.nodes[0];
    if (existing) {
      if (!existing.id || !existing.identifier) throw new Error('Missing issue identity');
      const result = await graphql(`mutation RegistryDuplicateComment($issueId: String!, $body: String!) {
        commentCreate(input: {issueId: $issueId, body: $body}) { success }
      }`, { issueId: existing.id, body });
      if (!result.commentCreate?.success) throw new Error('Comment was not created');
      return { mode: 'reused', identifier: existing.identifier };
    }
    const result = await graphql(`mutation RegistryDuplicateCreate($teamId: String!, $title: String!, $body: String!) {
      issueCreate(input: {teamId: $teamId, title: $title, description: $body}) {
        success issue { identifier }
      }
    }`, { teamId, title, body });
    if (!result.issueCreate?.success || !result.issueCreate.issue?.identifier) throw new Error('Issue was not created');
    return { mode: 'created', identifier: result.issueCreate.issue.identifier };
  } catch (error) {
    warning(`registry-create: Linear unavailable (${error.message}); using GitHub fallback`);
    return { mode: 'fallback' };
  } finally {
    clearTimeout(timer);
  }
}

async function upsertGithubIssue({ fetch, token, repository, decision, kind, name, runUrl }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  const { marker, title, body } = issueText({ decision, kind, name, runUrl });
  const base = `https://api.github.com/repos/${repository}`;
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' };
  const request = (path, method = 'GET', data) => jsonResponse(fetch, `${base}${path}`, {
    method, headers, signal: controller.signal, ...(data && { body: JSON.stringify(data) }),
  });
  try {
    if (!token || !repository) throw new Error('Missing GitHub token or repository');
    // Pagination enumerates open labeled issues; there are no retries or polling.
    for (let page = 1; ; page++) {
      const issues = await request(`/issues?state=open&labels=${LABEL}&per_page=100&page=${page}`);
      if (!Array.isArray(issues)) throw new Error('Missing GitHub issue list');
      const existing = issues.find((issue) => !issue.pull_request
        && (issue.title === marker || issue.title?.startsWith(`${marker} — `)));
      if (existing) {
        const comment = await request(`/issues/${existing.number}/comments`, 'POST', { body });
        if (!comment.id) throw new Error('Comment was not created');
        return { mode: 'reused', identifier: `#${existing.number}` };
      }
      if (issues.length < 100) break;
    }
    const label = await fetch(`${base}/labels/${LABEL}`, { headers, signal: controller.signal });
    if (label.status === 404) {
      const created = await fetch(`${base}/labels`, { method: 'POST', headers, signal: controller.signal,
        body: JSON.stringify({ name: LABEL, color: 'B60205' }) });
      // Another event may have created the label while this event was searching.
      if (!created.ok && created.status !== 422) throw new Error(`Label HTTP ${created.status}`);
    } else if (!label.ok) throw new Error(`Label HTTP ${label.status}`);
    const issue = await request('/issues', 'POST', { title, body, labels: [LABEL] });
    if (!issue.number) throw new Error('Issue was not created');
    return { mode: 'created', identifier: `#${issue.number}` };
  } catch (error) {
    warning(`registry-create: GitHub fallback unavailable (${error.message})`);
    return { mode: 'unavailable' };
  } finally {
    clearTimeout(timer);
  }
}

export async function run({ env = process.env, fetch = globalThis.fetch, registry } = {}) {
  const finish = (result) => {
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY,
      `Registry create: ${result.action}${result.key ? ` (${result.key})` : ''}${result.linear ? `; Linear ${result.linear.mode}` : ''}${result.github ? `; GitHub ${result.github.mode}` : ''}.\n`);
    return result;
  };
  let event;
  try {
    event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  } catch {
    warning('registry-create: ignored invalid payload');
    return finish({ action: 'ignored' });
  }
  const payload = payloadOf(event);
  if (!payload) {
    warning('registry-create: ignored invalid payload');
    return finish({ action: 'ignored' });
  }
  const decision = decide(registry ?? JSON.parse(readFileSync(DEFAULT_REGISTRY, 'utf8')), payload);
  if (decision.action !== 'duplicate') return finish(decision);
  const options = { fetch, decision, ...payload, runUrl: env.RUN_URL };
  const linear = env.REGISTRY_CREATE_LINEAR === 'off' ? { mode: 'fallback' }
    : await upsertLinearIssue({ ...options, apiKey: env.LINEAR_API_KEY, teamId: env.LINEAR_TEAM_ID || TEAM_ID });
  const github = linear.mode === 'fallback'
    ? await upsertGithubIssue({ ...options, token: env.GITHUB_TOKEN || env.GH_TOKEN, repository: env.GITHUB_REPOSITORY })
    : undefined;
  return finish({ ...decision, linear, ...(github && { github }) });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await run();
