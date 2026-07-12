import { describe, expect, it } from 'vitest';
import {
  approvalCookie,
  checkApprovalRedemption,
  clearApprovalCookie,
  hashApprovalToken,
  readApprovalCookie,
  SSO_APPROVAL_COOKIE,
} from '../cdk/lib/pair-api/sso-approval';

describe('SSO approval cookie', () => {
  it('is host-only, HttpOnly, secure, and scoped to its redemption endpoint', () => {
    expect(approvalCookie('secret', 600)).toBe(
      `${SSO_APPROVAL_COOKIE}=secret; Path=/api/sso/approval/redeem; Max-Age=600; Secure; HttpOnly; SameSite=Strict`
    );
  });

  it('reads the exact approval cookie from API Gateway cookie entries', () => {
    expect(readApprovalCookie([`other=x; ${SSO_APPROVAL_COOKIE}=secret`, 'third=y'])).toBe(
      'secret'
    );
    expect(readApprovalCookie(['other=x'])).toBeNull();
  });

  it('clears the cookie on redemption', () => {
    expect(clearApprovalCookie()).toContain('Max-Age=0');
  });

  it('hashes tokens deterministically without storing bearer material', () => {
    expect(hashApprovalToken('secret')).toBe(hashApprovalToken('secret'));
    expect(hashApprovalToken('secret')).not.toBe(hashApprovalToken('different'));
    expect(hashApprovalToken('secret')).not.toContain('secret');
  });

  it('accepts only the unconsumed token for an approved session', () => {
    const cpi = 'argus_cpi_live_Example12345.forceauth';
    const state = {
      verdict: 'approved' as const,
      approvalTokenHash: hashApprovalToken('secret'),
      cpi,
    };
    expect(checkApprovalRedemption(state, 'secret', cpi)).toBe('approved');
    expect(checkApprovalRedemption(state, 'wrong', cpi)).toBe('invalid');
    expect(checkApprovalRedemption(state, 'secret', `${cpi}x`)).toBe('cpi_mismatch');
    expect(checkApprovalRedemption({ verdict: 'pending', cpi }, 'secret', cpi)).toBe(
      'not_approved'
    );
    expect(checkApprovalRedemption({ verdict: 'approved', cpi }, 'secret', cpi)).toBe('missing');
    expect(checkApprovalRedemption({ ...state, approvalRedeemedAt: 1 }, 'secret', cpi)).toBe(
      'consumed'
    );
    expect(checkApprovalRedemption({ ...state, cpi: undefined }, 'secret', cpi)).toBe(
      'cpi_missing'
    );
  });
});
