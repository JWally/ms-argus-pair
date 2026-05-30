/**
 * Client-side dual-scan co-attestation flow.
 *
 *   Desktop                                  Server                            Phone
 *   ─────────                                ──────                            ─────
 *   POST /api/session/start ──────────────►
 *      ◄────────────────  {sessionId, nonce, expiresAt}
 *   ─── QR rendered immediately ───
 *
 *   (background) argus.run({attest}) → POST /desktop-attest
 *
 *   ─── poll /api/session/{id}/result ───
 *
 *   (QR scanned)                                                                ─►
 *                                            GET /api/session/{id}/info ◄──────
 *                                              {nonce, desktopReady,
 *                                               desktopArgusSessionId,
 *                                               desktopKeyId}
 *                                            (poll if !desktopReady)
 *
 *                                            user taps "Proof of Life"
 *                                            Promise.all([
 *                                              navigator.credentials.create(...),
 *                                              argus.run({attest: {nonce, ...}}),
 *                                            ])
 *                                            POST /api/session/{id}/phone-attest
 *      ◄────────────────  poll result      { argusSessionId, attestation, webauthn }
 *                                          → {verdict, reason, annotations}
 *
 * WebAuthn rides as a sibling field in the phone-attest POST body (not
 * inside the Argus envelope payload), so the WebAuthn ceremony and the
 * Argus scan can run concurrently. Both bind to the same server-issued
 * nonce so the proofs stay tied to this specific session.
 */

const API = '/api';
const ATTEST_PURPOSE = 'argus-pair-v1';
const ATTEST_TTL_SECONDS = 120;
const ARGUS_CPI =
  (import.meta.env.VITE_MERCHANT_CPI as string | undefined) ??
  'argus_cpi_test_UEeqk7Bk7uetxKKDxNmIdB';

interface ArgusAttestation {
  envelope: string;
  signature: string;
  publicKey: string;
  keyId: string;
}

interface ArgusRunResult {
  sessionId: string | null;
  argusSessionId: string;
  durationMs: number;
  attestation?: ArgusAttestation | null;
  attestError?: string | null;
}

interface ArgusGlobal {
  run(opts: {
    sessionId?: string;
    cpi?: string;
    timeoutMs?: number;
    attest?: { purpose: string; payload?: unknown; ttlSeconds?: number };
  }): Promise<ArgusRunResult>;
}

declare global {
  interface Window {
    argus?: ArgusGlobal;
  }
}

function getArgus(): ArgusGlobal {
  if (!window.argus) {
    throw new Error('argus SDK not loaded (argus-loader.iife.js missing or blocked)');
  }
  return window.argus;
}

/** Carries the HTTP status so callers can branch on specific codes. */
class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly bodyText: string,
    public readonly bodyJson: Record<string, unknown> | null,
    message: string
  ) {
    super(message);
  }
}

async function jsonFetch<T>(input: string, init?: RequestInit): Promise<T> {
  const url = `${input}${input.includes('?') ? '&' : '?'}_=${Date.now()}`;
  const res = await fetch(url, {
    ...init,
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  });
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    const snip = (await res.text()).slice(0, 80).replace(/\s+/g, ' ');
    throw new HttpError(
      res.status,
      snip,
      null,
      `${init?.method || 'GET'} ${input} → ${res.status} non-JSON: ${snip}`
    );
  }
  if (!res.ok) {
    const body = await res.text();
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(body) as Record<string, unknown>;
    } catch {
      /* not JSON despite content-type — leave parsed null */
    }
    throw new HttpError(
      res.status,
      body,
      parsed,
      `${init?.method || 'GET'} ${input} → ${res.status} ${body.slice(0, 200)}`
    );
  }
  return res.json() as Promise<T>;
}

