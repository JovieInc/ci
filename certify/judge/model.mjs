import { spawn } from 'node:child_process';

export const STRONG_MODEL = 'claude-opus-5-5';

export function buildClaudeArgs({ prompt, schema, model = STRONG_MODEL, imageDir }) {
  return ['-p', prompt, '--model', model, '--tools', 'Read', '--allowedTools', 'Read',
    '--add-dir', imageDir, '--setting-sources', '', '--strict-mcp-config',
    '--mcp-config', '{"mcpServers":{}}', '--no-session-persistence',
    '--output-format', 'json', '--json-schema', JSON.stringify(schema)];
}

export function runClaude(args, cwd, timeoutMs = 900_000) {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('judge timeout'));
    }, timeoutMs);
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.length > 4_000_000) { child.kill('SIGKILL'); reject(new Error('judge output limit')); }
    });
    child.stderr.resume();
    child.on('error', () => { clearTimeout(timer); reject(new Error('judge process unavailable')); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`judge exited ${code}`));
      else resolve(stdout);
    });
  });
}

export function parseEnvelope(value) {
  const envelope = typeof value === 'string' ? JSON.parse(value) : value;
  if (!envelope || envelope.is_error || !envelope.structured_output) throw new Error('invalid judge envelope');
  const costUsd = envelope.total_cost_usd ?? 0;
  if (!Number.isFinite(costUsd) || costUsd < 0) throw new Error('invalid model cost');
  return { output: envelope.structured_output, costUsd };
}
