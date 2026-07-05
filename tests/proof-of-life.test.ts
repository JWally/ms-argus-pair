import { describe, expect, it } from 'vitest';
import { verifyWebAuthnProof } from '../cdk/lib/pair-api/proof-of-life.ts';
import type { PasskeyStore } from '../cdk/lib/pair-api/passkey-store.ts';

const passkeyStore: PasskeyStore = {
  async load() {
    return null;
  },
  async save() {
    throw new Error('save should not be called');
  },
};

function verify(webauthn: unknown) {
  return verifyWebAuthnProof({
    webauthn,
    expectedNonce: 'nonce',
    argusPubkey: 'argus-pubkey',
    rpId: 'captcha-dev-jw.argus.pw',
    expectedOrigin: 'https://captcha-dev-jw.argus.pw',
    allowTestAuthenticators: false,
    passkeyStore,
  });
}

describe('verifyWebAuthnProof', () => {
  it('reports missing proof material', async () => {
    await expect(verify(null)).resolves.toEqual({
      phone_webauthn_attested: false,
      phone_webauthn_error: 'missing',
    });
  });

  it('propagates client-side WebAuthn errors', async () => {
    await expect(verify({ error: 'not_allowed' })).resolves.toEqual({
      phone_webauthn_attested: false,
      phone_webauthn_error: 'not_allowed',
    });
  });

  it('rejects authentication assertions for unknown stored credentials', async () => {
    await expect(
      verify({
        id: 'missing-credential',
        response: {
          signature: 'signature',
          authenticatorData: 'authenticator-data',
        },
      })
    ).resolves.toEqual({
      phone_webauthn_attested: false,
      phone_webauthn_error: 'credential_not_registered',
    });
  });
});
