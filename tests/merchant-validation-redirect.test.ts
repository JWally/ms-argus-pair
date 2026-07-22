import { describe, expect, it } from 'vitest';
import { merchantValidationRedirect } from '../src/lib/merchant-validation-flow';
import type { SsoValidateResult } from '../src/lib/sso-client';

const approvedResult: SsoValidateResult = {
  verdict: 'approved',
  reason: 'approved',
  reasons: [],
  merchantSessionId: 'merchant-session',
  cpi: 'merchant-cpi.stepup',
};

describe('merchant callback redirects', () => {
  it('binds approval to the server-returned challenge and code', () => {
    const redirect = merchantValidationRedirect({
      sessionId: 'sso-session',
      cpi: 'merchant-cpi.stepup',
      isMerchantCallback: true,
      result: {
        ...approvedResult,
        approvalCode: 'approval-code',
        merchantCallbackUrl: 'https://merchant.example/return?existing=1',
        merchantChallengeId: 'challenge-id',
      },
      error: null,
      failureReturnUrl: null,
    });

    expect(redirect).toEqual({
      kind: 'replace',
      url:
        'https://merchant.example/return?existing=1&session=sso-session&cpi=merchant-cpi.stepup' +
        '&challengeId=challenge-id&code=approval-code',
    });
  });

  it('returns failures without leaking an approval code', () => {
    const redirect = merchantValidationRedirect({
      sessionId: 'sso-session',
      cpi: 'merchant-cpi.stepup',
      isMerchantCallback: true,
      result: {
        ...approvedResult,
        verdict: 'failed',
        reason: 'continuity_failed',
        reasons: ['continuity_failed'],
        approvalCode: 'must-not-leak',
        merchantCallbackUrl: 'https://merchant.example/return',
        merchantChallengeId: 'challenge-id',
      },
      error: null,
      failureReturnUrl: null,
    });

    expect(redirect).toEqual({
      kind: 'replace',
      url:
        'https://merchant.example/return?session=sso-session&cpi=merchant-cpi.stepup' +
        '&challengeId=challenge-id&status=failed',
    });
    expect(redirect?.url).not.toContain('code=');
  });

  it('waits for complete approval binding', () => {
    expect(
      merchantValidationRedirect({
        sessionId: 'sso-session',
        cpi: 'merchant-cpi.stepup',
        isMerchantCallback: true,
        result: {
          ...approvedResult,
          merchantCallbackUrl: 'https://merchant.example/return',
          merchantChallengeId: 'challenge-id',
        },
        error: null,
        failureReturnUrl: null,
      })
    ).toBeNull();
  });

  it.each([
    [approvedResult, null],
    [null, 'validation unavailable'],
  ])('uses the recorded failure return for an unbound terminal outcome %#', (result, error) => {
    expect(
      merchantValidationRedirect({
        sessionId: 'sso-session',
        cpi: 'merchant-cpi.stepup',
        isMerchantCallback: true,
        result,
        error,
        failureReturnUrl: 'https://merchant.example/failure',
      })
    ).toEqual({ kind: 'replace', url: 'https://merchant.example/failure' });
  });
});

describe('merchant demo redirects', () => {
  it('never redirects without complete session binding', () => {
    expect(
      merchantValidationRedirect({
        sessionId: null,
        cpi: 'merchant-cpi.stepup',
        isMerchantCallback: false,
        result: approvedResult,
        error: null,
        failureReturnUrl: null,
      })
    ).toBeNull();
  });

  it('routes approval to one-time redemption', () => {
    expect(
      merchantValidationRedirect({
        sessionId: 'sso-session',
        cpi: 'merchant-cpi.stepup',
        isMerchantCallback: false,
        result: approvedResult,
        error: null,
        failureReturnUrl: null,
      })
    ).toEqual({
      kind: 'navigate',
      url: '/merchant?complete=1&session=sso-session&cpi=merchant-cpi.stepup',
    });
  });
});
