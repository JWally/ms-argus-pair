import { describe, expect, it, vi } from 'vitest';
import {
  startPairSession,
  type StartPairSessionDeps,
} from '../../cdk/lib/pair-api/session-start.ts';

const SESSION_ID = '4f4cf495-a98b-4b76-9099-8ad59dc85ccb';
const CHALLENGE_ID = 'checkout_action_123456789';

function dependencies(overrides: Partial<StartPairSessionDeps> = {}): StartPairSessionDeps {
  return {
    allowStart: vi.fn().mockResolvedValue(true),
    storeSession: vi.fn().mockResolvedValue({ ok: true }),
    mintBootstrapToken: vi
      .fn()
      .mockImplementation(async (_sessionId, role) => `${String(role)}-token`),
    newSessionId: () => SESSION_ID,
    newNonce: () => 'nonce-1',
    nowEpochSeconds: () => 1_900_000_000,
    sessionTtlSeconds: 300,
    requireProofOfLife: false,
    wsApiUrl: 'wss://pair.example.test',
    warn: vi.fn(),
    ...overrides,
  };
}

describe('session-start application flow', () => {
  it('maps a forceauth request into storage and role-bound bootstrap tokens', async () => {
    const deps = dependencies();
    const response = await startPairSession(
      {
        challengeId: CHALLENGE_ID,
        cpi: 'argus_cpi_test_Example12345.forceauth',
        hostPreflightRequired: true,
        hostOrigin: 'https://merchant.example',
      },
      '203.0.113.8',
      deps
    );

    expect(deps.allowStart).toHaveBeenCalledWith('203.0.113.8');
    expect(deps.storeSession).toHaveBeenCalledWith({
      id: SESSION_ID,
      nonce: 'nonce-1',
      expiresAt: 1_900_000_300,
      challengeId: CHALLENGE_ID,
      cpi: 'argus_cpi_test_Example12345.forceauth',
      proofRequired: true,
      freshProofRequired: true,
      hostPreflightRequired: true,
      hostOrigin: 'https://merchant.example',
    });
    expect(deps.mintBootstrapToken).toHaveBeenCalledTimes(2);
    expect(deps.mintBootstrapToken).toHaveBeenCalledWith(SESSION_ID, 'desktop');
    expect(deps.mintBootstrapToken).toHaveBeenCalledWith(SESSION_ID, 'phone');
    expect(response).toEqual({
      status: 200,
      body: {
        sessionId: SESSION_ID,
        nonce: 'nonce-1',
        expiresAt: 1_900_000_300,
        ws: {
          url: 'wss://pair.example.test',
          desktopToken: 'desktop-token',
          phoneToken: 'phone-token',
        },
      },
    });
  });

  it.each([
    ['missing challenge', {}, { error: 'missing_challenge_id' }],
    ['invalid challenge', { challengeId: 'short' }, { error: 'invalid_challenge_id' }],
    [
      'invalid CPI',
      { challengeId: CHALLENGE_ID, cpi: 'argus_cpi_test_short' },
      { error: 'invalid_cpi' },
    ],
  ])('rejects %s before persistence', async (_label, body, expectedBody) => {
    const deps = dependencies();

    await expect(startPairSession(body, '203.0.113.8', deps)).resolves.toEqual({
      status: 400,
      body: expectedBody,
    });
    expect(deps.storeSession).not.toHaveBeenCalled();
    expect(deps.mintBootstrapToken).not.toHaveBeenCalled();
  });

  it('returns 429 before validation when the source-IP cap is exhausted', async () => {
    const deps = dependencies({ allowStart: vi.fn().mockResolvedValue(false) });

    await expect(startPairSession({}, '203.0.113.8', deps)).resolves.toEqual({
      status: 429,
      body: { error: 'rate_limited', scope: 'session_start' },
    });
    expect(deps.storeSession).not.toHaveBeenCalled();
  });

  it('fails the abuse limiter open without hiding the operational failure', async () => {
    const warn = vi.fn();
    const deps = dependencies({
      allowStart: vi.fn().mockRejectedValue(new Error('valkey unavailable')),
      warn,
    });

    await expect(
      startPairSession({ challengeId: CHALLENGE_ID }, '203.0.113.8', deps)
    ).resolves.toMatchObject({ status: 200 });
    expect(warn).toHaveBeenCalledWith(
      '[pair] session-start rate-limit check failed open: valkey unavailable'
    );
    expect(deps.storeSession).toHaveBeenCalledOnce();
  });

  it.each([
    [400, { error: 'host_preflight_requires_cpi' }],
    [409, { error: 'session_id_collision' }],
  ] as const)('returns storage rejection %s without minting tokens', async (status, body) => {
    const deps = dependencies({
      storeSession: vi.fn().mockResolvedValue({ ok: false, status, body }),
    });

    await expect(
      startPairSession({ challengeId: CHALLENGE_ID }, '203.0.113.8', deps)
    ).resolves.toEqual({ status, body });
    expect(deps.mintBootstrapToken).not.toHaveBeenCalled();
  });
});
