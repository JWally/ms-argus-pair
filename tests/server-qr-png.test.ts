import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import {
  renderPairTokenPngFrames,
  renderPairTokenPng,
  SERVER_QR_FRAME_MS,
  SERVER_QR_FRAME_WRONG_RATES,
  SERVER_QR_QUIET_MODULES,
  SERVER_QR_SCALE,
} from '../cdk/lib/pair-api/server-qr-png.ts';

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

describe('server QR PNG renderer', () => {
  it('renders a real PNG using the current QR geometry', async () => {
    const out = await renderPairTokenPng(
      'https://captcha-dev-jw.argus.pw',
      '0DJ06tuZ5eEzdLcJJRWWwg'
    );
    const parsed = PNG.sync.read(Buffer.from(out.png));

    expect(Array.from(out.png.slice(0, PNG_SIGNATURE.length))).toEqual(PNG_SIGNATURE);
    expect(parsed.width).toBe(out.width);
    expect(parsed.height).toBe(out.width);
    expect(out.width % SERVER_QR_SCALE).toBe(0);
    expect(out.width / SERVER_QR_SCALE).toBeGreaterThan(2 * SERVER_QR_QUIET_MODULES);
  });

  it('keeps the redeem URL inside the PNG image, not as plaintext transport bytes', async () => {
    const token = '0DJ06tuZ5eEzdLcJJRWWwg';
    const out = await renderPairTokenPng('https://captcha-dev-jw.argus.pw', token);

    expect(Buffer.from(out.png).includes(Buffer.from(token))).toBe(false);
    expect(Buffer.from(out.png).includes(Buffer.from('/p/'))).toBe(false);
  });

  it('accepts a phone-entry suffix without mutating the public origin', async () => {
    const out = await renderPairTokenPng(
      'https://captcha-dev-jw.argus.pw',
      '0DJ06tuZ5eEzdLcJJRWWwg',
      '?debug=true'
    );
    const parsed = PNG.sync.read(Buffer.from(out.png));

    expect(parsed.width).toBe(out.width);
  });

  it('renders an animated frame sweep for the same token URL', async () => {
    const token = '0DJ06tuZ5eEzdLcJJRWWwg';
    const out = await renderPairTokenPngFrames('https://captcha-dev-jw.argus.pw', token);

    expect(out.frameMs).toBe(SERVER_QR_FRAME_MS);
    expect(out.frames).toHaveLength(SERVER_QR_FRAME_WRONG_RATES.length);
    for (const frame of out.frames) {
      const parsed = PNG.sync.read(Buffer.from(frame));
      expect(Array.from(frame.slice(0, PNG_SIGNATURE.length))).toEqual(PNG_SIGNATURE);
      expect(parsed.width).toBe(out.width);
      expect(Buffer.from(frame).includes(Buffer.from(token))).toBe(false);
      expect(Buffer.from(frame).includes(Buffer.from('/p/'))).toBe(false);
    }
  }, 20_000);
});
