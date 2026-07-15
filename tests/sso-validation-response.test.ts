import { describe, expect, it } from 'vitest';
import { ssoValidationResponse } from '../cdk/lib/pair-api/sso-validation-response';

const approved = { ok: true, reason: 'approved', reasons: [] };

describe('SSO validation response', () => {
  it('returns a merchant code without setting an Argus approval cookie', () => {
    const response = ssoValidationResponse({
      verdict: approved,
      approvalToken: 'one-time-code',
      merchantSessionId: 'merchant-session',
      cpi: 'argus_cpi_test_Example12345.fastpass',
      merchantCallbackUrl: 'https://arcades.click/api/captcha/sso-return',
      merchantChallengeId: 'challenge_1234567890',
      nextDeviceTrust: null,
    });

    expect(response.cookies).toBeUndefined();
    expect(JSON.parse(response.body)).toMatchObject({
      approvalCode: 'one-time-code',
      merchantChallengeId: 'challenge_1234567890',
    });
  });

  it('keeps the HttpOnly cookie for the presentation demo', () => {
    const response = ssoValidationResponse({
      verdict: approved,
      approvalToken: 'demo-cookie-token',
      merchantSessionId: 'demo-session',
      cpi: 'argus_cpi_test_Example12345.fastpass',
      nextDeviceTrust: null,
    });

    expect(response.cookies?.[0]).toContain('__Secure-argus_sso_approval=demo-cookie-token');
    expect(JSON.parse(response.body)).not.toHaveProperty('approvalCode');
  });

  it('returns failed external sessions to the merchant without an approval code', () => {
    const response = ssoValidationResponse({
      verdict: { ok: false, reason: 'continuity_failed', reasons: ['ip_changed'] },
      approvalToken: null,
      merchantSessionId: 'merchant-session',
      cpi: 'argus_cpi_test_Example12345.fastpass',
      merchantCallbackUrl: 'https://arcades.click/api/captcha/sso-return',
      merchantChallengeId: 'challenge_1234567890',
      nextDeviceTrust: null,
    });

    expect(response.statusCode).toBe(403);
    expect(response.cookies).toBeUndefined();
    expect(JSON.parse(response.body)).toMatchObject({
      verdict: 'failed',
      merchantCallbackUrl: 'https://arcades.click/api/captcha/sso-return',
      merchantChallengeId: 'challenge_1234567890',
    });
    expect(JSON.parse(response.body)).not.toHaveProperty('approvalCode');
  });
});
