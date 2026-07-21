import { describe, expect, it, vi } from 'vitest';
import type { AttestationInput } from '../../cdk/lib/pair-api/attestation/envelope.ts';
import { startSsoSession, type SsoStartDependencies } from '../../cdk/lib/pair-api/sso-start.ts';
import { merchantProjection } from '../fixtures/merchant-projection.ts';

const SESSION_ID = 'be958437-c025-4c39-8a9f-bb9c72f2fdf9';
const CPI = 'argus_cpi_test_Example12345.fastpass';
const ARGUS_SESSION_ID = 'argus-session-1';
const CHALLENGE_ID = 'checkout_action_123456789';

const attestation: AttestationInput = {
  envelope: 'envelope',
  signature: 'signature',
  publicKey: 'public-key',
  keyId: 'key-1',
};

function dependencies(overrides: Partial<SsoStartDependencies> = {}): SsoStartDependencies {
  return {
    callbackOrigins: ['https://merchant.example'],
    validateAttestation: vi.fn().mockReturnValue({ ok: true, attestation }),
    fetchProjection: vi.fn().mockResolvedValue(
      merchantProjection({
        session_id: ARGUS_SESSION_ID,
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
    storeSession: vi.fn().mockResolvedValue(undefined),
    newSessionId: () => SESSION_ID,
    newNonce: () => 'nonce-1',
    newMerchantSessionId: () => 'generated-merchant-session',
    nowEpochSeconds: () => 1_900_000_000,
    sessionTtlSeconds: 300,
    requireProofOfLife: false,
    ...overrides,
  };
}

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cpi: CPI,
    argusSessionId: ARGUS_SESSION_ID,
    merchantSessionId: 'merchant-session-1',
    ...overrides,
  };
}

describe('SSO start application flow', () => {
  it('validates the phone scan and stores a merchant-bound SSO session', async () => {
    const deps = dependencies();
    const result = await startSsoSession(
      validBody({
        merchantCallbackUrl: 'https://merchant.example/sso-return',
        merchantChallengeId: CHALLENGE_ID,
      }),
      deps
    );

    expect(deps.validateAttestation).toHaveBeenCalledWith(
      validBody({
        merchantCallbackUrl: 'https://merchant.example/sso-return',
        merchantChallengeId: CHALLENGE_ID,
      }),
      CPI
    );
    expect(deps.fetchProjection).toHaveBeenCalledWith(ARGUS_SESSION_ID);
    expect(deps.storeSession).toHaveBeenCalledWith({
      PK: `SSO#${SESSION_ID}`,
      SK: 'META',
      nonce: 'nonce-1',
      merchantSessionId: 'merchant-session-1',
      cpi: CPI,
      merchantCallbackUrl: 'https://merchant.example/sso-return',
      merchantChallengeId: CHALLENGE_ID,
      proofRequired: false,
      freshProofRequired: false,
      startProfile: expect.objectContaining({
        argusSessionId: ARGUS_SESSION_ID,
        keyId: 'key-1',
        isPhone: true,
      }),
      verdict: 'pending',
      expiresAt: 1_900_000_300,
    });
    expect(result).toMatchObject({
      ok: true,
      sessionId: SESSION_ID,
      failureReturnUrl: expect.stringContaining('https://merchant.example/sso-return'),
    });
  });

  it.each([
    ['missing CPI', {}, { error: 'missing_cpi' }],
    ['invalid CPI', { cpi: 'argus_cpi_test_short' }, { error: 'invalid_cpi' }],
  ])('rejects %s before attestation', async (_label, body, expectedBody) => {
    const deps = dependencies();

    await expect(startSsoSession(body, deps)).resolves.toEqual({
      ok: false,
      status: 400,
      body: expectedBody,
    });
    expect(deps.validateAttestation).not.toHaveBeenCalled();
    expect(deps.fetchProjection).not.toHaveBeenCalled();
    expect(deps.storeSession).not.toHaveBeenCalled();
  });

  it('preserves attestation failures without reading a projection', async () => {
    const deps = dependencies({
      validateAttestation: vi.fn().mockReturnValue({
        ok: false,
        status: 400,
        body: { error: 'attestation_invalid' },
      }),
    });

    await expect(startSsoSession(validBody(), deps)).resolves.toEqual({
      ok: false,
      status: 400,
      body: { error: 'attestation_invalid' },
    });
    expect(deps.fetchProjection).not.toHaveBeenCalled();
    expect(deps.storeSession).not.toHaveBeenCalled();
  });

  it('rejects incomplete merchant callback bindings before projection lookup', async () => {
    const deps = dependencies();

    await expect(
      startSsoSession(validBody({ merchantCallbackUrl: 'https://merchant.example/return' }), deps)
    ).resolves.toEqual({
      ok: false,
      status: 400,
      body: { error: 'invalid_sso_merchant_binding' },
    });
    expect(deps.fetchProjection).not.toHaveBeenCalled();
    expect(deps.storeSession).not.toHaveBeenCalled();
  });

  it.each([
    ['missing projection', null],
    ['desktop projection', merchantProjection()],
  ])('fails closed for a %s', async (_label, projection) => {
    const deps = dependencies({ fetchProjection: vi.fn().mockResolvedValue(projection) });

    await expect(startSsoSession(validBody(), deps)).resolves.toMatchObject({
      ok: false,
      status: 403,
      body: { error: 'sso_requires_phone', leg: 'start' },
    });
    expect(deps.storeSession).not.toHaveBeenCalled();
  });

  it('snapshots forceauth policy and bounds merchant-owned labels', async () => {
    const deps = dependencies();
    const merchantSessionId = 'm'.repeat(200);

    await startSsoSession(
      validBody({
        cpi: 'argus_cpi_test_Example12345.forceauth',
        merchantSessionId,
      }),
      deps
    );

    expect(deps.storeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        cpi: 'argus_cpi_test_Example12345.forceauth',
        merchantSessionId: merchantSessionId.slice(0, 128),
        proofRequired: true,
        freshProofRequired: true,
      })
    );
  });
});