export interface DesktopAttestedSummary {
  clean: boolean;
  summary: {
    score?: number;
    pat_attested?: boolean;
    is_proxy?: boolean;
    is_datacenter?: boolean;
    is_vpn?: boolean;
    is_mobile_network?: boolean;
    browser_name?: string | null;
    browser_version?: string | null;
    os?: string | null;
    ip?: string | null;
    asn_name?: string | null;
    city?: string | null;
    country?: string | null;
  } | null;
}

export interface PairEvents {
  onStatus?: (status: string) => void;
  onError?: (err: unknown) => void;
  onDesktopAttested?: (info: DesktopAttestedSummary) => void;
}

// ── HOST (desktop) ───────────────────────────────────────────────────────

export interface DesktopSession {
  sessionId: string;
  pairUrl: string;
  expiresAt: number;
  stop: () => void;
  result: Promise<{
    verdict: string;
    reason: string | null;
    annotations?: Record<string, unknown>;
  }>;
}

const RESULT_POLL_MS = 1000;

export async function startDesktopSession(events: PairEvents = {}): Promise<DesktopSession> {
  events.onStatus?.('starting session');
  const session = await jsonFetch<{
    sessionId: string;
    nonce: string;
    expiresAt: number;
  }>(`${API}/session/start`, { method: 'POST' });

  // QR always points to the canonical argus host (env-pinned at build
  // time via VITE_PAIR_URL_BASE). This keeps the phone's WebAuthn rpId
  // stable across alias domains — a credential created at the argus
  // host can be redeemed regardless of which alias the desktop loaded
  // from. Falls back to window.location.origin for local dev.
  const pairOrigin =
    (import.meta.env.VITE_PAIR_URL_BASE as string | undefined) ?? window.location.origin;
  const pairUrl = `${pairOrigin}/pair/${session.sessionId}`;
  events.onStatus?.('waiting for phone');

  // Scan + desktop-attest run in the BACKGROUND so the QR can render
  // immediately. The phone polls /info until desktopReady, so a phone
  // that arrives before the desktop scan finishes just waits.
  let cancelled = false;
  let scanError: Error | null = null;
  (async () => {
    try {
      const argus = getArgus();
      const run = await argus.run({
        cpi: ARGUS_CPI,
        timeoutMs: 30_000,
        attest: {
          purpose: ATTEST_PURPOSE,
          ttlSeconds: ATTEST_TTL_SECONDS,
          payload: {
            sessionId: session.sessionId,
            nonce: session.nonce,
            role: 'desktop',
          },
        },
      });
      if (!run.attestation) {
        throw new Error(`argus attestation failed: ${run.attestError ?? 'no attestation'}`);
      }
      if (cancelled) return;
      const attResp = await jsonFetch<{
        ok: boolean;
        clean?: boolean;
        summary?: DesktopAttestedSummary['summary'];
      }>(`${API}/session/${session.sessionId}/desktop-attest`, {
        method: 'POST',
        body: JSON.stringify({
          argusSessionId: run.argusSessionId,
          attestation: run.attestation,
        }),
      });
      events.onDesktopAttested?.({
        clean: !!attResp.clean,
        summary: attResp.summary ?? null,
      });
    } catch (e) {
      scanError = e as Error;
      events.onError?.(e);
    }
  })();

  const result = new Promise<{
    verdict: string;
    reason: string | null;
    annotations?: Record<string, unknown>;
  }>((resolve, reject) => {
    const tick = async () => {
      if (cancelled) return;
      if (scanError) {
        reject(scanError);
        return;
      }
      try {
        // 204 = still pending; 200+JSON = real verdict.
        const url = `${API}/session/${session.sessionId}/result?_=${Date.now()}`;
        const res = await fetch(url, {
          cache: 'no-store',
          headers: { Accept: 'application/json' },
        });
        if (res.status === 204) {
          if (Date.now() / 1000 > session.expiresAt) {
            reject(new Error('session expired'));
            return;
          }
          window.setTimeout(tick, RESULT_POLL_MS);
          return;
        }
        if (!res.ok) {
          throw new Error(`poll → ${res.status}`);
        }
        const ct = res.headers.get('content-type') || '';
        if (!ct.includes('application/json')) {
          const snip = (await res.text()).slice(0, 80);
          throw new Error(`poll → non-JSON: ${snip}`);
        }
        resolve(
          (await res.json()) as {
            verdict: string;
            reason: string | null;
            annotations?: Record<string, unknown>;
          }
        );
      } catch (e) {
        events.onError?.(e);
        reject(e);
      }
    };
    tick();
  });

  return {
    sessionId: session.sessionId,
    pairUrl,
    expiresAt: session.expiresAt,
    stop: () => {
      cancelled = true;
    },
    result,
  };
}

