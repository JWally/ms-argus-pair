import type { MerchantProjection } from './projection-verdict';

const MERCHANT_API_URL = process.env.MERCHANT_API_URL || '';
const MERCHANT_API_CREDENTIAL = process.env.MERCHANT_API_CREDENTIAL || '';
const MERCHANT_CPI = process.env.MERCHANT_CPI || '';

export function splitCredential(credential: string): { keyId: string; token: string } {
  const idx = credential.indexOf('.');
  if (idx <= 0) throw new Error('credential malformed: missing keyId.token separator');
  return { keyId: credential.slice(0, idx), token: credential.slice(idx + 1) };
}

/**
 * Fetch the merchant-safe projection for an argusSessionId. Returns null
 * if the lookup is impossible, so the route-level verdict can fail closed.
 */
export async function fetchProjection(argusSessionId: string): Promise<MerchantProjection | null> {
  if (!MERCHANT_API_URL || !MERCHANT_API_CREDENTIAL || !MERCHANT_CPI) {
    console.warn('[pair] fetchProjection: merchant config missing');
    return null;
  }
  try {
    const { keyId, token } = splitCredential(MERCHANT_API_CREDENTIAL);
    const url = `${MERCHANT_API_URL}/v1/session/${encodeURIComponent(MERCHANT_CPI)}/${encodeURIComponent(argusSessionId)}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'x-api-key': keyId, 'x-argus-token': token },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(
        `[pair] fetchProjection: ${res.status} for argusSessionId=${argusSessionId} body=${body.slice(0, 200)}`
      );
      return null;
    }
    return (await res.json().catch(() => null)) as MerchantProjection | null;
  } catch (e) {
    console.warn(`[pair] fetchProjection: threw ${(e as Error).message}`);
    return null;
  }
}
