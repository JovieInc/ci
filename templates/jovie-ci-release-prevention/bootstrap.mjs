#!/usr/bin/env node
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== '--target' || args[2] !== '--ci-ref' || !/^[a-f0-9]{40}$/.test(args[3])) {
  throw new Error('usage: node bootstrap.mjs --target /path/to/project --ci-ref <reviewed-full-commit-sha>');
}
const target = resolve(args[1]);
const ref = args[3];
const files = ['.github/workflows/ci-release-prevention.yml', '.github/ci-release-prevention.json',
  'scripts/verify-ci-release-incidents.mjs', 'ci-release/incidents.json',
  'docs/operations/ci-release-prevention.md', 'docs/postmortems/index.md',
  'docs/postmortems/ci-release-prevention-bootstrap.md'];

async function ensureSafePath(path, leaf = false) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || (!leaf && !info.isDirectory())) throw new Error(`unsafe destination ${path}`);
    if (leaf) throw new Error(`refusing to overwrite existing ${path}`);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
// Reject existing files and symlink parents before writing any scaffold file.
for (const file of files) {
  const destination = join(target, file);
  await ensureSafePath(destination, true);
  for (let parent = dirname(destination); ; parent = dirname(parent)) {
    await ensureSafePath(parent);
    if (parent === dirname(parent)) break;
  }
}
for (const file of files) {
  const destination = join(target, file);
  await mkdir(dirname(destination), { recursive: true });
  for (let parent = dirname(destination); ; parent = dirname(parent)) {
    await ensureSafePath(parent);
    if (parent === dirname(parent)) break;
  }
  const contents = (await readFile(join(import.meta.dirname, 'skeleton', file), 'utf8')).replaceAll('__CI_COMMIT__', ref);
  await writeFile(destination, contents, { flag: 'wx' });
}
console.log(`Installed incident metadata scaffold pinned to ${ref} in ${target}`);
