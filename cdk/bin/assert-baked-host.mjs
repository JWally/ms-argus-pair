#!/usr/bin/env node
/**
 * Post-build assertion. Verifies that the canonical pair host string
 * (e.g. `captcha-dev-jw.argus.pw`) was inlined somewhere into the
 * Vite-emitted bundles. If it isn't, the runtime fallback to
 * `window.location.origin` will fire and the QR will point at
 * whichever alias domain the desktop was loaded from — a silent
 * data-flow bug that's bitten us twice.
 *
 * Run between `vite build` and `cdk deploy`. Exits non-zero on miss,
 * which short-circuits the && chain in package.json's deploy script
 * before anything ships.
 *
 * Usage: `node cdk/bin/assert-baked-host.mjs <expected-host>`
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const expected = process.argv[2];
if (!expected) {
  console.error('[assert-baked-host] missing argument: expected host');
  process.exit(2);
}

const assetDir = join(process.cwd(), 'dist', 'assets');
let found = false;
try {
  for (const f of readdirSync(assetDir)) {
    if (!f.endsWith('.js')) continue;
    const p = join(assetDir, f);
    if (!statSync(p).isFile()) continue;
    if (readFileSync(p, 'utf8').includes(expected)) {
      found = true;
      break;
    }
  }
} catch (e) {
  console.error(`[assert-baked-host] could not read ${assetDir}: ${e.message}`);
  process.exit(2);
}

if (!found) {
  console.error(
    `[assert-baked-host] FAIL — "${expected}" not found in dist/assets/*.js.\n` +
      'VITE_PAIR_URL_BASE was not baked into the bundle. The deployed QR\n' +
      'would fall back to window.location.origin (alias-leak risk).\n' +
      'Check that `source .env` worked and that VITE_PAIR_URL_BASE made\n' +
      'it through to the Vite child process.'
  );
  process.exit(1);
}

console.log(`[assert-baked-host] ok — "${expected}" is baked into the bundle`);
