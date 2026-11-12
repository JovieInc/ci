import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { appFile, readWalk } from '../judge/artifacts.mjs';

export const SAMPLE_EVERY_SEC = 6;

export function probeDuration(video) {
  const result = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', video],
    { encoding: 'utf8', timeout: 30_000 });
  const duration = Number(result.stdout?.trim());
  return result.status === 0 && Number.isFinite(duration) && duration > 0 ? duration : null;
}

export function extractFrame(video, tSec, path) {
  const result = spawnSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(Math.max(0, tSec)), '-i', video,
    '-frames:v', '1', '-vf', 'scale=1280:-2', path], { encoding: 'utf8', timeout: 30_000 });
  return result.status === 0 && existsSync(path) && statSync(path).size > 0;
}

export function withWindows(steps, durationSec) {
  return steps.map((step, index) => ({ ...step, endSec: steps[index + 1]?.tSec ?? durationSec ?? step.tSec + 3 }));
}

// The entire walk is retained. Dropping an inconvenient frame would be false green.
export function ingestWalk(source, { extract = extractFrame, probe = probeDuration } = {}) {
  source = resolve(source);
  const frameDir = mkdtempSync(join(tmpdir(), 'cert-frames-'));
  try {
    let raw, meta = {}, video;
    if (existsSync(join(source, 'steps.json'))) {
      if (existsSync(join(source, 'walk.json'))) {
        ({ steps: raw, meta, video } = readWalk(source));
      } else {
        raw = JSON.parse(readFileSync(appFile(source, 'steps.json'), 'utf8'));
        video = appFile(source, 'walk.webm');
        if (!statSync(video).size) throw new Error('empty video');
      }
      if (!Array.isArray(raw) || !raw.length) throw new Error('walk has no steps');
      const ids = new Set();
      raw = raw.map(step => {
        if (!/^\d{2,}$/.test(step.step) || ids.has(step.step)) throw new Error('invalid or duplicate step');
        ids.add(step.step);
        const dom = appFile(source, `dom/${step.step}.txt`);
        const shot = appFile(source, step.screenshot);
        if (!statSync(shot).size || !Number.isFinite(step.videoOffsetSec) || step.videoOffsetSec < 0) throw new Error('invalid frame or timestamp');
        return { stepId: step.step, stageId: step.stageId, title: String(step.title ?? ''),
          tSec: step.videoOffsetSec, shot, text: readFileSync(dom, 'utf8') };
      });
    } else if (['.mp4', '.webm', '.mov'].includes(extname(source))) {
      video = source;
      const duration = probe(video);
      if (!duration) throw new Error('video duration unavailable');
      raw = [];
      for (let t = 1, n = 1; t < duration; t += SAMPLE_EVERY_SEC, n++) {
        raw.push({ stepId: String(n).padStart(2, '0'), title: `Video at ${t}s`, tSec: t, text: '' });
      }
    } else throw new Error('not a walk directory or video');
    if (!raw.length || raw.length > 200) throw new Error('walk step count outside limits');
    if (raw.some((step, i) => i > 0 && step.tSec < raw[i - 1].tSec)) throw new Error('walk timestamps out of order');
    const steps = withWindows(raw, probe(video)).map(step => {
      const images = [];
      if (step.shot) {
        const path = join(frameDir, `${step.stepId}-shot.png`);
        copyFileSync(step.shot, path);
        images.push(path);
      }
      const path = join(frameDir, `${step.stepId}-video.jpg`);
      const t = step.shot ? (step.tSec + Math.min(step.endSec, step.tSec + 20)) / 2 : step.tSec;
      if (extract(video, t, path)) images.push(path);
      else throw new Error('video frame extraction failed');
      const { shot, ...rest } = step;
      return { ...rest, images };
    });
    return { frameDir, steps, source, ...meta, subjectId: meta.walkSubject ?? null };
  } catch (error) {
    rmSync(frameDir, { recursive: true, force: true });
    throw error;
  }
}
