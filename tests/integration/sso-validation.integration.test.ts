import { describe, expect, it, vi } from 'vitest';
import type { AttestationInput } from '../../cdk/lib/pair-api/attestation/envelope.ts';
import { hashApprovalToken } from '../../cdk/lib/pair-api/sso-approval.ts';
import type { SsoSessionItem } from '../../cdk/lib/pair-api/sso-session.ts';
import { hashSsoReturnCode } from '../../cdk/lib/pair-api/sso-scan.ts';
import {
  validateSsoSession,
  type SsoValidationDependencies,
} from '../../cdk/lib/pair-api/sso-validation.ts';
import { merchantProjection } from '../fixtures/merchant-projection.ts';

const SESSION_ID = 'be958437-c025-4c39-8a9f-bb9c72f2fdf9';
const CPI = 'argus_cpi_test_Example12345.fastpass';
const RETURN_CODE = 'sso_deterministic-return-code';
const ARGUS_SESSION_ID = 'argus-session-validate';
const NOW = 1_900_000_000;
const APPROVAL_TOKEN = 'approval-token';

const attestation: AttestationInput = {
  envelope: 'envelope',
  signature: 'signature',
  publicKey: 'public-key',
  keyId: 'key-1',
};

const phoneProfile = {
  argusSessionId: 'argus-session-prior',
  keyId: 'key-1',
  ip: '203.0.113.7',
  asnName: 'Argus Mobile',
  country: 'US',
  city: 'Dallas',
  score: 0,
  isPhone: true,
  isProxy: false,
  isDatacenter: false,
  isVpn: false,
};

function session(overrides: Partial<SsoSessionItem> = {}): SsoSessionItem {
  return {
    PK: `SSO#${SESSION_ID}`,
    SK: 'META',
    nonce: 'nonce-1',
    merchantSessionId: 'merchant-session-1',
    cpi: CPI,
    proofRequired: true,
    freshProofRequired: false,
    startProfile: phoneProfile,
    challengeProfile: phoneProfile,
    returnCodeHash: hashSsoReturnCode(RETURN_CODE),
    returnCodeExpiresAt: NOW + 60,
    verdict: 'pending',
    expiresAt: NOW + 300,
    ...overrides,
  };
}

function dependencies(
  overrides: Partial<SsoValidationDependencies> = {}
): SsoValidationDependencies {
  return {
    loadSession: vi.fn().mockResolvedValue(session()),
    validateAttestation: vi.fn().mockReturnValue({ ok: true, attestation }),
    fetchProjection: vi.fn().mockResolvedValue(
      merchantProjection({
        session_id: ARGUS_SESSION_ID,
        created_at: Date.now(),
        identification: {
          browserDetails: {
            browserName: 'Chrome',
            browserVersion: '150',
            device: 'mobile',
            os: 'Android',
            userAgent: 'Mozilla/5.0 Android Mobile',
          },
        },
      })
    ),
    verifyProof: vi.fn().mockResolvedValue({
      ok: true,
      annotations: { phone_webauthn_attested: true },
      trustRedeemed: false,
    }),
    mintApprovalToken: () => APPROVAL_TOKEN,
    mintDeviceTrust: vi.fn().mockResolvedValue('next-device-trust'),
    storeValidation: vi.fn().mockResolvedValue(undefined),
    nowEpochSeconds: () => NOW,
    approvalTtlSeconds: 600,
    ...overrides,
  };
}

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    returnCode: RETURN_CODE,
    argusSessionId: ARGUS_SESSION_ID,
    webauthn: { response: 'proof' },
    ...overrides,
  };
}

