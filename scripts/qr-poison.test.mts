#!/usr/bin/env tsx
/*
 * Spec for the QR poison (src/lib/qr-paint.ts). The poison must:
 *   1. block a PIXEL-EXACT screenshot decoder (bot) at the default dose,
 *   2. still decode THROUGH A LENS (blur) — i.e. a real phone reads it,
 *   3. leave FUNCTION modules (finders/timing) untouched (locatability),
 *   4. produce a plain, decodable QR when poison is disabled.
 * Uses the real paintQr + a vendored jsQR; run via tsx in test:hygiene → deploy gate.
 */
import { createRequire } from 'node:module';
import { paintQr, isFunctionModule, type QrMatrix } from '../src/lib/qr-paint';

const require = createRequire(import.meta.url);
const jsQR = require('./jsQR.js') as (
  d: Uint8ClampedArray,
  w: number,
  h: number,
  o?: { inversionAttempts?: string }
) => { data: string } | null;
const QRCode = require('qrcode-svg') as new (o: { content: string; ecl: string }) => {
  qrcode: { moduleCount: number; modules: boolean[][] };
};

const URL = 'https://captcha-dev-jw.argus.pw/j/9fK2xQ7bZ';
function matrixFor(content: string): QrMatrix {
  const qr = new QRCode({ content, ecl: 'M' });
  return { size: qr.qrcode.moduleCount, modules: qr.qrcode.modules, quiet: 2 };
}
function decode(buf: { data: Uint8ClampedArray; width: number }): string | null {
  const r = jsQR(buf.data, buf.width, buf.width, { inversionAttempts: 'attemptBoth' });
  return r ? r.data : null;
}
/** separable box blur on luminance — models the camera lens low-pass */
function blur(buf: { data: Uint8ClampedArray; width: number }, k: number) {
  const { data, width: w } = buf;
  const lum = new Float64Array(w * w);
  for (let i = 0; i < w * w; i += 1) lum[i] = data[i * 4];
  const tmp = new Float64Array(w * w);
  const norm = 2 * k + 1;
  const clamp = (v: number) => Math.min(w - 1, Math.max(0, v));
  for (let y = 0; y < w; y += 1)
    for (let x = 0; x < w; x += 1) {
      let s = 0;
      for (let d = -k; d <= k; d += 1) s += lum[y * w + clamp(x + d)];
      tmp[y * w + x] = s / norm;
    }
  const out = new Uint8ClampedArray(w * w * 4);
  for (let x = 0; x < w; x += 1)
    for (let y = 0; y < w; y += 1) {
      let s = 0;
      for (let d = -k; d <= k; d += 1) s += tmp[clamp(y + d) * w + x];
      const v = s / norm;
      const i = (y * w + x) * 4;
      out[i] = out[i + 1] = out[i + 2] = v;
      out[i + 3] = 255;
    }
  return { data: out, width: w };
}

let failed = 0;
const assert = (cond: unknown, msg: string) => {
  if (cond) {
    console.log(`  ✓ ${msg}`);
  } else {
    console.error(`  ✗ ${msg}`);
    failed += 1;
  }
};

const matrix = matrixFor(URL);
console.log(`qr-poison: QR ${matrix.size}×${matrix.size}, default dose (poison=0.18)`);

// 1. pixel-exact screenshot decoder is BLOCKED (wrong or no decode)
const poisoned = paintQr(matrix, { poison: 0.18 });
assert(decode(poisoned) !== URL, 'pixel-exact screenshot does NOT decode the URL (bot blocked)');

// 2. through a lens (blur ~= module/3) it DOES decode (phone reads)
const scale = 24; // must match paintQr default
assert(
  decode(blur(poisoned, Math.round(scale * 0.35))) === URL,
  'through-a-lens (blur) decodes the URL (phone reads)'
);

// 3. function modules are untouched — finder at (0,0) center pixel keeps its bit
{
  const { data, width } = poisoned;
  const q = matrix.quiet;
  const px = (0 + q) * scale + Math.floor(scale / 2);
  const py = (0 + q) * scale + Math.floor(scale / 2);
  const centerDark = data[(py * width + px) * 4] < 128;
  assert(isFunctionModule(0, 0, matrix.size), 'sanity: (0,0) is a function (finder) module');
  assert(
    centerDark === matrix.modules[0][0],
    'finder module center is NOT poisoned (keeps its bit)'
  );
}

// 4. poison disabled → plain, decodable QR
assert(decode(paintQr(matrix, { poison: 0 })) === URL, 'poison=0 renders a plain QR that decodes');

if (failed) {
  console.error(`qr-poison: ${failed} assertion(s) failed`);
  process.exitCode = 1;
} else {
  console.log('qr-poison: all assertions passed');
}