// ── CLIENT (phone) ───────────────────────────────────────────────────────

export interface PhoneSessionInfo {
  nonce: string;
  expiresAt: number;
  desktopArgusSessionId: string;
  desktopKeyId: string;
}

/**
 * Poll /info until desktopReady (with timeout). Called on mount so by the
 * time the user taps "Proof of Life" the data is already in hand and we
 * can start WebAuthn + the Argus scan immediately in parallel.
 */
export async function awaitDesktopReady(
  sessionId: string,
  signal?: AbortSignal
): Promise<PhoneSessionInfo> {
  const POLL_MS = 500;
  const HARD_TIMEOUT_MS = 60_000;
  const startedAt = Date.now();
  while (true) {
    if (signal?.aborted) throw new Error('aborted');
    const info = await jsonFetch<{
      nonce?: string;
      expiresAt?: number;
      desktopReady?: boolean;
      desktopArgusSessionId?: string;
      desktopKeyId?: string;
      expired?: boolean;
    }>(`${API}/session/${sessionId}/info`);
    if (info.expired) throw new Error('session expired');
    if (info.desktopReady && info.desktopArgusSessionId && info.desktopKeyId && info.nonce) {
      return {
        nonce: info.nonce,
        expiresAt: info.expiresAt ?? 0,
        desktopArgusSessionId: info.desktopArgusSessionId,
        desktopKeyId: info.desktopKeyId,
      };
    }
    if (Date.now() - startedAt > HARD_TIMEOUT_MS) {
      throw new Error("desktop didn't finish scanning in time");
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

async function runProofOfLife(nonceB64Url: string): Promise<unknown | { error: string }> {
  try {
    const { startRegistration } = await import('@simplewebauthn/browser');
    const rpId = window.location.hostname;
    const result = await startRegistration({
      optionsJSON: {
        challenge: nonceB64Url,
        rp: { id: rpId, name: 'Argus Pair' },
        user: {
          id: nonceB64Url,
          name: 'ephemeral',
          displayName: 'Argus Proof of Life',
        },
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 },
        ],
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          residentKey: 'discouraged',
          requireResidentKey: false,
          userVerification: 'required',
        },
        attestation: 'direct',
        timeout: 60_000,
      },
    });
    return result;
  } catch (e) {
    return { error: (e as Error).message };
  }
}

interface AttestResponse {
  verdict: string;
  reason: string | null;
  annotations?: Record<string, unknown>;
  nextDeviceTrust?: string | null;
}

/**
 * Run the phone's side of the attestation. Two paths:
 *
 *   - If a valid device-trust token is in IndexedDB, attempt the silent
 *     path: Argus scan only, no WebAuthn ceremony. Server verifies the
 *     token (strict IP-pin) and waves WebAuthn. Token rejection (any
 *     reason — expired / IP changed / bad HMAC) → server returns 401,
 *     we clear the token and fall through to fresh WebAuthn.
 *
 *   - Otherwise (or after a failed redeem): WebAuthn + Argus in
 *     parallel, original Promise.allSettled flow. On success, server
 *     returns nextDeviceTrust which we persist for the next visit.
 */
