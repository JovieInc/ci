/**
 * Same-name fail-closed fan-in for matrix shards (JovieInc/Jovie #26116 /
 * JOV-13072 M1/M2).
 *
 * Pattern: keep the required check *name* on a lightweight fan-in job that
 * `needs` the matrix workers. Workers may rename freely; the fan-in fails
 * closed on any non-success worker result (failure, cancelled, skipped, or
 * missing). Never use `continue-on-error` on the gate.
 *
 * Consumers must not drop or rename required checks when adopting shards.
 */

/** Results that must not green the required check name. */
export const NON_SUCCESS_SHARD_RESULTS = Object.freeze([
  'failure',
  'cancelled',
  'skipped',
  '',
]);

/**
 * @param {string | undefined | null} result needs.<worker>.result
 * @returns {{ok: boolean, message: string}}
 */
export function evaluateShardFanIn(result) {
  const value = result == null ? '' : String(result);
  if (value === 'success') {
    return { ok: true, message: 'shards succeeded' };
  }
  return {
    ok: false,
    message: `ci shards failed closed: ${value || '(missing)'}`,
  };
}

/**
 * Process-exit helper for bash/node gate steps.
 * @param {string | undefined | null} result
 * @param {{error?: (msg: string) => void, exit?: (code: number) => void}} [io]
 * @returns {number} exit code
 */
export function assertShardsSuccess(result, io = {}) {
  const error = io.error ?? (msg => console.error(`::error::${msg}`));
  const exit = io.exit ?? (code => process.exit(code));
  const verdict = evaluateShardFanIn(result);
  if (verdict.ok) return 0;
  error(verdict.message);
  exit(1);
  return 1;
}

/**
 * Bash gate body consumers paste into the fan-in job (env: SHARDS_RESULT).
 * @param {string} [label] annotation title prefix
 * @returns {string}
 */
export function fanInGateShell(label = 'ci shards') {
  return [
    'set -euo pipefail',
    'if [[ "$SHARDS_RESULT" != \'success\' ]]; then',
    `  echo "::error::${label} failed closed: $SHARDS_RESULT"`,
    '  exit 1',
    'fi',
  ].join('\n');
}

/**
 * Contract description for tests / docs (stable required names).
 * @param {{
 *   faninJob: string,
 *   workerJob: string,
 *   requiredName: string,
 *   matrix: Record<string, unknown>,
 * }} spec
 */
export function describeFanInPair(spec) {
  return {
    ...spec,
    workerIfCancelledOk: true,
    fanInIfAlways: true,
    failFast: false,
    gateFailsOn: [...NON_SUCCESS_SHARD_RESULTS],
    rule: 'required check name stays on the fan-in; workers are not required by name',
  };
}
