import { parseMerchantChallenge } from './merchant-challenge';

interface SsoMerchantReturnBinding {
  merchantCallbackUrl?: string;
  merchantChallengeId?: string;
}

export function ssoFailureReturn(
  sessionId: string,
  cpi: string,
  binding: SsoMerchantReturnBinding = {}
): string {
  // This route can only deny. Approval still requires the one-time exchange code.
  if (binding.merchantCallbackUrl && binding.merchantChallengeId) {
    const callback = new URL(binding.merchantCallbackUrl);
    callback.searchParams.set('status', 'failed');
    callback.searchParams.set('session', sessionId);
    callback.searchParams.set('cpi', cpi);
    callback.searchParams.set('challengeId', binding.merchantChallengeId);
    return callback.toString();
  }

  const params = new URLSearchParams({
    complete: '1',
    session: sessionId,
    cpi,
    status: 'failed',
  });
  return `/merchant?${params.toString()}`;
}

export function parseSsoMerchantCallback(
  value: unknown,
  allowedOrigins: readonly string[]
): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const callback = new URL(value);
    if (
      callback.protocol !== 'https:' ||
      callback.username ||
      callback.password ||
      callback.hash ||
      !allowedOrigins.includes(callback.origin)
    ) {
      return null;
    }
    return callback.toString();
  } catch {
    return null;
  }
}

export function parseSsoMerchantBinding(
  body: Record<string, unknown>,
  allowedOrigins: readonly string[]
):
  | { ok: true; value: { merchantChallengeId?: string; merchantCallbackUrl?: string } }
  | { ok: false } {
  const hasBinding =
    body.merchantCallbackUrl !== undefined || body.merchantChallengeId !== undefined;
  if (!hasBinding) return { ok: true, value: {} };
  const merchantCallbackUrl = parseSsoMerchantCallback(body.merchantCallbackUrl, allowedOrigins);
  const merchantChallengeId = parseMerchantChallenge(body.merchantChallengeId);
  return merchantCallbackUrl && merchantChallengeId
    ? { ok: true, value: { merchantChallengeId, merchantCallbackUrl } }
    : { ok: false };
}
