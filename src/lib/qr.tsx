import { useEffect, useRef } from 'react';
import QRCode from 'qrcode-svg';
import { paintQr, type QrMatrix } from './qr-paint';

/**
 * QR rendering for the pairing flow.
 *
 * This lives in lib/ (not in a page) because it's core product behavior: the
 * secure way we put a pairing token on screen. We paint it to a <canvas> (flat
 * pixels) rather than an SVG <rect> grid — so the URL is not a coordinate list a
 * scraper can read, only pixels a decoder must extract — and we apply the
 * spatial-frequency **poison** (see qr-paint.ts) so a pixel-exact screenshot
 * decoder fails while a phone's lens reads it. Speed-bump, not the lock; the
 * single-use/TTL token is the wall.
 */

export type { QrMatrix } from './qr-paint';

/**
 * Build the QR module grid for `content`. Only `content` + ecl affect the grid,
 * so the scannable code is identical to any encoder — we just expose the model.
 */
export function buildQrMatrix(content: string, quiet = 2): QrMatrix {
  const qr = new QRCode({ content, ecl: 'M' });
  return { size: qr.qrcode.moduleCount, modules: qr.qrcode.modules, quiet };
}

/**
 * Paints a QR module grid onto a <canvas> with the poison pass (see qr-paint.ts).
 * `poison` is the inverted-center width as a fraction of a module (default 0.18,
 * the validated sweet spot); `poison={0}` renders a plain QR.
 */
export function QrCanvas({ matrix, poison = 0.18 }: { matrix: QrMatrix; poison?: number }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const { data, width } = paintQr(matrix, { poison });
    canvas.width = width;
    canvas.height = width;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const img = ctx.createImageData(width, width);
    img.data.set(data);
    ctx.putImageData(img, 0, 0);
  }, [matrix, poison]);
  // Crisp pixels: the poison must reach the screen sharp (a bot's screenshot gets
  // the poisoned centers); the phone's lens supplies the blur that recovers it.
  return <canvas ref={ref} style={{ imageRendering: 'pixelated' }} />;
}
