import { readFileSync } from 'node:fs';
import { attrsForPath, fail, localAssetPaths, sriFor } from './build-sri-lib.mjs';

const distDir = new URL('../dist/', import.meta.url);
const htmlPath = new URL('index.html', distDir);
const html = readFileSync(htmlPath, 'utf8');

for (const path of localAssetPaths(distDir)) {
  const tags = attrsForPath(html, path);
  if (tags.length === 0) {
    fail(`${path} is emitted but not pinned from index.html`);
    continue;
  }
  const expected = sriFor(distDir, path);
  for (const tag of tags) {
    if (!tag.includes(`integrity="${expected}"`)) {
      fail(`${path} tag is missing expected ${expected}`);
    }
    if (!/\bcrossorigin(?:=["']anonymous["'])?/i.test(tag)) {
      fail(`${path} tag is missing crossorigin`);
    }
  }
}

for (const path of localAssetPaths(distDir).filter((path) => path.endsWith('.js'))) {
  const body = readFileSync(new URL(path.replace(/^\//, ''), distDir), 'utf8');
  if (/\bmode:\s*["']none["']/.test(body) || body.includes('proof_skipped')) {
    fail(`${path} still contains the production proof-skip path`);
  }
}

if (process.exitCode) process.exit(process.exitCode);
console.log('[build-hygiene] ok');
