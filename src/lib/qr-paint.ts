/*
 * Pure QR pixel painter (no React, no DOM) so the poison behavior is unit-testable
 * in Node. `QrCanvas` (qr.tsx) blits the buffer this returns; scripts/qr-poison.test
 * asserts a pixel-exact decode fails while a lens (blur) decode succeeds.
 *
 * The poison: each DATA module keeps its true bit in its average tone but gets a
 * small inverted square at its dead center. A camera's lens averages that center
 * away (reads the real code); a pixel-exact screenshot decoder samples the poisoned
 * center and fails ECC. Hybrid-image / spatial-frequency trick — a tier-1
 * defense-in-depth speed-bump, NOT the lock. See ms-argus-captcha/BLOG_1.md.
 */

import QRCode from 'qrcode-svg';

/** A QR module grid: `size`×`size` booleans plus a quiet-zone margin (in modules). */
export type QrMatrix = { size: number; modules: boolean[][]; quiet: number };

/**
 * Build the QR module grid for `content` (pure — no DOM/React, so it runs in the
 * QR worker). Only `content` + ecl affect the grid, so the scannable code is
 * identical to any encoder; we just expose the model for the poison pass.
 */
export function buildQrMatrix(content: string, quiet = 2): QrMatrix {
  const qr = new QRCode({ content, ecl: 'M' });
  return { size: qr.qrcode.moduleCount, modules: qr.qrcode.modules, quiet };
}

/**
 * Function modules (finders, separators, timing, single alignment of small
 * versions) carry the code's *structure* — a decoder needs them clean to locate
 * and grid the QR — so they are never poisoned. Covers QR versions 1–6 (the
 * pairing token is always a small payload).
 */
export function isFunctionModule(r: number, c: number, n: number): boolean {
  if (r < 9 && c < 9) return true; // top-left finder + separator + format strip
  if (r < 9 && c >= n - 8) return true; // top-right
  if (r >= n - 8 && c < 9) return true; // bottom-left
  if (r === 6 || c === 6) return true; // timing rows
  const a = n - 7;
  if (n >= 25 && Math.abs(r - a) <= 3 && Math.abs(c - a) <= 3) return true; // alignment
  return false;
}

/**
 * Paint the QR (+ optional poison) into an RGBA pixel buffer. Pure.
 * `poison` is the inverted center square's width as a fraction of a module
 * (~0.18 = validated sweet spot). `poison = 0` disables it. `scale` is backing
 * px per module — needs to be large enough to render the sub-module dot cleanly.
 */
// eslint-disable-next-line sonarjs/cognitive-complexity -- ratchet: legacy, currently 16; decompose, don't grow
export function paintQr(
  matrix: QrMatrix,
  { scale = 24, poison = 0.18 }: { scale?: number; poison?: number } = {}
): { data: Uint8ClampedArray; width: number; height: number } {
  const { size, modules, quiet } = matrix;
  const span = size + quiet * 2;
  const width = span * scale;
  const data = new Uint8ClampedArray(width * width * 4);

  const fillBlock = (mx: number, my: number, w: number, dark: boolean) => {
    const v = dark ? 0 : 255;
    for (let y = 0; y < w; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const i = ((my + y) * width + (mx + x)) * 4;
        data[i] = data[i + 1] = data[i + 2] = v;
        data[i + 3] = 255;
      }
    }
  };

  // white background
  fillBlock(0, 0, width, false);
  // dark modules
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      if (modules[r][c]) fillBlock((c + quiet) * scale, (r + quiet) * scale, scale, true);
    }
  }
  // poison pass: invert a centered square on every DATA module
  const dot = Math.round(Math.max(0, Math.min(1, poison)) * scale);
  if (dot > 0) {
    const off = Math.round((scale - dot) / 2);
    for (let r = 0; r < size; r += 1) {
      for (let c = 0; c < size; c += 1) {
        if (isFunctionModule(r, c, size)) continue;
        fillBlock((c + quiet) * scale + off, (r + quiet) * scale + off, dot, !modules[r][c]);
      }
    }
  }
  return { data, width, height: width };
}