export interface SubmitPhoneAttestationOptions {
  /**
   * Proof-of-life mode. Default `"webauthn"` runs the platform
   * authenticator ceremony. `"oauth"` skips WebAuthn and expects the
   * caller to have already completed the OAuth flow — pass the result
   * via `oauthResult`. Server-side verification happens identically:
   * proof-of-life is set if either path completes.
   */
  mode?: 'webauthn' | 'oauth';
  /** When `mode === "oauth"`, the result from one of the
   *  `runOAuthProofOfLife(...)` calls in `src/lib/oauth.ts`. */
  oauthResult?: { provider: 'google' | 'github' | 'facebook'; token: string };
}

export async function submitPhoneAttestation(
  sessionId: string,
  info: PhoneSessionInfo,
  events: PairEvents = {},
  options: SubmitPhoneAttestationOptions = {}
): Promise<AttestResponse> {
  const argus = getArgus();

  // ── Silent redeem path ─────────────────────────────────────────
  const { loadTrustToken, saveTrustToken, clearTrustToken } = await import('./device-trust');
  const trustToken = await loadTrustToken();
  if (trustToken) {
    events.onStatus?.('welcome back — verifying');
    try {
      const run = await argus.run({
        cpi: ARGUS_CPI,
        timeoutMs: 30_000,
        attest: {
          purpose: ATTEST_PURPOSE,
          ttlSeconds: ATTEST_TTL_SECONDS,
          payload: {
            sessionId,
            nonce: info.nonce,
            role: 'phone',
            desktopArgusSessionId: info.desktopArgusSessionId,
            desktopKeyId: info.desktopKeyId,
          },
        },
      });
      if (run.attestation) {
        try {
          const r = await jsonFetch<AttestResponse>(`${API}/session/${sessionId}/phone-attest`, {
            method: 'POST',
            body: JSON.stringify({
              argusSessionId: run.argusSessionId,
              attestation: run.attestation,
              deviceTrustToken: trustToken,
            }),
          });
          if (r.nextDeviceTrust) await saveTrustToken(r.nextDeviceTrust);
          return r;
        } catch (postErr) {
          if (postErr instanceof HttpError) {
            // 409 already_attested: this device already paired in this
            // session (likely a retried request whose first response was
            // lost). Treat as success — fetch the existing verdict.
            if (postErr.status === 409 && postErr.bodyJson?.error === 'already_attested') {
              const fallback = await jsonFetch<AttestResponse>(
                `${API}/session/${sessionId}/result`,
                { method: 'GET' }
              );
              return fallback;
            }
            if (postErr.status === 401) {
              await clearTrustToken();
              events.onStatus?.('trust expired — re-verifying');
            } else {
              await clearTrustToken();
              events.onStatus?.('falling back to webauthn');
            }
          } else {
            throw postErr;
          }
        }
      }
    } catch (e) {
      events.onError?.(e);
      await clearTrustToken();
      events.onStatus?.('falling back to webauthn');
    }
  }

  // ── Fresh proof-of-life + Argus parallel path ───────────────────
  // Proof-of-life slot is filled either by WebAuthn (default — runs in
  // parallel with the Argus scan) or by an OAuth result the caller
  // already obtained. OAuth flows can't run in parallel with the Argus
  // scan because the OAuth UI takes user focus, so OAuth runs FIRST
  // (caller's responsibility), THEN we do the Argus scan.
  events.onStatus?.('proof of life + integrity scan');
  const useOAuth = options.mode === 'oauth';

  const webauthnPromise: Promise<unknown | { error: string }> = useOAuth
    ? Promise.resolve({ error: 'mode_oauth_skipped' })
    : runProofOfLife(info.nonce);

  const argusPromise = argus.run({
    cpi: ARGUS_CPI,
    timeoutMs: 30_000,
    attest: {
      purpose: ATTEST_PURPOSE,
      ttlSeconds: ATTEST_TTL_SECONDS,
      payload: {
        sessionId,
        nonce: info.nonce,
        role: 'phone',
        desktopArgusSessionId: info.desktopArgusSessionId,
        desktopKeyId: info.desktopKeyId,
      },
    },
  });

  const [webauthnSettled, runSettled] = await Promise.allSettled([webauthnPromise, argusPromise]);

  if (runSettled.status !== 'fulfilled') {
    throw runSettled.reason;
  }
  const run = runSettled.value;
  if (!run.attestation) {
    throw new Error(`argus attestation failed: ${run.attestError ?? 'no attestation'}`);
  }
  const webauthn =
    webauthnSettled.status === 'fulfilled'
      ? webauthnSettled.value
      : { error: (webauthnSettled.reason as Error).message };

  events.onStatus?.('submitting');
  try {
    const r = await jsonFetch<AttestResponse>(`${API}/session/${sessionId}/phone-attest`, {
      method: 'POST',
      body: JSON.stringify({
        argusSessionId: run.argusSessionId,
        attestation: run.attestation,
        webauthn,
        ...(useOAuth && options.oauthResult ? { oauth: options.oauthResult } : {}),
      }),
    });
    if (r.nextDeviceTrust) await saveTrustToken(r.nextDeviceTrust);
    return r;
  } catch (e) {
    // Session is already paired (a prior request from this device succeeded
    // server-side even if the response was lost or retried). Treat as
    // success: fetch the existing verdict from /result instead of bubbling
    // the error up. Without this, transient network retries or double-fire
    // touch events on mobile make the phone show "Something went wrong"
    // even though the desktop sees the pairing succeed.
    if (e instanceof HttpError && e.status === 409 && e.bodyJson?.error === 'already_attested') {
      const fallback = await jsonFetch<AttestResponse>(`${API}/session/${sessionId}/result`, {
        method: 'GET',
      });
      return fallback;
    }
    throw e;
  }
}

