import { describe, expect, it } from 'vitest';
import {
  buildRaffleBuckets,
  desktopSiteHost,
  handleHash,
  hashToCode,
  normalizeHandle,
} from '../cdk/lib/pair-api/raffle-claims.ts';

const rateLimitInput = {
  phonePub: 'phone-pub',
  desktopPub: 'desktop-pub',
  desktopUa: 'desktop-ua',
  desktopIp: '203.0.113.10',
  phoneUa: 'phone-ua',
  phoneIp: '198.51.100.20',
  authIdentity: null,
  siteHost: 'captcha-dev-jw.argus.pw',
};

describe('raffle claim helpers', () => {
  it('normalizes allowed handles and rejects invalid ones', () => {
    expect(normalizeHandle('  Alice.Example@Email  ')).toBe('alice.example@email');
    expect(normalizeHandle('ab')).toBeNull();
    expect(normalizeHandle('bad handle')).toBeNull();
    expect(normalizeHandle(42)).toBeNull();
  });

  it('uses the persisted hash prefix as the public code', () => {
    const { hash, code } = handleHash('alice');

    expect(code).toMatch(/^[0-9a-f]{4}-[0-9a-f]{4}$/);
    expect(hashToCode(hash)).toBe(code);
  });

  it('reads the validated desktop site host from Origin', () => {
    expect(desktopSiteHost({ headers: { origin: 'https://QR.Arcades.Click/demo' } })).toBe(
      'qr.arcades.click'
    );
    expect(desktopSiteHost({ headers: { Origin: 'not a url' } })).toBe('unknown');
  });

  it('builds one bucket per stable rate-limit axis plus optional auth identity', () => {
    expect(buildRaffleBuckets(rateLimitInput).buckets).toHaveLength(4);
    expect(
      buildRaffleBuckets({ ...rateLimitInput, authIdentity: 'sso-device:key-1' }).buckets
    ).toHaveLength(5);
  });
});
