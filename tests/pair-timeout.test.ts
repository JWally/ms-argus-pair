import { describe, expect, it } from 'vitest';
import { getEmbedPresentation } from '../src/lib/embed-presentation.ts';
import { isPairSessionTimeout } from '../src/lib/pair-timeout';

describe('isPairSessionTimeout', () => {
  it.each(['session expired', "desktop didn't finish scanning in time"])(
    'recognizes the routine timeout message: %s',
    (message) => {
      expect(isPairSessionTimeout(new Error(message))).toBe(true);
    }
  );

  it('does not relabel a verification failure as a timeout', () => {
    expect(isPairSessionTimeout(new Error('desktop_score_high'))).toBe(false);
  });
});

it('gives the captcha embed a dedicated timeout presentation', () => {
  expect(
    getEmbedPresentation({ connected: false, completion: 'timeout', showScanHint: false })
  ).toEqual({
    phase: 'timeout',
    title: "Didn't connect in time",
    instruction: 'Refresh to try again',
    trackStatus: 'CONNECTION TIMED OUT',
  });
});
