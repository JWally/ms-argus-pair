export interface HostedVerifyReturnUrlResult {
  ok: boolean;
  reason?: string;
}

export interface HostedVerifyRedirectInput {
  verifyBaseUrl: string;
  sessionId: string;
  merchantId: string;
  state: string;
  nonce: string;
}

export interface HostedVerifyCallbackInput {
  returnUrl: string;
  code: string;
  state: string;
}

export function validateHostedVerifyReturnUrl(
  returnUrl: string,
  allowedReturnOrigins: readonly string[]
): HostedVerifyReturnUrlResult {
  let parsed: URL;
  try {
    parsed = new URL(returnUrl);
  } catch {
    return { ok: false, reason: 'return_url_malformed' };
  }
  if (parsed.protocol !== 'https:') {
    return { ok: false, reason: 'return_url_not_https' };
  }
  if (!allowedReturnOrigins.includes(parsed.origin)) {
    return { ok: false, reason: 'return_url_origin_not_allowed' };
  }
  return { ok: true };
}

export function buildHostedVerifyRedirectUrl(input: HostedVerifyRedirectInput): string {
  const url = new URL(`/verify/${encodeURIComponent(input.sessionId)}`, input.verifyBaseUrl);
  url.searchParams.set('m', input.merchantId);
  url.searchParams.set('state', input.state);
  url.searchParams.set('n', input.nonce);
  return url.toString();
}

export function buildHostedVerifyCallbackUrl(input: HostedVerifyCallbackInput): string {
  const url = new URL(input.returnUrl);
  url.searchParams.set('code', input.code);
  url.searchParams.set('state', input.state);
  url.searchParams.delete('verdict');
  url.searchParams.delete('passed');
  url.searchParams.delete('token');
  return url.toString();
}
