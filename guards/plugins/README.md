Drop a guard here once and every consumer gets it on the next pin bump.
A plugin is an ES module: `export const name = 'id'; export async function run({cwd, baselineDir}) { return { fails: [string] } }`.
Baseline violations in the consumer under `.company-guards/<name>-baseline.json`; fail only on new or worse.

- `schedule-registration` (shadow): a new schedule (GitHub cron, wrangler cron, vercel.json cron, systemd timer, launchd interval) must register into the platform's shared scheduler and say why no event can do the job (inline `scheduler: <id> why-not-event: <...>`, `.company-guards/schedules.json`, or a `clock` block in canon/automation-registry.jsonl). Baseline: `.company-guards/schedule-registration-baseline.json` (array of site keys; only shrinks). Generate it from `run().current`.
