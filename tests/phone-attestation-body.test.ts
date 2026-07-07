import { describe, expect, it } from 'vitest';
import {
  buildProofAttestationBody,
  buildTrustRedeemAttestationBody,
  createdCredentialIdFromProof,
} from '../src/lib/phone-attestation-body.ts';

const run = {
  argusSessionId: 'phone-argus-session',
  attestation: { keyId: 'phone-key', envelope: 'signed-envelope' },
};

const bindings = {
  desktopEnvelope: 'desktop-envelope',
  desktopArgusSessionId: 'desktop-argus-session',
  desktopKeyId: 'desktop-key',
};

describe('phone attestation body builders', () => {
  it('builds the silent device-trust redemption body with desktop cross-bindings', () => {
    expect(buildTrustRedeemAttestationBody(run, bindings, 'trust-token')).toEqual({
      argusSessionId: 'phone-argus-session',
      attestation: { keyId: 'phone-key', envelope: 'signed-envelope' },
      deviceTrustToken: 'trust-token',
      desktopEnvelope: 'desktop-envelope',
      desktopArgusSessionId: 'desktop-argus-session',
      desktopKeyId: 'desktop-key',
    });
  });

  it('builds the fresh proof body and includes OAuth only when supplied', () => {
    expect(
      buildProofAttestationBody({
        run,
        bindings,
        webauthn: { id: 'credential-id' },
      })
    ).toEqual({
      argusSessionId: 'phone-argus-session',
      attestation: { keyId: 'phone-key', envelope: 'signed-envelope' },
      webauthn: { id: 'credential-id' },
      desktopEnvelope: 'desktop-envelope',
      desktopArgusSessionId: 'desktop-argus-session',
      desktopKeyId: 'desktop-key',
    });

    expect(
      buildProofAttestationBody({
        run,
        bindings,
        webauthn: { error: 'mode_oauth_skipped' },
        oauth: { provider: 'google', token: 'id-token' },
      })
    ).toMatchObject({
      webauthn: { error: 'mode_oauth_skipped' },
      oauth: { provider: 'google', token: 'id-token' },
    });
  });

  it('extracts a created passkey credential id only from fulfilled create proofs', () => {
    expect(
      createdCredentialIdFromProof('passkey-create', {
        status: 'fulfilled',
        value: { id: 'credential-id' },
      })
    ).toBe('credential-id');

    expect(
      createdCredentialIdFromProof('passkey-auth', {
        status: 'fulfilled',
        value: { id: 'existing-credential-id' },
      })
    ).toBeNull();
    expect(
      createdCredentialIdFromProof('passkey-create', {
        status: 'rejected',
        reason: new Error('cancelled'),
      })
    ).toBeNull();
    expect(
      createdCredentialIdFromProof('passkey-create', {
        status: 'fulfilled',
        value: { error: 'not_allowed' },
      })
    ).toBeNull();
  });
});
