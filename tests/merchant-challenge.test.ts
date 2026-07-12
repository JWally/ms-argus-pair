import { describe, expect, it } from 'vitest';
import { parseMerchantChallenge } from '../cdk/lib/pair-api/merchant-challenge';

describe('merchant challenge binding', () => {
  it('accepts opaque URL-safe challenge identifiers', () => {
    expect(parseMerchantChallenge('checkout_1234567890abcdef')).toBe('checkout_1234567890abcdef');
    expect(parseMerchantChallenge('018f47d2-7a91-7b1d-8e7a-4f3c447ce901')).toBe(
      '018f47d2-7a91-7b1d-8e7a-4f3c447ce901'
    );
  });

  it('rejects missing, short, oversized, or unsafe values', () => {
    expect(parseMerchantChallenge(undefined)).toBeNull();
    expect(parseMerchantChallenge('too-short')).toBeNull();
    expect(parseMerchantChallenge('x'.repeat(129))).toBeNull();
    expect(parseMerchantChallenge('checkout id with spaces')).toBeNull();
  });
});
