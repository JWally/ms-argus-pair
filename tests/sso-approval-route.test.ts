import { describe, expect, it, vi } from 'vitest';
import { createSsoApprovalRedemptionHandler } from '../cdk/lib/pair-api/sso-approval-route';
import { hashApprovalToken, SSO_APPROVAL_COOKIE } from '../cdk/lib/pair-api/sso-approval';

const CPI = 'argus_cpi_live_Example12345.forceauth';
const SESSION_ID = 'session-1';
const TOKEN = 'approval-secret';

function setup(overrides: { cpi?: string; sendError?: Error } = {}) {
  const send = overrides.sendError
    ? vi.fn().mockRejectedValue(overrides.sendError)
    : vi.fn().mockResolvedValue({});
  const handler = createSsoApprovalRedemptionHandler({
    ddb: { send } as never,
    tableName: 'sessions',
    loadSession: vi.fn().mockResolvedValue({
      verdict: 'approved',
      cpi: overrides.cpi ?? CPI,
      approvalTokenHash: hashApprovalToken(TOKEN),
    }),
    now: () => 1_700_000_000_000,
  });
  const cookies = [`${SSO_APPROVAL_COOKIE}=${TOKEN}`];
  return { handler, send, cookies };
}

describe('SSO approval redemption route', () => {
  it('consumes once when the merchant CPI exactly matches', async () => {
    const { handler, send, cookies } = setup();
    const response = await handler({ sessionId: SESSION_ID, cpi: CPI }, cookies);

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ cpi: CPI, scope: 'forceauth' });
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0].input).toMatchObject({
      ExpressionAttributeValues: { ':cpi': CPI },
    });
  });

  it('does not consume when the merchant CPI differs', async () => {
    const { handler, send, cookies } = setup();
    const response = await handler(
      { sessionId: SESSION_ID, cpi: 'argus_cpi_live_Example12345.stepup' },
      cookies
    );

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body)).toEqual({ error: 'sso_approval_cpi_mismatch' });
    expect(send).not.toHaveBeenCalled();
  });

  it('requires the merchant to assert a valid CPI', async () => {
    const { handler, send, cookies } = setup();
    expect((await handler({ sessionId: SESSION_ID }, cookies)).statusCode).toBe(400);
    expect((await handler({ sessionId: SESSION_ID, cpi: 'not-a-cpi' }, cookies)).statusCode).toBe(
      400
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('maps an atomic consume race to a replay conflict', async () => {
    const conflict = Object.assign(new Error('conditional conflict'), {
      name: 'ConditionalCheckFailedException',
    });
    const { handler, cookies } = setup({ sendError: conflict });
    const response = await handler({ sessionId: SESSION_ID, cpi: CPI }, cookies);

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body)).toEqual({ error: 'sso_approval_invalid_or_consumed' });
  });
});
