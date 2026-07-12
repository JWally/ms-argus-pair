import { describe, expect, it, vi } from 'vitest';
import { hashApprovalToken } from '../cdk/lib/pair-api/sso-approval';
import { createSsoMerchantApprovalHandler } from '../cdk/lib/pair-api/sso-merchant-approval-route';

const CPI = 'argus_cpi_live_Example12345.fastpass';
const SESSION_ID = 'session-1';
const CODE = 'approval-code';
const CHALLENGE_ID = 'checkout_1234567890';

function setup(overrides: { challengeId?: string; sendError?: Error } = {}) {
  const send = overrides.sendError
    ? vi.fn().mockRejectedValue(overrides.sendError)
    : vi.fn().mockResolvedValue({});
  const handler = createSsoMerchantApprovalHandler({
    ddb: { send } as never,
    tableName: 'sessions',
    loadSession: vi.fn().mockResolvedValue({
      verdict: 'approved',
      merchantSessionId: 'merchant-session',
      cpi: CPI,
      merchantChallengeId: overrides.challengeId ?? CHALLENGE_ID,
      merchantCallbackUrl: 'https://arcades.click/api/captcha/sso-return',
      approvalTokenHash: hashApprovalToken(CODE),
    }),
    now: () => 1_700_000_000_000,
  });
  return { handler, send };
}

describe('SSO merchant approval exchange', () => {
  it('atomically consumes a code bound to the exact CPI and challenge', async () => {
    const { handler, send } = setup();
    const response = await handler({
      sessionId: SESSION_ID,
      code: CODE,
      cpi: CPI,
      challengeId: CHALLENGE_ID,
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      valid: true,
      passed: true,
      verdict: 'approved',
      reason: 'approved',
      merchantSessionId: 'merchant-session',
      cpi: CPI,
      scope: 'fastpass',
      challengeId: CHALLENGE_ID,
    });
    expect(send.mock.calls[0][0].input).toMatchObject({
      ConditionExpression: expect.stringContaining('merchantChallengeId = :challengeId'),
      ExpressionAttributeValues: expect.objectContaining({
        ':cpi': CPI,
        ':challengeId': CHALLENGE_ID,
      }),
    });
  });

  it('rejects challenge substitution without consuming the code', async () => {
    const { handler, send } = setup();
    const response = await handler({
      sessionId: SESSION_ID,
      code: CODE,
      cpi: CPI,
      challengeId: 'checkout_attacker',
    });

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body)).toEqual({ error: 'sso_approval_challenge_mismatch' });
    expect(send).not.toHaveBeenCalled();
  });

  it('fails a replay when the conditional consume loses the race', async () => {
    const replay = Object.assign(new Error('consumed'), {
      name: 'ConditionalCheckFailedException',
    });
    const { handler } = setup({ sendError: replay });
    const response = await handler({
      sessionId: SESSION_ID,
      code: CODE,
      cpi: CPI,
      challengeId: CHALLENGE_ID,
    });

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body)).toEqual({ error: 'sso_approval_invalid_or_consumed' });
  });
});
