import { readFileSync, readdirSync } from 'node:fs';
import { attrsForPath, fail, localAssetPaths, sriFor } from './build-sri-lib.mjs';

const distDir = new URL('../dist/', import.meta.url);
const htmlFiles = readdirSync(distDir).filter((name) => name.endsWith('.html'));
const htmlByName = new Map(
  htmlFiles.map((name) => [name, readFileSync(new URL(name, distDir), 'utf8')])
);

for (const path of localAssetPaths(distDir)) {
  const tags = [...htmlByName.values()].flatMap((html) => attrsForPath(html, path));
  if (tags.length === 0) {
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

for (const requiredHtml of ['index.html', 'phone.html']) {
  const html = htmlByName.get(requiredHtml);
  if (!html) {
    fail(`${requiredHtml} is missing from dist`);
    continue;
  }
  const localTags = [...html.matchAll(/<(?:script|link)\b[^>]*(?:src|href)=["']\/assets\/[^"']+["'][^>]*>/g)].map(
    (match) => match[0]
  );
  if (localTags.length === 0) fail(`${requiredHtml} does not reference local built assets`);
  for (const tag of localTags) {
    if (!/\sintegrity=["']sha384-/i.test(tag)) {
      fail(`${requiredHtml} has an unpinned local asset tag: ${tag}`);
    }
    if (!/\bcrossorigin(?:=["']anonymous["'])?/i.test(tag)) {
      fail(`${requiredHtml} local asset tag is missing crossorigin: ${tag}`);
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
