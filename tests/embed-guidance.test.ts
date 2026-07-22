import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { getEmbedPresentation, SCAN_HINT_DELAY_MS } from '../src/lib/embed-presentation.ts';

// eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed repository fixtures.
const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

describe('captcha embed guidance', () => {
  it('starts with a concrete camera instruction and delays troubleshooting help', () => {
    expect(SCAN_HINT_DELAY_MS).toBe(7_000);
    expect(
      getEmbedPresentation({ connected: false, completion: null, showScanHint: false })
    ).toEqual({
      phase: 'scanning',
      title: 'Scan with your phone',
      instruction: "Open your phone's camera and point it at the code.",
      trackStatus: 'WAITING FOR PHONE',
    });
    expect(
      getEmbedPresentation({ connected: false, completion: null, showScanHint: true }).instruction
    ).toBe('Having trouble? Move your phone slightly farther away.');
  });

  it.each([
    [true, null, 'pairing', 'Phone connected', 'Finishing check...', 'PHONE CONNECTED'],
    [false, 'paired', 'verified', 'Verified', "You're all set", 'CHECK COMPLETE'],
    [false, 'failed', 'failed', "Couldn't verify", 'Try again on a trusted network', 'CHECK ENDED'],
  ] as const)(
    'describes connected=%s completion=%s as %s',
    (connected, completion, phase, title, instruction, trackStatus) => {
      expect(getEmbedPresentation({ connected, completion, showScanHint: false })).toEqual({
        phase,
        title,
        instruction,
        trackStatus,
      });
    }
  );

  it('keeps the track status visible in the embed stylesheet', async () => {
    const css = await read('src/pages/embed.css');

    expect(css).toContain('.aegis .ax-track-label');
  });
});
