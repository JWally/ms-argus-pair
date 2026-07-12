import { parseMerchantChallenge } from './merchant-challenge';

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
