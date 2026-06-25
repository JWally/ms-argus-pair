import { readFileSync, writeFileSync } from 'node:fs';
import { attrsForPath, localAssetPaths, sriFor, withAttribute } from './build-sri-lib.mjs';

const distDir = new URL('../dist/', import.meta.url);
const htmlPath = new URL('index.html', distDir);
let html = readFileSync(htmlPath, 'utf8');

for (const path of localAssetPaths(distDir)) {
  const expected = sriFor(distDir, path);
  for (const tag of attrsForPath(html, path)) {
    const next = withAttribute(
      withAttribute(tag, 'integrity', expected),
      'crossorigin',
      'anonymous'
    );
    html = html.replace(tag, next);
  }
}

writeFileSync(htmlPath, html);
console.log('[build-sri] pinned local assets in dist/index.html');
