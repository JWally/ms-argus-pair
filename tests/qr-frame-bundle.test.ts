import { describe, expect, it } from 'vitest';
import { packQrFrameBundle, unpackQrFrameBundle } from '../src/lib/qr-frame-bundle.ts';

describe('QR frame bundle', () => {
  it('packs and unpacks binary PNG frame bytes without stringifying them', () => {
    const frames = [new Uint8Array([137, 80, 78, 71, 1]), new Uint8Array([137, 80, 78, 71, 2, 3])];

    const packed = packQrFrameBundle({ frameMs: 180, frames });
    const unpacked = unpackQrFrameBundle(packed);

    expect(unpacked.frameMs).toBe(180);
    expect(unpacked.frames.map((frame) => Array.from(frame))).toEqual(
      frames.map((frame) => Array.from(frame))
    );
  });

  it('rejects truncated bundles', () => {
    const packed = packQrFrameBundle({ frameMs: 180, frames: [new Uint8Array([1, 2, 3])] });

    expect(() => unpackQrFrameBundle(packed.slice(0, -1))).toThrow(/truncated/);
  });
});
