import { useEffect, useRef } from 'react';
import QRCode from 'qrcode-svg';

/**
 * QR rendering for the pairing flow.
 *
 * This lives in lib/ (not in a page) because it's core product behavior: the
 * secure way we put a pairing URL on screen. The matrix is the same QR any
 * encoder would produce; the point is that we paint it to a <canvas> (flat
 * pixels) rather than emitting an SVG <rect> grid into the DOM — so the URL is
 * not a coordinate list a scraper can read, only pixels a decoder must extract.
 */

/** A QR module grid: `size`×`size` booleans plus a quiet-zone margin (in modules). */
export type QrMatrix = { size: number; modules: boolean[][]; quiet: number };

/**
 * Build the QR module grid for `content`. Only `content` + ecl affect the grid,
 * so the scannable code is identical to the prior SVG render — we just expose
 * the model instead of a string of <rect>s.
 */
export function buildQrMatrix(content: string, quiet = 2): QrMatrix {
  const qr = new QRCode({ content, ecl: 'M' });
  return { size: qr.qrcode.moduleCount, modules: qr.qrcode.modules, quiet };
}

/**
 * Paints a QR module grid onto a <canvas>. A scraper can no longer read the URL
 * out of the markup — it has to capture pixels and run a QR decoder
 * (i.e. screenshot + extract). Same matrix, same encoded URL.
 */
export function QrCanvas({ matrix }: { matrix: QrMatrix }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const { size, modules, quiet } = matrix;
    const span = size + quiet * 2;
    const scale = 8; // backing px per module; CSS scales it to the slot
    canvas.width = span * scale;
    canvas.height = span * scale;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#000000';
    for (let r = 0; r < size; r += 1) {
      for (let c = 0; c < size; c += 1) {
        if (modules[r][c]) ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
      }
    }
  }, [matrix]);
  return <canvas ref={ref} />;
}
