import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const SSO_APPROVAL_COOKIE = '__Secure-argus_sso_approval';
export const SSO_APPROVAL_TTL_SECONDS = 10 * 60;
const COOKIE_PATH = '/api/sso/approval/redeem';

export function mintApprovalToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashApprovalToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function approvalCookie(token: string, maxAgeSeconds: number): string {
  return `${SSO_APPROVAL_COOKIE}=${encodeURIComponent(token)}; Path=${COOKIE_PATH}; Max-Age=${maxAgeSeconds}; Secure; HttpOnly; SameSite=Strict`;
}

export function clearApprovalCookie(): string {
  return `${SSO_APPROVAL_COOKIE}=; Path=${COOKIE_PATH}; Max-Age=0; Secure; HttpOnly; SameSite=Strict`;
}

export function readApprovalCookie(cookies: string[] | undefined): string | null {
  for (const header of cookies ?? []) {
    for (const entry of header.split(';')) {
      const separator = entry.indexOf('=');
      if (separator < 0) continue;
      const name = entry.slice(0, separator).trim();
      if (name !== SSO_APPROVAL_COOKIE) continue;
      const value = entry.slice(separator + 1).trim();
      try {
        return decodeURIComponent(value);
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function checkApprovalRedemption(
  state: {
    verdict: 'pending' | 'approved' | 'failed';
    approvalTokenHash?: string;
    approvalRedeemedAt?: number;
  },
  token: string
): 'approved' | 'not_approved' | 'missing' | 'invalid' | 'consumed' {
  if (state.verdict !== 'approved') return 'not_approved';
  if (state.approvalRedeemedAt) return 'consumed';
  if (!state.approvalTokenHash) return 'missing';
  const expected = Buffer.from(state.approvalTokenHash, 'hex');
  const actual = Buffer.from(hashApprovalToken(token), 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual)
    ? 'approved'
    : 'invalid';
}
