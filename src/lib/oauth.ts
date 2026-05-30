/**
 * Client-side OAuth proof-of-life helpers for the pair demo.
 *
 * Each function drives the provider's standard OAuth dance and
 * returns an opaque token the pair backend can verify (Google ID
 * token, GitHub access token via PKCE, Facebook access token).
 *
 * Nonce/state binding: the pair `session.nonce` is passed in as
 * `expectedNonce` and each provider weaves it into the protocol —
 * OIDC `nonce` claim (Google), OAuth2 `state` parameter (GitHub,
 * Facebook). On callback the client checks the round-tripped state
 * before handing the token to the backend; backend re-checks nonce
 * for Google's ID token. Replay of a captured token from a different
 * pair session fails because each session.nonce is unique.
 *
 * This module is INTENTIONALLY UI-agnostic. Each provider call
 * pops the appropriate provider UX (Google One Tap sheet, GitHub
 * redirect popup, Facebook Login dialog). The Demo page wires the
 * buttons that invoke these.
 *
 * Build-time env vars:
 *   VITE_OAUTH_GOOGLE_CLIENT_ID   — Google OAuth 2.0 client ID
 *   VITE_OAUTH_GITHUB_CLIENT_ID   — GitHub OAuth App client ID
 *   VITE_OAUTH_FACEBOOK_APP_ID    — Facebook App ID
 *
 * Absent → the corresponding helper returns `{ error: '*_not_configured' }`
 * and the UI hides the button.
 */

export type OAuthProvider = 'google' | 'github' | 'facebook';

export interface OAuthResult {
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
const GITHUB_CLIENT_ID = (import.meta.env.VITE_OAUTH_GITHUB_CLIENT_ID as string | undefined) ?? '';
const FACEBOOK_APP_ID = (import.meta.env.VITE_OAUTH_FACEBOOK_APP_ID as string | undefined) ?? '';

export const PROVIDERS_CONFIGURED: Record<OAuthProvider, boolean> = {
  google: GOOGLE_CLIENT_ID.length > 0,
  github: GITHUB_CLIENT_ID.length > 0,
  facebook: FACEBOOK_APP_ID.length > 0,
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

// ─────────────────────────────────────────────────────────────────────────
// GitHub — PKCE in a popup. No client secret on the wire.
// ─────────────────────────────────────────────────────────────────────────

function randomB64Url(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let s = '';
  for (const b of buf) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256B64Url(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  const bytes = new Uint8Array(digest);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * GitHub OAuth via PKCE. State carries the pair nonce. The popup
 * redirects back to /oauth/github/callback (handled by an inline
 * <script> that postMessages the code back here). We exchange the
 * code for an access_token via GitHub's token endpoint (PKCE — no
 * client secret needed).
 *
 * SCAFFOLD: the popup wiring + callback page are TODO. This stub
 * returns `scaffold_not_wired_yet` so the rest of the pipeline can
 * be exercised with fake providers in tests.
 */
export async function runGithubProofOfLife(nonce: string): Promise<OAuthOutcome> {
  if (!PROVIDERS_CONFIGURED.github) {
    return { provider: 'github', error: 'github_not_configured' };
  }
  const codeVerifier = randomB64Url(32);
  const codeChallenge = await sha256B64Url(codeVerifier);
  void codeVerifier;
  void codeChallenge;
  void nonce;
  // SCAFFOLD: open popup at
  //   https://github.com/login/oauth/authorize
  //     ?client_id=${GITHUB_CLIENT_ID}
  //     &redirect_uri=${callbackOrigin}/oauth/github/callback
  //     &state=${nonce}
  //     &code_challenge=${codeChallenge}
  //     &code_challenge_method=S256
  //     &scope=read:user
  //
  // wait for postMessage from popup with { code, state }, verify
  // state === nonce, POST to /login/oauth/access_token with
  // {client_id, code, code_verifier, redirect_uri}, get access_token.
  return { provider: 'github', error: 'scaffold_not_wired_yet' };
}

// ─────────────────────────────────────────────────────────────────────────
// Facebook — JS SDK FB.login() dialog.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Facebook Login via the official JS SDK. State binding via the
 * `state` parameter on FB.login(). The dialog returns an access token
 * we hand to the backend; backend verifies via /debug_token.
 *
 * SCAFFOLD: SDK init + FB.login() invocation are TODO.
 */
export async function runFacebookProofOfLife(nonce: string): Promise<OAuthOutcome> {
  if (!PROVIDERS_CONFIGURED.facebook) {
    return { provider: 'facebook', error: 'facebook_not_configured' };
  }
  void nonce;
  // SCAFFOLD: load https://connect.facebook.net/en_US/sdk.js,
  //   FB.init({ appId: FACEBOOK_APP_ID, version: 'v22.0' }),
  //   FB.login(resp => { if (resp.authResponse) resolve(token) },
  //     { scope: 'public_profile', auth_nonce: nonce })
  return { provider: 'facebook', error: 'scaffold_not_wired_yet' };
}

// ─────────────────────────────────────────────────────────────────────────
// Dispatch
// ─────────────────────────────────────────────────────────────────────────

export function runOAuthProofOfLife(provider: OAuthProvider, nonce: string): Promise<OAuthOutcome> {
  switch (provider) {
    case 'google':
      return runGoogleProofOfLife(nonce);
    case 'github':
      return runGithubProofOfLife(nonce);
    case 'facebook':
      return runFacebookProofOfLife(nonce);
  }
}
