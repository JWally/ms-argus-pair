import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
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

it('gives the captcha embed a dedicated timeout presentation', async () => {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed repository fixture.
  const embed = await readFile(new URL('../src/pages/Embed.tsx', import.meta.url), 'utf8');

  expect(embed).toContain('timeout: { title: "Didn\'t connect in time"');
  expect(embed).toContain('const SealTimeout');
  expect(embed).toMatch(/phase === 'timeout'\s*\?\s*\(\s*<SealTimeout \/>/);
});
