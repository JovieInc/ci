/**
 * Bounded command pool (promoted from JovieInc/Jovie `runCommandPool`).
 *
 * Guarantees:
 * - Commands sharing a lock run one at a time in list order.
 * - After the first failure no new command starts unless `keepGoing: true`
 *   (run-all). In-flight commands always finish.
 * - A synchronous executor completes before the next start is considered, so
 *   concurrency 1 + keepGoing false matches a serial loop.
 * - `first` indexes (long poles) start ahead of list order but never jump an
 *   earlier command that shares one of their locks.
 * - `stop` is consulted before each start; once true, nothing new starts.
 * - `onSettle(index, result)` fires when a command finishes.
 *
 * @typedef {{code: number, output: string}} ExecResult
 * @typedef {ExecResult & {durationMs: number}} SettledResult
 */

/**
 * @param {readonly string[]} commands
 * @param {{
 *   execute: (command: string) => ExecResult | Promise<ExecResult>,
 *   concurrency: number,
 *   locks?: readonly (readonly string[])[],
 *   first?: readonly number[],
 *   now?: () => number,
 *   stop?: () => boolean,
 *   keepGoing?: boolean,
 *   onSettle?: (index: number, result: SettledResult) => void,
 * }} opts
 * @returns {Promise<(SettledResult | undefined)[]>}
 */
export function runCommandPool(commands, opts) {
  const { execute, concurrency } = opts;
  const keepGoing = opts.keepGoing === true;
  const locks = opts.locks ?? commands.map(() => []);
  const now = opts.now ?? Date.now;
  const results = new Array(commands.length);
  const first = new Set(opts.first ?? []);
  const pending = commands
    .map((_, index) => index)
    .sort((a, b) => Number(first.has(b)) - Number(first.has(a)) || a - b);
  const held = new Set();
  const blocked = index =>
    locks[index].some(lock => held.has(lock)) ||
    pending.some(
      other =>
        other < index && locks[other].some(l => locks[index].includes(l))
    );
  let running = 0;
  let failed = false;
  let stopped = false;
  let pumping = false;
  let repump = false;

  return new Promise(resolveAll => {
    const finish = (index, startedAt, result) => {
      running -= 1;
      for (const lock of locks[index]) held.delete(lock);
      const code = Number.isInteger(result?.code) ? result.code : 1;
      results[index] = {
        code,
        output: String(result?.output ?? ''),
        durationMs: Math.max(0, now() - startedAt),
      };
      if (code !== 0) failed = true;
      opts.onSettle?.(index, results[index]);
      pump();
    };
    const start = index => {
      running += 1;
      for (const lock of locks[index]) held.add(lock);
      const startedAt = now();
      const onError = error =>
        finish(index, startedAt, {
          code: 1,
          output:
            error instanceof Error
              ? error.stack || error.message
              : String(error),
        });
      let result;
      try {
        result = execute(commands[index]);
      } catch (error) {
        onError(error);
        return;
      }
      if (result instanceof Promise) {
        result.then(value => finish(index, startedAt, value), onError);
      } else {
        finish(index, startedAt, result);
      }
    };
    const pump = () => {
      if (pumping) {
        repump = true;
        return;
      }
      pumping = true;
      do {
        repump = false;
        while (!(failed && !keepGoing) && !stopped && running < concurrency) {
          if (pending.length > 0 && opts.stop?.()) {
            stopped = true;
            break;
          }
          const slot = pending.findIndex(index => !blocked(index));
          if (slot === -1) break;
          start(pending.splice(slot, 1)[0]);
        }
      } while (repump);
      pumping = false;
      if (
        running === 0 &&
        (stopped || pending.length === 0 || (failed && !keepGoing))
      ) {
        resolveAll(results);
      }
    };
    pump();
  });
}
