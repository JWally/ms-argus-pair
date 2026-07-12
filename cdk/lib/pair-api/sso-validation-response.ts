import { approvalCookie, SSO_APPROVAL_TTL_SECONDS } from './sso-approval';

interface SsoValidationResponseInput {
  verdict: { ok: boolean; reason: string; reasons: string[] };
  approvalToken: string | null;
  merchantSessionId: string;
  cpi: string;
  merchantCallbackUrl?: string;
  merchantChallengeId?: string;
  nextDeviceTrust: string | null;
}

export function ssoValidationResponse(input: SsoValidationResponseInput) {
  const isMerchantCallback = !!(
    input.verdict.ok &&
    input.approvalToken &&
    input.merchantCallbackUrl &&
    input.merchantChallengeId
  );
  return {
    statusCode: input.verdict.ok ? 200 : 403,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
    ...(input.verdict.ok && input.approvalToken && !isMerchantCallback
      ? { cookies: [approvalCookie(input.approvalToken, SSO_APPROVAL_TTL_SECONDS)] }
      : {}),
    body: JSON.stringify({
      verdict: input.verdict.ok ? 'approved' : 'failed',
      reason: input.verdict.reason,
      reasons: input.verdict.reasons,
      merchantSessionId: input.merchantSessionId,
      cpi: input.cpi,
      ...(isMerchantCallback
        ? {
            approvalCode: input.approvalToken,
            merchantCallbackUrl: input.merchantCallbackUrl,
            merchantChallengeId: input.merchantChallengeId,
          }
        : {}),
      nextDeviceTrust: input.nextDeviceTrust,
    }),
  };
}
