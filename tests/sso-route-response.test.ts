import { describe, expect, it } from 'vitest';
import { ssoChallengeResp, ssoStartResp } from '../cdk/lib/pair-api/sso-route-response';

describe('SSO route responses', () => {
  it('returns the drawing route and denial-only fallback from SSO start', () => {
    const response = ssoStartResp(
      'session-1',
      {
        nonce: 'nonce-1',
        expiresAt: 123,
        cpi: 'argus_cpi_test_Example12345.fastpass',
        proofRequired: false,
        freshProofRequired: false,
      },
      'https://merchant.example/return?status=failed'
    );

    expect(JSON.parse(response.body)).toMatchObject({
      challengeUrl: '/sso/challenge/session-1',
      failureReturnUrl: 'https://merchant.example/return?status=failed',
    });
  });

  it('marks external merchant validation routes without exposing the callback', () => {
    const response = ssoChallengeResp(
      'session/1',
      'return code',
      'argus_cpi_test_Example12345.fastpass',
      true
    );
    const body = JSON.parse(response.body) as Record<string, unknown>;

    expect(body.returnUrl).toBe(
      '/merchant/validate?session=session%2F1&code=return%20code&cpi=argus_cpi_test_Example12345.fastpass&flow=merchant'
    );
    expect(body).not.toHaveProperty('merchantCallbackUrl');
  });
});
