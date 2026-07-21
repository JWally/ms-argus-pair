import { describe, expect, it, vi } from 'vitest';
import type { AttestationInput } from '../cdk/lib/pair-api/attestation/envelope.ts';
import {
  verifySsoValidationProof,
  type SsoValidationProofDependencies,
} from '../cdk/lib/pair-api/sso-validation-proof.ts';

const attestation: AttestationInput = {
  envelope: 'envelope',
  signature: 'signature',
  publicKey: 'public-key',
  keyId: 'key-1',
};

function dependencies(
  overrides: Partial<SsoValidationProofDependencies> = {}
): SsoValidationProofDependencies {
  return {
    verifyDeviceTrust: vi.fn().mockResolvedValue({ ok: true, ipChanged: false }),
    verifyProofOfLife: vi.fn().mockResolvedValue({ phone_webauthn_attested: true }),
    ...overrides,
  };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    body: { webauthn: { response: 'proof' } },
    requesterIp: '203.0.113.7',
    attestation,
    nonce: 'nonce-1',
    proofRequired: true,
    freshProofRequired: false,
    ...overrides,
  };
}

describe('SSO validation proof policy', () => {
  it('rejects cached device trust when fresh proof is required', async () => {
    const deps = dependencies();

    await expect(
      verifySsoValidationProof(
        input({ body: { deviceTrustToken: 'cached-token' }, freshProofRequired: true }),
        deps
      )
    ).resolves.toEqual({
      ok: false,
      status: 401,
      body: { error: 'fresh_proof_required' },
    });
    expect(deps.verifyDeviceTrust).not.toHaveBeenCalled();
    expect(deps.verifyProofOfLife).not.toHaveBeenCalled();
  });

  it('rejects invalid device trust and asks the client to clear it', async () => {
    const deps = dependencies({
      verifyDeviceTrust: vi.fn().mockResolvedValue({ ok: false, reason: 'expired' }),
    });

    await expect(
      verifySsoValidationProof(input({ body: { deviceTrustToken: 'cached-token' } }), deps)
    ).resolves.toEqual({
      ok: false,
      status: 401,
      body: { error: 'device_trust_rejected', reason: 'expired', clearDeviceTrust: true },
    });
    expect(deps.verifyProofOfLife).not.toHaveBeenCalled();
  });

  it('turns valid device trust into proof annotations and tracks IP drift', async () => {
    const deps = dependencies({
      verifyDeviceTrust: vi.fn().mockResolvedValue({ ok: true, ipChanged: true }),
    });

    await expect(
      verifySsoValidationProof(input({ body: { deviceTrustToken: 'cached-token' } }), deps)
    ).resolves.toEqual({
      ok: true,
      trustRedeemed: true,
      annotations: {
        phone_webauthn_attested: true,
        phone_device_trust_redeemed: true,
        phone_device_trust_ip_changed: true,
      },
    });
    expect(deps.verifyProofOfLife).toHaveBeenCalledWith({
      webauthn: undefined,
      oauth: undefined,
      expectedNonce: 'nonce-1',
      argusPubkey: 'public-key',
      trustRedeemed: true,
    });
  });

  it('returns proof-policy failures with diagnostic annotations', async () => {
    const deps = dependencies({
      verifyProofOfLife: vi.fn().mockResolvedValue({
        phone_webauthn_attested: false,
        phone_webauthn_error: 'missing',
      }),
    });

    await expect(verifySsoValidationProof(input(), deps)).resolves.toEqual({
      ok: false,
      status: 401,
      body: {
        error: 'proof_of_life_required',
        annotations: {
          phone_webauthn_attested: false,
          phone_webauthn_error: 'missing',
        },
      },
    });
  });

  it('allows missing proof when the session policy does not require it', async () => {
    const deps = dependencies({
      verifyProofOfLife: vi.fn().mockResolvedValue({ phone_webauthn_attested: false }),
    });

    await expect(verifySsoValidationProof(input({ proofRequired: false }), deps)).resolves.toEqual({
      ok: true,
      trustRedeemed: false,
      annotations: { phone_webauthn_attested: false },
    });
  });
});
