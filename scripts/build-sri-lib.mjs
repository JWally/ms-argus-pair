import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';

export function fail(message) {
  console.error(`[build-hygiene] ${message}`);
  process.exitCode = 1;
}

export function sriFor(distDir, path) {
  const bytes = readFileSync(new URL(path.replace(/^\//, ''), distDir));
  return `sha384-${createHash('sha384').update(bytes).digest('base64')}`;
}

export function localAssetPaths(distDir) {
  const assetsDir = new URL('assets/', distDir);
  return readdirSync(assetsDir)
    .filter((name) => name.endsWith('.js') || name.endsWith('.css'))
    .map((name) => `/assets/${name}`)
    .sort();
}

export function attrsForPath(html, path) {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<(?:script|link)\\b[^>]*(?:src|href)=["']${escaped}["'][^>]*>`, 'g');
  return [...html.matchAll(re)].map((match) => match[0]);
}

export function withAttribute(tag, name, value) {
  const attr = new RegExp(`\\s${name}(?:=(["']).*?\\1)?`, 'i');
  const next = tag.replace(attr, '');
  return next.replace(/>$/, ` ${name}="${value}">`);
}
