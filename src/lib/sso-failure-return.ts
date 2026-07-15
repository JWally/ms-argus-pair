const FAILURE_RETURN_KEY = 'argus-demo-sso-failure-return:';

export function rememberSsoFailureReturnUrl(sessionId: string, returnUrl?: string): void {
  if (!returnUrl) return;
  window.sessionStorage.setItem(`${FAILURE_RETURN_KEY}${sessionId}`, returnUrl);
}

export function loadSsoFailureReturnUrl(sessionId: string): string | null {
  return window.sessionStorage.getItem(`${FAILURE_RETURN_KEY}${sessionId}`);
}

export function failureReturnUrlFrom(cause: unknown): string | null {
  if (!cause || typeof cause !== 'object' || !('bodyJson' in cause)) return null;
  const bodyJson = (cause as { bodyJson?: unknown }).bodyJson;
  if (!bodyJson || typeof bodyJson !== 'object' || !('failureReturnUrl' in bodyJson)) return null;
  const returnUrl = (bodyJson as { failureReturnUrl?: unknown }).failureReturnUrl;
  return typeof returnUrl === 'string' && returnUrl.length > 0 ? returnUrl : null;
}
