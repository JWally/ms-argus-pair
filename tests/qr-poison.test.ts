/*
 * Spec for the QR poison (src/lib/qr-paint.ts). The poison must:
 *   1. block a PIXEL-EXACT screenshot decoder (bot) at the default dose,
 *   2. still decode THROUGH A LENS (blur) — i.e. a real phone reads it,
 *   3. leave FUNCTION modules (finders/timing) untouched (locatability),
 *   4. produce a plain, decodable QR when poison is disabled.
 */
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { paintQr, isFunctionModule, type QrMatrix } from '../src/lib/qr-paint';

const require = createRequire(import.meta.url);
const jsqrModule = require('jsqr') as { default?: unknown };
const jsQR = (jsqrModule.default ?? jsqrModule) as (
  d: Uint8ClampedArray,
  w: number,
  h: number,
  o?: { inversionAttempts?: string }
) => { data: string } | null;
const QRCode = require('qrcode-svg') as new (o: { content: string; ecl: string }) => {
  qrcode: { moduleCount: number; modules: boolean[][] };
};

const PAIR_URL = 'https://captcha-dev-jw.argus.pw/j/9fK2xQ7bZ';
const SCALE = 24; // must match paintQr default

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

const matrix = matrixFor(PAIR_URL);
const poisoned = paintQr(matrix, { poison: 0.18 });

describe(`qr poison (QR ${matrix.size}×${matrix.size}, poison=0.18)`, () => {
  it('pixel-exact screenshot does NOT decode the URL (bot blocked)', () => {
    expect(decode(poisoned)).not.toBe(PAIR_URL);
  });

  it('through-a-lens (blur) decodes the URL (phone reads)', () => {
    expect(decode(blur(poisoned, Math.round(SCALE * 0.35)))).toBe(PAIR_URL);
  });

  it('finder module center is NOT poisoned (keeps its bit)', () => {
    const { data, width } = poisoned;
    const q = matrix.quiet;
    const px = q * SCALE + Math.floor(SCALE / 2);
    const py = q * SCALE + Math.floor(SCALE / 2);
    const centerDark = data[(py * width + px) * 4] < 128;
    expect(isFunctionModule(0, 0, matrix.size)).toBe(true);
    expect(centerDark).toBe(matrix.modules[0][0]);
  });

  it('poison=0 renders a plain QR that decodes', () => {
    expect(decode(paintQr(matrix, { poison: 0 }))).toBe(PAIR_URL);
  });
});
