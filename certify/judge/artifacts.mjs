import { realpathSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

// Resolve existing local artifacts and reject traversal and symlink escapes.
export function appFile(cwd, ref) {
  if (typeof ref !== 'string' || !ref || isAbsolute(ref)) throw new Error('expected relative file path');
  const root = realpathSync(cwd);
  const file = realpathSync(resolve(root, ref));
  const rel = relative(root, file);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || !statSync(file).isFile()) {
    throw new Error('file escapes artifact root or is not a regular file');
  }
  return file;
}

export function requiredStages(config, surface) {
  const stages = config.goldenPath?.stages?.filter(stage => !stage.surface || stage.surface === surface);
  if (!stages?.length || stages.some(stage => !stage.id || !stage.oracle) ||
      new Set(stages.map(stage => stage.id)).size !== stages.length) {
    throw new Error('nonempty, unique stages with semantic oracles are required');
  }
  return stages;
}

export function readWalk(runDir) {
  const steps = JSON.parse(readFileSync(appFile(runDir, 'steps.json'), 'utf8'));
  const meta = JSON.parse(readFileSync(appFile(runDir, 'walk.json'), 'utf8'));
  if (!Array.isArray(steps) || !steps.length) throw new Error('walk has no steps');
  const video = appFile(runDir, 'walk.webm');
  if (!statSync(video).size) throw new Error('walk video is empty');
  const ids = new Set();
  for (const step of steps) {
    if (!/^\d{2,}$/.test(step.step) || ids.has(step.step)) throw new Error('invalid or duplicate step id');
    ids.add(step.step);
    if (!meta.walkId || step.walkId !== meta.walkId || !step.stageId || step.status !== 'passed' ||
        !Number.isFinite(step.tStartMs) || !Number.isFinite(step.tEndMs) || step.tEndMs < step.tStartMs ||
        !Number.isFinite(step.videoOffsetSec) || step.videoOffsetSec < 0) throw new Error('invalid step provenance or timestamps');
    if (!statSync(appFile(runDir, step.screenshot)).size) throw new Error('empty frame');
    appFile(runDir, `dom/${step.step}.txt`);
  }
  return { steps, meta, video };
}
