import { describe, expect, it, vi } from 'vitest';
import type { AttestationInput } from '../../cdk/lib/pair-api/attestation/envelope.ts';
import {
  challengeSsoSession,
  type SsoChallengeDependencies,
} from '../../cdk/lib/pair-api/sso-challenge.ts';
import type { SsoSessionItem } from '../../cdk/lib/pair-api/sso-session.ts';
import { hashSsoReturnCode } from '../../cdk/lib/pair-api/sso-scan.ts';
import { merchantProjection } from '../fixtures/merchant-projection.ts';

const SESSION_ID = 'be958437-c025-4c39-8a9f-bb9c72f2fdf9';
const CPI = 'argus_cpi_test_Example12345.fastpass';
const ARGUS_SESSION_ID = 'argus-session-challenge';
const RETURN_CODE = 'sso_deterministic-return-code';
const EXPIRES_AT = 1_900_000_090_000;

const attestation: AttestationInput = {
  envelope: 'envelope',
  signature: 'signature',
  publicKey: 'public-key',
  keyId: 'key-1',
};

const startProfile = {
  argusSessionId: 'argus-session-start',
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
    proofRequired: false,
    freshProofRequired: false,
    startProfile,
    verdict: 'pending',
    expiresAt: 1_900_000_300,
    ...overrides,
  };
}

function dependencies(overrides: Partial<SsoChallengeDependencies> = {}): SsoChallengeDependencies {
  return {
    loadSession: vi.fn().mockResolvedValue(session()),
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
    mintReturnCode: vi.fn().mockReturnValue({
      value: RETURN_CODE,
      sessionId: SESSION_ID,
      expiresAt: EXPIRES_AT,
      consumed: false,
    }),
    storeChallenge: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const body = { argusSessionId: ARGUS_SESSION_ID };

describe('SSO challenge application flow', () => {
  it('validates a phone scan and stores only the return-code hash', async () => {
    const deps = dependencies({
      loadSession: vi.fn().mockResolvedValue(
        session({
          merchantCallbackUrl: 'https://merchant.example/sso-return',
          merchantChallengeId: 'checkout_action_123456789',
        })
      ),
    });

    await expect(challengeSsoSession(SESSION_ID, body, deps)).resolves.toEqual({
      ok: true,
      sessionId: SESSION_ID,
      returnCode: RETURN_CODE,
      cpi: CPI,
      hasMerchantCallback: true,
    });
    expect(deps.validateAttestation).toHaveBeenCalledWith(body, {
      role: 'argus-challenge',
      sessionId: SESSION_ID,
      nonce: 'nonce-1',
      cpi: CPI,
    });
    expect(deps.fetchProjection).toHaveBeenCalledWith(ARGUS_SESSION_ID);
    expect(deps.storeChallenge).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      challengeProfile: expect.objectContaining({
        argusSessionId: ARGUS_SESSION_ID,
        keyId: 'key-1',
        isPhone: true,
      }),
      returnCodeHash: hashSsoReturnCode(RETURN_CODE),
      returnCodeExpiresAt: Math.floor(EXPIRES_AT / 1000),
    });
    expect(JSON.stringify(vi.mocked(deps.storeChallenge).mock.calls)).not.toContain(RETURN_CODE);
  });

  it('rejects an unknown session before attestation', async () => {
    const deps = dependencies({ loadSession: vi.fn().mockResolvedValue(null) });

    await expect(challengeSsoSession(SESSION_ID, body, deps)).resolves.toEqual({
      ok: false,
      status: 404,
      body: { error: 'sso_session_not_found' },
    });
    expect(deps.validateAttestation).not.toHaveBeenCalled();
  });

  it('rejects a completed challenge before attestation', async () => {
    const deps = dependencies({
      loadSession: vi.fn().mockResolvedValue(session({ challengeProfile: startProfile })),
    });

    await expect(challengeSsoSession(SESSION_ID, body, deps)).resolves.toEqual({
      ok: false,
      status: 409,
      body: { error: 'sso_challenge_already_completed' },
    });
    expect(deps.validateAttestation).not.toHaveBeenCalled();
  });

  it('preserves attestation failures without reading a projection', async () => {
    const deps = dependencies({
      validateAttestation: vi.fn().mockReturnValue({
        ok: false,
        status: 400,
        body: { error: 'attestation_invalid' },
      }),
    });

    await expect(challengeSsoSession(SESSION_ID, body, deps)).resolves.toEqual({
      ok: false,
      status: 400,
      body: { error: 'attestation_invalid' },
    });
    expect(deps.fetchProjection).not.toHaveBeenCalled();
    expect(deps.storeChallenge).not.toHaveBeenCalled();
  });

  it.each([
    ['missing projection', null],
    ['desktop projection', merchantProjection()],
  ])('fails closed for a %s', async (_label, projection) => {
    const deps = dependencies({ fetchProjection: vi.fn().mockResolvedValue(projection) });

    const result = await challengeSsoSession(SESSION_ID, body, deps);
    expect(result).toMatchObject({
      ok: false,
      status: 403,
      body: {
        error: 'sso_requires_phone',
        leg: 'challenge',
      },
    });
    if (result.ok) throw new Error('expected the challenge to fail closed');
    expect(typeof (result.body as { failureReturnUrl?: unknown }).failureReturnUrl).toBe('string');
    expect(deps.storeChallenge).not.toHaveBeenCalled();
  });
});
