/*
 * Build the embeddable captcha loader to a minified IIFE + publish its SRI hash.
 * This is a SEPARATE build artifact from the Vite pairing app — it's a tiny
 * <script src> customers drop on their page, served from its own CDN
 * (static-captcha[-stage].argus.pw) with independent caching + SRI.
 *
 *   EMBED_ORIGIN=https://captcha-dev-jw.argus.pw node scripts/build-loader.mjs
 *
 * Outputs (loader/dist/, gitignored):
 *   captcha.js         — the loader customers <script src>
 *   captcha-sri.json   — { "captcha.js": "sha384-...", embedOrigin, bytes }
 *   index.html         — the demo/landing host page
 *
 * The embed origin (the pairing app that serves /embed — i.e. this very repo's
 * site) is baked in here, since the loader is served from a separate CDN and
 * can't infer it from its own URL.
 */
import * as esbuild from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const loaderDir = path.join(root, 'loader');
const distDir = path.join(loaderDir, 'dist');

const EMBED_ORIGIN = process.env.EMBED_ORIGIN || 'https://captcha-dev-jw.argus.pw';

mkdirSync(distDir, { recursive: true });

await esbuild.build({
  entryPoints: [path.join(loaderDir, 'loader.ts')],
  bundle: true,
  format: 'iife',
  minify: true,
  target: ['es2019'],
  outfile: path.join(distDir, 'captcha.js'),
  define: { __EMBED_ORIGIN__: JSON.stringify(EMBED_ORIGIN) },
  legalComments: 'none',
});

const bytes = readFileSync(path.join(distDir, 'captcha.js'));
const sri = 'sha384-' + createHash('sha384').update(bytes).digest('base64');
writeFileSync(
  path.join(distDir, 'captcha-sri.json'),
  JSON.stringify({ 'captcha.js': sri, embedOrigin: EMBED_ORIGIN, bytes: bytes.length }, null, 2) +
    '\n'
);

copyFileSync(path.join(loaderDir, 'captcha-demo.html'), path.join(distDir, 'index.html'));

console.log(`built loader/dist/captcha.js  ${bytes.length} bytes`);
console.log(`embed origin: ${EMBED_ORIGIN}`);
console.log(`SRI: ${sri}`);
