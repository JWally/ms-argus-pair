import { describe, expect, it } from 'vitest';
import {
  isProofOfLifeSatisfied,
  verifyProofOfLife,
  verifyWebAuthnProof,
} from '../cdk/lib/pair-api/proof-of-life.ts';
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

function verifySelectedProof(input: {
  webauthn?: unknown;
  oauth?: unknown;
  trustRedeemed?: boolean;
}) {
  return verifyProofOfLife({
    webauthn: input.webauthn,
    oauth: input.oauth,
    expectedNonce: 'nonce',
    argusPubkey: 'argus-pubkey',
    rpId: 'captcha-dev-jw.argus.pw',
    expectedOrigin: 'https://captcha-dev-jw.argus.pw',
    allowTestAuthenticators: false,
    passkeyStore,
    trustRedeemed: input.trustRedeemed === true,
    deviceTrustFormat: 'device_trust_redeem',
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

describe('verifyProofOfLife', () => {
  it('uses device-trust redemption before OAuth or WebAuthn', async () => {
    const proof = await verifySelectedProof({
      trustRedeemed: true,
      oauth: { provider: 'google' },
      webauthn: null,
    });

    expect(proof).toEqual({
      phone_webauthn_attested: true,
      phone_webauthn_user_verified: true,
      phone_webauthn_format: 'device_trust_redeem',
    });
    expect(isProofOfLifeSatisfied(proof)).toBe(true);
  });

  it('treats present but malformed OAuth as an OAuth proof failure', async () => {
    const proof = await verifySelectedProof({ oauth: { provider: 'google' } });

    expect(proof).toEqual({
      phone_webauthn_attested: false,
      phone_oauth_error: 'missing_or_malformed',
    });
    expect(isProofOfLifeSatisfied(proof)).toBe(false);
  });

  it('rejects retired OAuth providers before provider verification', async () => {
    const proof = await verifySelectedProof({
      oauth: { provider: 'github', token: 'unused-access-token' },
    });

    expect(proof).toEqual({
      phone_webauthn_attested: false,
      phone_oauth_error: 'missing_or_malformed',
    });
  });

  it('falls back to WebAuthn when no OAuth or device-trust proof is present', async () => {
    const proof = await verifySelectedProof({ webauthn: null });

    expect(proof).toEqual({
      phone_webauthn_attested: false,
      phone_webauthn_error: 'missing',
    });
  });
});
