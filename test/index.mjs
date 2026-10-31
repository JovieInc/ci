// Node versions that resolve `node --test test/` as a module need an entry point.
// Discover every real test; do not silently omit future subdirectories.
import { readdirSync } from 'node:fs';

async function discover(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
    if (entry.isDirectory()) await discover(url);
    else if (entry.name.endsWith('.test.mjs')) await import(url.href);
  }
}
await discover(new URL('./', import.meta.url));
