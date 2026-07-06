import { describe, expect, it } from 'vitest';
import { splitCredential } from '../cdk/lib/pair-api/projection-client.ts';

describe('splitCredential', () => {
  it('splits key id and token on the first separator', () => {
    expect(splitCredential('key.token.with.dots')).toEqual({
      keyId: 'key',
      token: 'token.with.dots',
    });
  });

  it('rejects credentials without a key id separator', () => {
    expect(() => splitCredential('token-only')).toThrow(/missing keyId\.token separator/);
  });
});
