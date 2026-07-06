import { describe, expect, it } from 'vitest';
import {
  hashSsoReturnCode,
  requirePhoneSsoScan,
  ssoProfileFromScan,
} from '../cdk/lib/pair-api/sso-scan.ts';
import type { AttestationInput } from '../cdk/lib/pair-api/attestation/envelope.ts';

const attestation: AttestationInput = {
  envelope: 'env',
  signature: 'sig',
  publicKey: 'pub',
  keyId: 'key-1',
};

describe('sso scan helpers', () => {
  it('builds SSO leg profiles from classified scans', () => {
    expect(
      ssoProfileFromScan('argus-1', attestation, {
        ip: '203.0.113.1',
        asnName: 'Example ASN',
        country: 'US',
        city: 'Dallas',
        individualScore: 7,
        isPhone: true,
        isProxy: false,
        isDatacenter: false,
        isVpn: false,
        signals: [],
        tags: [],
      })
    ).toMatchObject({
      argusSessionId: 'argus-1',
      keyId: 'key-1',
      isPhone: true,
      score: 7,
    });
  });

  it('rejects non-phone SSO scans with the stable API error', () => {
    const result = requirePhoneSsoScan(null, 'challenge');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.statusCode).toBe(403);
      expect(JSON.parse(result.response.body)).toMatchObject({
        error: 'sso_requires_phone',
        leg: 'challenge',
      });
    }
  });

  it('hashes return codes deterministically without returning the raw code', () => {
    const hash = hashSsoReturnCode('123456');

    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).toBe(hashSsoReturnCode('123456'));
    expect(hash).not.toContain('123456');
  });
});
