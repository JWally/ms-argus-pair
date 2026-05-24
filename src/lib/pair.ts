/**
 * Client-side dual-scan co-attestation flow.
 *
 * Replaces the previous WebRTC pairing logic. Each side runs a full Argus
 * integrity scan and signs an envelope binding (sessionId, nonce, role,
 * peer-info) with the SDK's persistent device key. Server verifies both
 * envelopes + cross-references the Argus scan tokens.
 *
 *   Desktop                                  Server                            Phone
 *   ─────────                                ──────                            ─────
 *   POST /api/session/start ──────────────►
 *      ◄────────────────  {sessionId, nonce, expiresAt}
 *   argus.run({attest: {purpose, payload}}) → {argusSessionId, attestation}
 *   POST /api/session/{id}/desktop-attest ──►
 *   poll  /api/session/{id}/result ────────►
 *
 *   (QR with /pair/{sessionId})                                                scans
 *                                            GET /api/session/{id}/info ◄──────
 *                                              {nonce, expiresAt,
 *                                               desktopReady}
 *                                            argus.run({attest: {...
 *                                              desktopArgusSessionId,
 *                                              desktopKeyId}}) →
 *                                              {argusSessionId, attestation}
 *                                            POST /api/session/{id}/phone-attest ◄──
 *      ◄────────────────  poll result      {verdict, reason}
 *
 * The phone's payload binds itself to the host's argusSessionId + keyId so a
 * third party who snooped the QR can't swap in their own desktop scan.
 */

const API = '/api';
const ATTEST_PURPOSE = 'argus-pair-v1';
const ATTEST_TTL_SECONDS = 120;
// Public CPI for the captcha demo. Baked into the bundle — CPIs are public-safe
// (they're the merchant identifier on the integrity-collect request). Bumped
// to the test CPI from CLAUDE.md memory; swap for prod when ready.
const ARGUS_CPI = 'argus_cpi_test_b9UX4lEWFto8KHIeYlw5L4';

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
  /** Resolves to the final verdict once the phone completes pairing. */
  result: Promise<{ verdict: string; reason: string | null }>;
}

const RESULT_POLL_MS = 1000;

export async function startDesktopSession(events: PairEvents = {}): Promise<DesktopSession> {
  events.onStatus?.('starting session');
  const session = await jsonFetch<{
    sessionId: string;
    nonce: string;
    expiresAt: number;
  }>(`${API}/session/start`, { method: 'POST' });

  events.onStatus?.('running argus scan');
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

  events.onStatus?.('submitting attestation');
  await jsonFetch(`${API}/session/${session.sessionId}/desktop-attest`, {
    method: 'POST',
    body: JSON.stringify({
      argusSessionId: run.argusSessionId,
      attestation: run.attestation,
    }),
  });

  events.onStatus?.('waiting for phone');
  const pairUrl = `${window.location.origin}/pair/${session.sessionId}`;

  let cancelled = false;
  const result = new Promise<{ verdict: string; reason: string | null }>((resolve, reject) => {
    const tick = async () => {
      if (cancelled) return;
      try {
        const r = await jsonFetch<{ verdict: string; reason: string | null }>(
          `${API}/session/${session.sessionId}/result`
        );
        if (r.verdict === 'pending') {
          if (Date.now() / 1000 > session.expiresAt) {
            reject(new Error('session expired'));
            return;
          }
          window.setTimeout(tick, RESULT_POLL_MS);
          return;
        }
        resolve(r);
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

export async function completePhoneSession(
  sessionId: string,
  events: PairEvents = {}
): Promise<{ verdict: string; reason: string | null }> {
  events.onStatus?.('looking up session');
  const info = await jsonFetch<{
    nonce?: string;
    expiresAt?: number;
    desktopReady?: boolean;
    verdict?: string;
    expired?: boolean;
    desktopArgusSessionId?: string;
    desktopKeyId?: string;
  }>(`${API}/session/${sessionId}/info`);

  if (info.expired) throw new Error('session expired');
  if (!info.desktopReady || !info.desktopArgusSessionId || !info.desktopKeyId) {
    throw new Error("desktop hasn't completed its scan yet — retry shortly");
  }
  if (info.verdict && info.verdict !== 'pending') {
    return { verdict: info.verdict, reason: 'already_decided' };
  }

  events.onStatus?.('running argus scan');
  const argus = getArgus();
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
        // Binding the phone's signed envelope to the desktop's identity is
        // what stops someone snooping the QR from swapping in their own
        // desktop scan: phone signs over desktopArgusSessionId + keyId, so
        // the server can verify those match what the host actually posted.
        // The phone learned these via /info — server-anchored, phone can't
        // forge them.
        desktopArgusSessionId: info.desktopArgusSessionId,
        desktopKeyId: info.desktopKeyId,
      },
    },
  });
  if (!run.attestation) {
    throw new Error(`argus attestation failed: ${run.attestError ?? 'no attestation'}`);
  }

  events.onStatus?.('submitting attestation');
  const verdict = await jsonFetch<{ verdict: string; reason: string | null }>(
    `${API}/session/${sessionId}/phone-attest`,
    {
      method: 'POST',
      body: JSON.stringify({
        argusSessionId: run.argusSessionId,
        attestation: run.attestation,
      }),
    }
  );

  return verdict;
}
