/**
 * Client-side OAuth proof-of-life helpers for the pair demo.
 *
 * Drives Google's standard OAuth dance and returns an ID token the pair
 * backend can verify.
 *
 * Nonce/state binding: the pair `session.nonce` is passed in as
 * `expectedNonce` and carried in Google's OIDC `nonce` claim. The backend
 * re-checks that claim, so a captured token from another pair session fails.
 *
 * This module is intentionally UI-agnostic. The demo chooses when to invoke
 * the Google One Tap sheet.
 *
 * Build-time env vars:
 *   VITE_OAUTH_GOOGLE_CLIENT_ID — Google OAuth 2.0 client ID
 *
 * Absent → the corresponding helper returns `{ error: '*_not_configured' }`
 * and the UI hides the button.
 */

export type OAuthProvider = 'google';

interface OAuthResult {
  provider: OAuthProvider;
  token: string;
}

export interface OAuthError {
  provider: OAuthProvider;
  error: string;
}

export type OAuthOutcome = OAuthResult | OAuthError;

export function isOAuthError(o: OAuthOutcome): o is OAuthError {
  return 'error' in o;
}

const GOOGLE_CLIENT_ID = (import.meta.env.VITE_OAUTH_GOOGLE_CLIENT_ID as string | undefined) ?? '';

export const PROVIDERS_CONFIGURED: Record<OAuthProvider, boolean> = {
  google: GOOGLE_CLIENT_ID.length > 0,
};

// ─────────────────────────────────────────────────────────────────────────
// Google — One Tap on Android Chrome, popup elsewhere.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Loads https://accounts.google.com/gsi/client once per page and
 * caches the global on `window.google.accounts.id`. Repeated calls
 * resolve immediately.
 */
async function loadGoogleIdentityServices(): Promise<void> {
  if ((window as { google?: unknown }).google) return;
  await new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('gsi_load_failed'));
    document.head.appendChild(script);
  });
}

interface GsiIdNamespace {
  initialize: (cfg: {
    client_id: string;
    nonce: string;
    callback: (resp: { credential?: string }) => void;
    auto_select?: boolean;
    use_fedcm_for_prompt?: boolean;
    context?: 'signin' | 'signup' | 'use';
  }) => void;
  prompt: (
    cb?: (notif: {
      isNotDisplayed?: () => boolean;
      getNotDisplayedReason?: () => string;
      isSkippedMoment?: () => boolean;
      getSkippedReason?: () => string;
      isDismissedMoment?: () => boolean;
      getDismissedReason?: () => string;
    }) => void
  ) => void;
  cancel: () => void;
}

interface GoogleGsiNamespace {
  accounts?: { id?: GsiIdNamespace };
}

const PROMPT_TIMEOUT_MS = 60_000;

/**
 * Drive Google's "Sign In With Google" flow on the phone. Uses GIS's
 * `initialize` + `prompt` for the One Tap surface (instant on Android
 * Chrome where the user is already signed into Google).
 *
 * Nonce: passed as `nonce` to `initialize` and echoed inside the
 * returned ID token's `nonce` claim. Backend verifies the claim.
 *
 * Timeout: One Tap can silently no-op (suppressed by browser, user
 * dismissed prior prompt in this session, FedCM denied, etc.). We
 * bail with a descriptive error after PROMPT_TIMEOUT_MS so callers
 * can fall back to a different proof-of-life option.
 */
export async function runGoogleProofOfLife(nonce: string): Promise<OAuthOutcome> {
  if (!PROVIDERS_CONFIGURED.google) {
    return { provider: 'google', error: 'google_not_configured' };
  }
  try {
    await loadGoogleIdentityServices();
  } catch (e) {
    return { provider: 'google', error: (e as Error).message };
  }
  const g = (window as { google?: GoogleGsiNamespace }).google?.accounts?.id;
  if (!g) {
    return { provider: 'google', error: 'gsi_namespace_missing' };
  }
  return new Promise<OAuthOutcome>((resolve) => {
    let settled = false;
    const finish = (outcome: OAuthOutcome): void => {
      if (settled) return;
      settled = true;
      try {
        g.cancel();
      } catch {
        /* GIS may already be torn down */
      }
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      finish({ provider: 'google', error: 'prompt_timeout' });
    }, PROMPT_TIMEOUT_MS);
    g.initialize({
      client_id: GOOGLE_CLIENT_ID,
      nonce,
      use_fedcm_for_prompt: true,
      context: 'signin',
      callback: (resp) => {
        clearTimeout(timer);
        if (!resp?.credential) {
          finish({ provider: 'google', error: 'no_credential' });
          return;
        }
        finish({ provider: 'google', token: resp.credential });
      },
    });
    // Prompt notification tells us when One Tap is suppressed (user
    // closed it earlier this session, FedCM declined, browser blocked
    // 3p contexts). Resolve early with a descriptive reason so the
    // caller can render an explicit "Continue with Google" button
    // instead of waiting for the timeout.
    g.prompt((notif) => {
      if (settled) return;
      if (notif?.isNotDisplayed?.()) {
        clearTimeout(timer);
        finish({
          provider: 'google',
          error: `prompt_not_displayed:${notif.getNotDisplayedReason?.() ?? 'unknown'}`,
        });
      } else if (notif?.isSkippedMoment?.()) {
        clearTimeout(timer);
        finish({
          provider: 'google',
          error: `prompt_skipped:${notif.getSkippedReason?.() ?? 'unknown'}`,
        });
      }
    });
  });
}
