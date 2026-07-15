import { jsonResp } from './shared/http';

interface SsoStartResponseItem {
  nonce: string;
  expiresAt: number;
  cpi: string;
  proofRequired: boolean;
  freshProofRequired: boolean;
}

export function ssoStartResp(
  sessionId: string,
  item: SsoStartResponseItem,
  failureReturnUrl: string
) {
  return jsonResp(200, {
    sessionId,
    nonce: item.nonce,
    expiresAt: item.expiresAt,
    cpi: item.cpi,
    proofRequired: item.proofRequired,
    freshProofRequired: item.freshProofRequired,
    challengeUrl: `/sso/challenge/${sessionId}`,
    failureReturnUrl,
  });
}

export function ssoChallengeResp(
  sessionId: string,
  returnCode: string,
  cpi: string,
  hasMerchantCallback: boolean
) {
  return jsonResp(200, {
    ok: true,
    returnCode,
    returnUrl: `/merchant/validate?session=${encodeURIComponent(sessionId)}&code=${encodeURIComponent(returnCode)}&cpi=${encodeURIComponent(cpi)}${hasMerchantCallback ? '&flow=merchant' : ''}`,
  });
}
