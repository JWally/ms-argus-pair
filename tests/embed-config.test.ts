import { describe, expect, it } from 'vitest';
import { readEmbedConfig, readEmbedViewportWidth } from '../src/lib/embed-config';

describe('embed URL configuration', () => {
  it.each(['fastpass', 'stepup', 'forceauth'])('accepts a scoped %s CPI', (scope) => {
    const cpi = `argus_cpi_live_AbCdEf012345.${scope}`;
    const search = new URLSearchParams({
      origin: 'https://merchant.example',
      cpi,
      challengeId: 'merchant-challenge_1234',
    });

    expect(readEmbedConfig(`?${search.toString()}`)).toEqual({
      hostOrigin: 'https://merchant.example',
      cpi,
      challengeId: 'merchant-challenge_1234',
    });
  });

  it('keeps the unframed development origin fallback', () => {
    expect(readEmbedConfig('')).toEqual({
      hostOrigin: '*',
      cpi: undefined,
      challengeId: undefined,
    });
  });

  it.each([
    ['wrong prefix', 'merchant_cpi_live_AbCdEf012345'],
    ['unknown environment', 'argus_cpi_prod_AbCdEf012345'],
    ['short identifier', 'argus_cpi_test_short'],
    ['unknown scope', 'argus_cpi_live_AbCdEf012345.legacy'],
    ['trailing text', 'argus_cpi_live_AbCdEf012345.stepup.extra'],
  ])('does not forward a CPI with %s', (_name, cpi) => {
    expect(readEmbedConfig(`?cpi=${encodeURIComponent(cpi)}`).cpi).toBeUndefined();
  });

  it.each(['short', 'contains spaces 1234', 'punctuation!not-allowed'])(
    'does not forward the malformed challenge %s',
    (challengeId) => {
      expect(
        readEmbedConfig(`?challengeId=${encodeURIComponent(challengeId)}`).challengeId
      ).toBeUndefined();
    }
  );
});

describe('embed viewport messages', () => {
  const parentWindow = {};

  it('accepts a viewport width only from the configured parent origin and window', () => {
    expect(
      readEmbedViewportWidth(
        {
          source: parentWindow,
          origin: 'https://merchant.example',
          data: { source: 'argus-captcha-host', event: 'viewport', width: 639 },
        },
        parentWindow,
        'https://merchant.example'
      )
    ).toBe(639);
  });

  it.each([
    ['wrong source window', {}, 'https://merchant.example'],
    ['wrong source origin', parentWindow, 'https://evil.example'],
  ])('rejects a viewport message from the %s', (_name, source, origin) => {
    expect(
      readEmbedViewportWidth(
        {
          source,
          origin,
          data: { source: 'argus-captcha-host', event: 'viewport', width: 639 },
        },
        parentWindow,
        'https://merchant.example'
      )
    ).toBeNull();
  });

  it.each([
    null,
    [],
    { source: 'other-widget', event: 'viewport', width: 639 },
    { source: 'argus-captcha-host', event: 'other-event', width: 639 },
    { source: 'argus-captcha-host', event: 'viewport', width: '639' },
  ])('rejects malformed viewport payload %#', (data) => {
    expect(
      readEmbedViewportWidth(
        { source: parentWindow, origin: 'https://merchant.example', data },
        parentWindow,
        'https://merchant.example'
      )
    ).toBeNull();
  });

  it('allows the explicit unframed development origin fallback', () => {
    expect(
      readEmbedViewportWidth(
        {
          source: parentWindow,
          origin: 'http://localhost:5173',
          data: { source: 'argus-captcha-host', event: 'viewport', width: 800 },
        },
        parentWindow,
        '*'
      )
    ).toBe(800);
  });
});
