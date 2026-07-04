/*
 * Known virtual/test WebAuthn authenticator AAGUIDs — NOT real devices.
 *
 * The Chrome DevTools Protocol virtual authenticator (Playwright/Puppeteer)
 * reports a fixed AAGUID; a real platform authenticator never does — it's
 * either a real vendor AAGUID or all-zeros (`00000000-…`), which iOS/Android
 * use by default for privacy. So we reject THESE SPECIFIC values as
 * proof-of-life, and MUST NOT gate on "non-zero" or all-zero (that breaks real
 * Touch ID / Face ID / GPM users — see the verifyWebAuthn comment in pair-api).
 *
 * Verified live 2026-07-04 via a worker-wrap verdict PoC: the automated phone
 * leg's phone_webauthn_aaguid was the CDP value below.
 */
export const VIRTUAL_AUTHENTICATOR_AAGUIDS: ReadonlySet<string> = new Set([
  '01020304-0506-0708-0102-030405060708', // Chromium CDP WebAuthn virtual authenticator
]);

/** True iff the AAGUID is a known virtual/test authenticator (case-insensitive). */
export function isVirtualAuthenticator(aaguid: string | undefined | null): boolean {
  return typeof aaguid === 'string' && VIRTUAL_AUTHENTICATOR_AAGUIDS.has(aaguid.toLowerCase());
}