// ── Raffle / leaderboard ─────────────────────────────────────────────────

export interface RaffleEntryResult {
  ok: true;
  /** Short public identifier (`xxxx-xxxx`) derived from the email hash. */
  code: string;
  count: number;
}

export interface LeaderboardRow {
  /** Short public identifier (`xxxx-xxxx`). The plaintext email is never returned. */
  code: string;
  count: number;
  lastEntryAt: number;
}

/**
 * Claim a leaderboard entry against a paired sessionId. Server runs three
 * rate-limit buckets (phone pubkey, desktop pubkey, UA+IP) — any of them
 * tripping returns 429. A paired session is single-use; the second submit
 * for the same sessionId returns 409.
 */
export async function submitRaffleEntry(
  sessionId: string,
  handle: string
): Promise<RaffleEntryResult> {
  return jsonFetch<RaffleEntryResult>(`${API}/raffle/entry`, {
    method: 'POST',
    body: JSON.stringify({ sessionId, handle: handle.trim().toLowerCase() }),
  });
}

export async function fetchLeaderboard(): Promise<LeaderboardRow[]> {
  const r = await jsonFetch<{ leaderboard: LeaderboardRow[] }>(`${API}/raffle/leaderboard`);
  return r.leaderboard;
}

export type RaffleStatus =
  | { status: 'ok'; used?: number; cap?: number; resetAt?: number; site?: string }
  | { status: 'rate_limited'; used: number; cap: number; resetAt: number; site: string }
  | { status: 'already_entered'; code: string }
  | { status: 'not_paired'; verdict?: string };

/**
 * Read-only probe of whether the current session can submit a raffle
 * entry right now. Used by the desktop UI to hide the form when the
 * caller has already hit their cap, instead of letting them fill it
 * in only to bonk with a 429. On any network/parse failure, callers
 * should default to showing the form — the entry endpoint will
 * return the real error.
 */
export async function fetchRaffleStatus(sessionId: string): Promise<RaffleStatus> {
  return jsonFetch<RaffleStatus>(`${API}/raffle/status/${sessionId}`);
}

export { HttpError };
