/**
 * Portable Source Validation guard pool (JovieInc/Jovie #26115 / #26000).
 *
 * Same checks as a serial loop: every selected guard runs (run-all), the exit
 * code is the first failing guard in list order, each guard's output prints as
 * one contiguous block in list order, and guards sharing writable state never
 * overlap. Bounded concurrency overlaps independent poles; set
 * SOURCE_GUARD_CONCURRENCY=1 to reproduce the serial loop.
 *
 * Consumers supply the guard list (selection stays repo-owned). Pin a full
 * commit SHA of JovieInc/ci (JOV-6555); never weaken required gates.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { availableParallelism } from 'node:os';
import { runCommandPool } from './command-pool.mjs';

/**
 * Default shell executor for guard commands (cwd-scoped).
 * @param {string} [cwd]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {(command: string) => Promise<{code: number, output: string}>}
 */
export function createShellExecute(cwd = process.cwd(), env = process.env) {
  return command =>
    new Promise(resolveResult => {
      const stdout = [];
      const stderr = [];
      const child = spawn(command, {
        shell: true,
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.on('data', chunk => stdout.push(chunk));
      child.stderr.on('data', chunk => stderr.push(chunk));
      child.on('error', error =>
        resolveResult({ code: 1, output: String(error) })
      );
      child.on('close', code =>
        resolveResult({
          code: code ?? 1,
          output: `${Buffer.concat(stdout)}${Buffer.concat(stderr)}`,
        })
      );
    });
}

/** Guards that touch shared git state share one lock. */
const SOURCE_GUARD_GIT_PATTERN =
  /\bgit (?:worktree|fetch|merge|checkout|reset|stash)\b/u;

/**
 * Bounded concurrency for source guards. Default ≤3 (CPU-hungry vitest poles
 * on 4-vCPU runners). SOURCE_GUARD_CONCURRENCY=1 restores serial behavior.
 * @param {string | undefined} [value]
 * @returns {number}
 */
export function sourceGuardConcurrency(
  value = process.env.SOURCE_GUARD_CONCURRENCY
) {
  const parsed = Number(String(value ?? '').trim());
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  return Math.max(1, Math.min(3, availableParallelism()));
}

/**
 * Shared writable state a source guard touches. Always adds the `git` lock when
 * the command mutates checkout metadata; merges optional structural locks.
 * @param {string} command
 * @param {(command: string) => string[]} [extraLocks]
 * @returns {string[]}
 */
export function sourceGuardLocks(command, extraLocks) {
  const locks = new Set(extraLocks?.(command) ?? []);
  if (SOURCE_GUARD_GIT_PATTERN.test(command)) locks.add('git');
  return [...locks].sort();
}

/**
 * One buffered output block: stop-commands window, body, resume, summary line,
 * and a real annotation on failure (guard tests print mocked `::error::`).
 * @param {string} id
 * @param {{code: number, output: string, durationMs?: number} | undefined} result
 * @returns {string}
 */
export function sourceGuardBlock(id, result) {
  const token = randomUUID();
  const output = String(result?.output ?? '');
  return [
    `::stop-commands::${token}`,
    output === '' || output.endsWith('\n') ? output : `${output}\n`,
    `::${token}::`,
    `[source-guards] ${id}: exit ${result?.code ?? 1}; duration_ms=${Math.round(result?.durationMs ?? 0)}`,
    ...(result && result.code !== 0
      ? [
          `::error title=source guard ${id}::${id} failed (exit ${result.code}); read its output above.`,
        ]
      : []),
  ].join('\n');
}

/**
 * @param {readonly {id: string, command: string}[]} guards
 * @param {{
 *   execute?: (command: string) => {code: number, output: string} | Promise<{code: number, output: string}>,
 *   concurrency?: number,
 *   extraLocks?: (command: string) => string[],
 *   longPoles?: readonly string[],
 *   now?: () => number,
 *   log?: (line: string) => void,
 * }} [opts]
 * @returns {Promise<{code: number, output: string, skipped?: boolean}>}
 */
export async function runSourceGuards(guards, opts = {}) {
  const selected = guards ?? [];
  if (selected.length === 0) {
    return {
      code: 0,
      output: 'Source-read guards skipped (no guard input changed)\n',
      skipped: true,
    };
  }
  const concurrency = opts.concurrency ?? sourceGuardConcurrency();
  const longPoles = new Set(opts.longPoles ?? []);
  const log = opts.log ?? console.log;
  let nextToPrint = 0;
  /** @type {Map<number, string>} */
  const blocks = new Map();
  const execute = opts.execute ?? createShellExecute();
  const results = await runCommandPool(
    selected.map(guard => guard.command),
    {
      execute,
      concurrency,
      locks: selected.map(guard =>
        sourceGuardLocks(guard.command, opts.extraLocks)
      ),
      keepGoing: true,
      first:
        concurrency > 1
          ? selected.flatMap((guard, index) =>
              longPoles.has(guard.id) ? [index] : []
            )
          : [],
      now: opts.now,
      onSettle: (index, result) => {
        blocks.set(index, sourceGuardBlock(selected[index].id, result));
        while (blocks.has(nextToPrint)) {
          log(blocks.get(nextToPrint));
          blocks.delete(nextToPrint);
          nextToPrint += 1;
        }
      },
    }
  );
  let code = 0;
  const combined = results
    .map((result, index) => {
      const block = sourceGuardBlock(selected[index].id, result);
      if (result?.code !== 0 && code === 0) code = result?.code ?? 1;
      return block;
    })
    .join('\n');
  return { code, output: `${combined}\n` };
}