describe('SSO validation application flow', () => {
  it('stores an approved continuity verdict with only the approval hash', async () => {
    const deps = dependencies({
      loadSession: vi.fn().mockResolvedValue(
        session({
          merchantCallbackUrl: 'https://merchant.example/sso-return',
          merchantChallengeId: 'checkout_action_123456789',
        })
      ),
    });

    const result = await validateSsoSession(SESSION_ID, body(), '203.0.113.7', deps);

    expect(result).toMatchObject({
      ok: true,
      verdict: { ok: true, reason: 'approved' },
      approvalToken: APPROVAL_TOKEN,
      merchantSessionId: 'merchant-session-1',
      cpi: CPI,
      merchantCallbackUrl: 'https://merchant.example/sso-return',
      merchantChallengeId: 'checkout_action_123456789',
      nextDeviceTrust: 'next-device-trust',
    });
    expect(deps.validateAttestation).toHaveBeenCalledWith(body(), {
      role: 'merchant-validate',
      sessionId: SESSION_ID,
      nonce: 'nonce-1',
      returnCode: RETURN_CODE,
      cpi: CPI,
    });
    expect(deps.storeValidation).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      validateProfile: expect.objectContaining({
        argusSessionId: ARGUS_SESSION_ID,
        keyId: 'key-1',
        isPhone: true,
      }),
      verdict: 'approved',
      verdictReason: 'approved',
      returnCodeConsumedAt: NOW,
      proofAnnotations: { phone_webauthn_attested: true },
      approval: {
        approvedAt: NOW,
        approvalTokenHash: hashApprovalToken(APPROVAL_TOKEN),
        expiresAt: NOW + 600,
      },
    });
    expect(JSON.stringify(vi.mocked(deps.storeValidation).mock.calls)).not.toContain(
      APPROVAL_TOKEN
    );
  });

  it('rejects unknown and incomplete sessions before attestation', async () => {
    const missing = dependencies({ loadSession: vi.fn().mockResolvedValue(null) });
    await expect(validateSsoSession(SESSION_ID, body(), '203.0.113.7', missing)).resolves.toEqual({
      ok: false,
      status: 404,
      body: { error: 'sso_session_not_found' },
    });
    expect(missing.validateAttestation).not.toHaveBeenCalled();

    const incomplete = dependencies({
      loadSession: vi.fn().mockResolvedValue(
        session({
          challengeProfile: undefined,
          returnCodeHash: undefined,
          returnCodeExpiresAt: undefined,
        })
      ),
    });
    await expect(
      validateSsoSession(SESSION_ID, body(), '203.0.113.7', incomplete)
    ).resolves.toEqual({
      ok: false,
      status: 409,
      body: { error: 'sso_challenge_not_completed' },
    });
    expect(incomplete.validateAttestation).not.toHaveBeenCalled();
  });

  it('rejects consumed, invalid, and expired return codes before attestation', async () => {
    const consumed = dependencies({
      loadSession: vi.fn().mockResolvedValue(session({ returnCodeConsumedAt: NOW - 1 })),
    });
    await expect(
      validateSsoSession(SESSION_ID, body(), '203.0.113.7', consumed)
    ).resolves.toMatchObject({ status: 409, body: { error: 'sso_return_code_consumed' } });

    const invalid = dependencies();
    await expect(
      validateSsoSession(SESSION_ID, body({ returnCode: 'wrong' }), '203.0.113.7', invalid)
    ).resolves.toMatchObject({ status: 401, body: { error: 'sso_return_code_invalid' } });

    const expired = dependencies({
      loadSession: vi.fn().mockResolvedValue(session({ returnCodeExpiresAt: NOW - 1 })),
    });
    await expect(
      validateSsoSession(SESSION_ID, body(), '203.0.113.7', expired)
    ).resolves.toMatchObject({ status: 401, body: { error: 'sso_return_code_expired' } });

    expect(consumed.validateAttestation).not.toHaveBeenCalled();
    expect(invalid.validateAttestation).not.toHaveBeenCalled();
    expect(expired.validateAttestation).not.toHaveBeenCalled();
  });

  it('preserves attestation and proof failures without storing a decision', async () => {
    const badAttestation = dependencies({
      validateAttestation: vi.fn().mockReturnValue({
        ok: false,
        status: 400,
        body: { error: 'attestation_invalid' },
      }),
    });
    await expect(
      validateSsoSession(SESSION_ID, body(), '203.0.113.7', badAttestation)
    ).resolves.toMatchObject({ status: 400, body: { error: 'attestation_invalid' } });
    expect(badAttestation.fetchProjection).not.toHaveBeenCalled();

    const badProof = dependencies({
      verifyProof: vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        body: { error: 'proof_of_life_required', annotations: {} },
      }),
    });
    await expect(
      validateSsoSession(SESSION_ID, body(), '203.0.113.7', badProof)
    ).resolves.toMatchObject({ status: 401, body: { error: 'proof_of_life_required' } });
    expect(badAttestation.storeValidation).not.toHaveBeenCalled();
    expect(badProof.storeValidation).not.toHaveBeenCalled();
  });

  it.each([
    ['missing projection', null],
    ['desktop projection', merchantProjection()],
  ])('fails closed for a %s before proof verification', async (_label, projection) => {
    const deps = dependencies({ fetchProjection: vi.fn().mockResolvedValue(projection) });

    const result = await validateSsoSession(SESSION_ID, body(), '203.0.113.7', deps);

    expect(result).toMatchObject({
      ok: false,
      status: 403,
      body: { error: 'sso_requires_phone', leg: 'validate' },
    });
    expect(deps.verifyProof).not.toHaveBeenCalled();
    expect(deps.storeValidation).not.toHaveBeenCalled();
  });

  it('stores a failed continuity verdict without approval or device trust', async () => {
    const deps = dependencies({
      validateAttestation: vi.fn().mockReturnValue({
        ok: true,
        attestation: { ...attestation, keyId: 'key-2' },
      }),
    });

    const result = await validateSsoSession(SESSION_ID, body(), '203.0.113.7', deps);

    expect(result).toMatchObject({
      ok: true,
      verdict: { ok: false, reason: 'device_changed' },
      approvalToken: null,
      nextDeviceTrust: null,
    });
    expect(deps.storeValidation).toHaveBeenCalledWith(
      expect.objectContaining({
        verdict: 'failed',
        verdictReason: 'device_changed',
        approval: undefined,
      })
    );
    expect(deps.mintDeviceTrust).not.toHaveBeenCalled();
  });

  it('does not mint new device trust after a successful redemption', async () => {
    const deps = dependencies({
      verifyProof: vi.fn().mockResolvedValue({
        ok: true,
        annotations: {
          phone_webauthn_attested: true,
          phone_device_trust_redeemed: true,
        },
        trustRedeemed: true,
      }),
    });

    const result = await validateSsoSession(SESSION_ID, body(), '203.0.113.7', deps);

    expect(result).toMatchObject({ ok: true, nextDeviceTrust: null });
    expect(deps.mintDeviceTrust).not.toHaveBeenCalled();
  });
});
