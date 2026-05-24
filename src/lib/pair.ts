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
    throw new Error(`${init?.method || 'GET'} ${input} → ${res.status} non-JSON: ${snip}`);
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${init?.method || 'GET'} ${input} → ${res.status} ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

export interface PairEvents {
  onStatus?: (status: string) => void;
  onError?: (err: unknown) => void;
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

  const pairUrl = `${window.location.origin}/pair/${session.sessionId}`;
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
      await jsonFetch(`${API}/session/${session.sessionId}/desktop-attest`, {
        method: 'POST',
        body: JSON.stringify({
          argusSessionId: run.argusSessionId,
          attestation: run.attestation,
        }),
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
export async function submitPhoneAttestation(
  sessionId: string,
  info: PhoneSessionInfo,
  events: PairEvents = {}
): Promise<AttestResponse> {
  const argus = getArgus();

  // ── Silent redeem path ─────────────────────────────────────────
  const { loadTrustToken, saveTrustToken, clearTrustToken } = await import(
    './device-trust'
  );
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
        const url = `${API}/session/${sessionId}/phone-attest?_=${Date.now()}`;
        const res = await fetch(url, {
          method: 'POST',
          cache: 'no-store',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            argusSessionId: run.argusSessionId,
            attestation: run.attestation,
            deviceTrustToken: trustToken,
          }),
        });
        if (res.ok) {
          const r = (await res.json()) as AttestResponse;
          if (r.nextDeviceTrust) await saveTrustToken(r.nextDeviceTrust);
          return r;
        }
        if (res.status === 401) {
          // Token rejected — strict IP pin or expiry or pubkey mismatch.
          // Clear stale token and fall through to fresh WebAuthn.
          await clearTrustToken();
          events.onStatus?.('trust expired — re-verifying');
        } else {
          // Other error — fall through to fresh WebAuthn too, since trust
          // path is meant to be best-effort.
          await clearTrustToken();
          events.onStatus?.('falling back to webauthn');
        }
      }
    } catch (e) {
      events.onError?.(e);
      await clearTrustToken();
      events.onStatus?.('falling back to webauthn');
    }
  }

  // ── Fresh WebAuthn + Argus parallel path ───────────────────────
  events.onStatus?.('proof of life + integrity scan');
  // Both run in parallel. WebAuthn waits on the user; Argus runs the full
  // scan. allSettled — if WebAuthn fails (declined / unsupported) the
  // Argus scan still completes and we submit with {webauthn:{error}}.
  const [webauthnSettled, runSettled] = await Promise.allSettled([
    runProofOfLife(info.nonce),
    argus.run({
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
    }),
  ]);

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
  const r = await jsonFetch<AttestResponse>(`${API}/session/${sessionId}/phone-attest`, {
    method: 'POST',
    body: JSON.stringify({
      argusSessionId: run.argusSessionId,
      attestation: run.attestation,
      webauthn,
    }),
  });
  if (r.nextDeviceTrust) await saveTrustToken(r.nextDeviceTrust);
  return r;
}
