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

import { connectAndWhoami, openWs, type WsConnection } from './ws';

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

interface SessionStartResp {
  sessionId: string;
  nonce: string;
  expiresAt: number;
  ws: {
    url: string;
    desktopToken: string;
    phoneToken: string;
  };
}

interface VerdictShape {
  verdict: string;
  reason: string | null;
  annotations?: Record<string, unknown>;
}

export async function startDesktopSession(events: PairEvents = {}): Promise<DesktopSession> {
  events.onStatus?.('starting session');

  // Race the WS TCP+TLS handshake against the /session/start HTTP
  // round-trip. The WS URL is static per deploy (baked in at build via
  // VITE_PAIR_WS_URL), and $connect doesn't need a token — only whoami
  // does, and the token comes from the HTTP response. So we can open
  // the socket while the HTTP request is in-flight; the two latencies
  // overlap instead of stacking. Saves the WS-handshake hit (~50–
  // 200ms warm, ~450ms cold) on every fresh session.
  //
  // When VITE_PAIR_WS_URL is unset (local dev, legacy deploy), we fall
  // back to the serial path: wait for /session/start, then open WS.
  const staticWsUrl = import.meta.env.VITE_PAIR_WS_URL as string | undefined;
  const eagerWsPromise = staticWsUrl
    ? openWs(staticWsUrl).catch((e) => {
        // If the eager open fails (network blip, bad URL), fall back
        // to the post-HTTP open inside connectAndWhoami.
        console.warn('[argus-pair] eager ws open failed, falling back', e);
        return null;
      })
    : Promise.resolve(null);

  const [session, eagerWs] = await Promise.all([
    jsonFetch<SessionStartResp>(`${API}/session/start`, { method: 'POST' }),
    eagerWsPromise,
  ]);
  if (!session.ws?.url || !session.ws.desktopToken || !session.ws.phoneToken) {
    if (eagerWs) eagerWs.close();
    throw new Error('session/start did not return WebSocket bootstrap material');
  }

  // The WS URL in session.ws.url is what the server says. If our eager
  // socket is on a DIFFERENT URL (stale build env), discard the eager
  // socket and let connectAndWhoami open a fresh one against the
  // server-authoritative URL.
  const reuseEagerWs = eagerWs && eagerWs.url.startsWith(session.ws.url);
  if (eagerWs && !reuseEagerWs) eagerWs.close();

  const desktopConn = await connectAndWhoami({
    url: session.ws.url,
    token: session.ws.desktopToken,
    origin: window.location.origin,
    existingWs: reuseEagerWs ? eagerWs : undefined,
  });

  // QR points at the canonical argus host (env-pinned at build time via
  // VITE_PAIR_URL_BASE). Phone-side WebAuthn rpId stays stable across
  // alias domains.
  //
  // In production we REFUSE to fall back to window.location.origin —
  // that fallback silently produces a QR pointing at whatever alias
  // domain the desktop happened to be loaded from (e.g. qr.arcades.click
  // instead of captcha-dev-jw.argus.pw). Two prior incidents shipped
  // bad bundles because VITE_PAIR_URL_BASE didn't make it through the
  // deploy chain; failing loud here means a busted deploy is visible
  // instead of producing scannable-but-wrong QRs.
  //
  // Dev (vite dev / pre-push lint builds) keeps the fallback — the
  // build-time guard in vite.config.ts already short-circuits this when
  // PAIR_ALLOW_ORIGIN_FALLBACK=1 is acknowledged.
  const bakedOrigin = import.meta.env.VITE_PAIR_URL_BASE as string | undefined;
  if (import.meta.env.PROD && !bakedOrigin) {
    throw new Error(
      'pair: VITE_PAIR_URL_BASE is not baked into this build. QR would ' +
        'point at window.location.origin (alias-leak risk). Rebuild via ' +
        '`npm run deploy` so the env var is set from cdk/bin/print-pair-host.mjs.'
    );
  }
  const pairOrigin = bakedOrigin ?? window.location.origin;
  // Forward the desktop's `?debug=true` query param through the QR so
  // the phone-side flow can disable its silent-reauth auto-pass. Debug
  // mode is UI-only; does not relax server-side verification.
  const debugMode = new URLSearchParams(window.location.search).get('debug') === 'true';
  const debugParam = debugMode ? '?debug=true' : '';
  // The hash fragment carries the WS routing material end-to-end. Hash
  // fragments are NOT sent to the server in HTTP requests — they stay
  // client-side. Phone parses them on page load.
  // `n` (nonce) lets the phone start its argus.run() scan immediately
  // on arrival, in parallel with the desktop's scan, instead of waiting
  // for the desktop-ready WS message. desktopArgusSessionId and
  // desktopKeyId still arrive via desktop-ready and ship as top-level
  // POST body fields (no longer inside the phone's signed envelope).
  const pairHash = new URLSearchParams({
    wsUrl: session.ws.url,
    e: desktopConn.envelope,
    pt: session.ws.phoneToken,
    n: session.nonce,
  });
  const pairUrl = `${pairOrigin}/pair/${session.sessionId}${debugParam}#${pairHash.toString()}`;
  if (debugMode) {
    console.log('[argus-pair] pair URL:', pairUrl);
  }
  events.onStatus?.('waiting for phone');

  // Routing state. The peer envelope only arrives when the phone sends
  // its first peer message (phone-here); buffer desktopReady until both
  // sides are present.
  let cancelled = false;
  let scanError: Error | null = null;
  let phoneEnvelope: string | null = null;
  let bufferedReady: Record<string, unknown> | null = null;

  const sendReadyIfBothUp = () => {
    if (phoneEnvelope && bufferedReady) {
      desktopConn.sendPeer(phoneEnvelope, bufferedReady);
      bufferedReady = null;
    }
  };

  // Result promise — resolved by the server-pushed verdict arriving over
  // the WS. /phone-attest decrypts the desktopEnvelope it received from
  // the phone and PostToConnection's the verdict to this socket.
  let resolveResult!: (v: VerdictShape) => void;
  let rejectResult!: (e: unknown) => void;
  const result = new Promise<VerdictShape>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  desktopConn.onMessage((msg) => {
    if (cancelled) return;
    const data = msg.data as { kind?: string } | null;
    if (!data || typeof data.kind !== 'string') return;
    if (data.kind === 'phone-here') {
      phoneEnvelope = msg.fromEnvelope;
      sendReadyIfBothUp();
    } else if (data.kind === 'verdict') {
      // The WS handler stamps `from` server-side (relayed peer messages
      // get the sender's REAL role from their envelope; the verdict push
      // hard-codes 'server'). Phone-side script can't forge from:'server'
      // through the relay path — server overwrites whatever the sender
      // claims. Only accept verdict messages with from:'server' so a
      // compromised phone (or anyone holding the leaked QR) can't push
      // a fake `paired` verdict at the desktop UI.
      if ((msg as unknown as { from?: string }).from !== 'server') {
        console.warn(`[pair] dropping verdict with from=${msg.from} (not server)`);
        return;
      }
      resolveResult({
        verdict: (data as { verdict: string }).verdict,
        reason: (data as { reason: string | null }).reason ?? null,
        annotations: (data as { annotations?: Record<string, unknown> }).annotations,
      });
    }
  });

  // Bound the wait. Session TTL is 5 minutes — once the server-side row
  // is gone /phone-attest will 404 anyway and no verdict push will land,
  // so reject locally rather than spin forever.
  const expiryMs = Math.max(0, session.expiresAt * 1000 - Date.now());
  window.setTimeout(() => {
    if (cancelled) return;
    rejectResult(new Error('session expired'));
  }, expiryMs);

  // Background: scan + desktop-attest. When done, queue the desktop-
  // ready peer message (or send immediately if the phone is already up).
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
      bufferedReady = {
        kind: 'desktop-ready',
        nonce: session.nonce,
        expiresAt: session.expiresAt,
        desktopArgusSessionId: run.argusSessionId,
        desktopKeyId: run.attestation.keyId,
      };
      sendReadyIfBothUp();
    } catch (e) {
      scanError = e as Error;
      events.onError?.(e);
      rejectResult(e);
    }
  })();

  return {
    sessionId: session.sessionId,
    pairUrl,
    expiresAt: session.expiresAt,
    stop: () => {
      cancelled = true;
      desktopConn.close();
      if (scanError) {
        // Surface the still-buffered error if nothing else has resolved.
        rejectResult(scanError);
      }
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
  /**
   * Sealed envelope addressing the desktop's WebSocket connection.
   * The phone forwards it to /phone-attest so the server can PostToConnection
   * the verdict straight back to the desktop instead of having the desktop
   * poll /result.
   */
  desktopEnvelope: string;
  /** Live WS connection the phone opened to receive `desktop-ready`. */
  conn: WsConnection;
  /**
   * Argus scan started at connect-time, before the user even taps the
   * verify button. Resolves once the phone's own integrity scan
   * completes (~3s on most networks). Awaited at POST time so phone
   * arrival → user tap → submit doesn't serialise the scan after the
   * tap. Signed payload only binds {sessionId, nonce, role: phone} —
   * desktopArgusSessionId/desktopKeyId travel as unsigned top-level
   * body fields and are validated server-side against storage.
   */
  scanPromise: Promise<ArgusRunResult>;
}

interface PairHashParams {
  wsUrl: string;
  desktopEnvelope: string;
  phoneToken: string;
  nonce: string;
}

function parsePairHash(): PairHashParams {
  const raw = window.location.hash.replace(/^#/, '');
  const params = new URLSearchParams(raw);
  const wsUrl = params.get('wsUrl');
  const e = params.get('e');
  const pt = params.get('pt');
  const n = params.get('n');
  if (!wsUrl || !e || !pt || !n) {
    throw new Error('pair URL is missing WebSocket routing material in the fragment — open via QR');
  }
  return { wsUrl, desktopEnvelope: e, phoneToken: pt, nonce: n };
}

/**
 * WebSocket handshake replacing the old /info polling loop. Phone arrives
 * via QR, parses the hash fragment for {wsUrl, desktopEnvelope, phoneToken},
 * opens its own WS connection, announces itself to the desktop with a
 * `phone-here` peer message, and blocks until the desktop relays back
 * `desktop-ready` (which carries the same fields /info used to return).
 *
 * The desktop's envelope arrives in `fromEnvelope` on EVERY peer message
 * the desktop sends — but we capture it once up front from the QR so the
 * phone can address /phone-attest's server-side push before the first
 * peer message round-trips.
 */
export async function awaitDesktopReady(
  sessionId: string,
  signal?: AbortSignal
): Promise<PhoneSessionInfo> {
  if (signal?.aborted) throw new Error('aborted');
  const { wsUrl, desktopEnvelope, phoneToken, nonce } = parsePairHash();

  const conn = await connectAndWhoami({
    url: wsUrl,
    token: phoneToken,
    origin: window.location.origin,
  });

  if (signal?.aborted) {
    conn.close();
    throw new Error('aborted');
  }
  const onAbort = () => conn.close();
  signal?.addEventListener('abort', onAbort);

  // Kick the phone's argus scan off RIGHT NOW, before we even wait for
  // desktop-ready. The scan needs nonce (came in the QR hash) but NOT
  // desktopArgusSessionId/desktopKeyId — those are no longer signed
  // into the envelope; they ship as top-level POST body fields. So the
  // ~3s phone scan can overlap with the desktop's own scan instead of
  // strictly following it.
  const argus = getArgus();
  const scanPromise = argus.run({
    cpi: ARGUS_CPI,
    timeoutMs: 30_000,
    attest: {
      purpose: ATTEST_PURPOSE,
      ttlSeconds: ATTEST_TTL_SECONDS,
      payload: {
        sessionId,
        nonce,
        role: 'phone',
      },
    },
  });
  // Surface scan errors lazily — if no one ever awaits `scanPromise`
  // (e.g. user closed the tab before tapping), the runtime would log
  // an unhandled-rejection warning. This .catch keeps the rejection
  // attached without consuming it; the eventual awaiter still sees it.
  scanPromise.catch(() => {
    /* surfaced by the awaiter inside submitPhoneAttestation */
  });

  try {
    // Tell the desktop we're here. Server auto-includes our envelope on
    // the relayed message so the desktop can address us back.
    conn.sendPeer(desktopEnvelope, { kind: 'phone-here' });

    const msg = await conn.waitForMessage((m) => {
      const d = m.data as { kind?: string } | null;
      return d?.kind === 'desktop-ready';
    }, 60_000);

    const data = msg.data as {
      nonce: string;
      expiresAt: number;
      desktopArgusSessionId: string;
      desktopKeyId: string;
    };
    return {
      nonce: data.nonce,
      expiresAt: data.expiresAt,
      desktopArgusSessionId: data.desktopArgusSessionId,
      desktopKeyId: data.desktopKeyId,
      desktopEnvelope,
      conn,
      scanPromise,
    };
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * localStorage hint flag — set after a successful registration so the
 * next visit knows whether to call get() (authentication) or create()
 * (registration). There's no client-side WebAuthn API to ask "does this
 * RP own any of my passkeys?" — privacy-driven omission — so we trade
 * server-side certainty for a single-source-of-truth client flag.
 *
 * Mismatches (flag set but the passkey was deleted from keychain, or
 * flag absent but the credential is still synced) self-heal: the
 * authentication path catches the iOS rejection and immediately falls
 * through to registration. Worst case is one extra dialog on the rare
 * recovery path.
 */
/**
 * localStorage records: have we successfully registered before, and
 * which credentialId? Used to (a) decide which button to show on the
 * phone (CREATE vs USE), and (b) pass an explicit `allowCredentials`
 * on the authentication path so iOS pre-selects the right passkey
 * instead of showing the generic "No passkeys for this site" sheet
 * when something's off.
 *
 * There's no client-side WebAuthn API to ask "does this RP own any of
 * my passkeys?" — privacy-driven omission — so the localStorage flag
 * is the best signal we have. Mismatches (flag set but the passkey
 * was deleted, or flag absent but the credential is still synced)
 * are recoverable: the user picks the wrong button, the OS errors out
 * clearly, they pick the other one.
 */
const PASSKEY_HINT_KEY = 'argus-pair:passkey-registered';
const PASSKEY_CRED_ID_KEY = 'argus-pair:passkey-credential-id';

export function hasPasskeyHint(): boolean {
  try {
    return window.localStorage.getItem(PASSKEY_HINT_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Clear the passkey hint so the next button screen offers CREATE
 * PASSKEY instead of USE PASSKEY. Called from Pair.tsx when the
 * server reports the stored credential isn't recognized server-side
 * (the classic stuck-hint failure mode after a registration-time
 * rpId mismatch).
 */
export function clearPasskeyHint(): void {
  writePasskeyHint(null);
}

function readCredentialId(): string | null {
  try {
    return window.localStorage.getItem(PASSKEY_CRED_ID_KEY);
  } catch {
    return null;
  }
}

function writePasskeyHint(credentialId: string | null): void {
  try {
    if (credentialId) {
      window.localStorage.setItem(PASSKEY_HINT_KEY, '1');
      window.localStorage.setItem(PASSKEY_CRED_ID_KEY, credentialId);
    } else {
      window.localStorage.removeItem(PASSKEY_HINT_KEY);
      window.localStorage.removeItem(PASSKEY_CRED_ID_KEY);
    }
  } catch {
    /* private mode / disabled storage — silent */
  }
}

/**
 * Authenticate using the previously-saved passkey. Looks up the
 * credentialId in localStorage and passes it via `allowCredentials`
 * so iOS knows exactly which passkey to surface — bypasses the
 * confusing "No passkeys available" generic sheet when something's
 * gone wrong.
 */
async function authenticateExistingPasskey(
  nonceB64Url: string
): Promise<unknown | { error: string }> {
  const { startAuthentication } = await import('@simplewebauthn/browser');
  const rpId = window.location.hostname;
  const credentialId = readCredentialId();
  try {
    return await startAuthentication({
      optionsJSON: {
        challenge: nonceB64Url,
        rpId,
        userVerification: 'required',
        timeout: 60_000,
        allowCredentials: credentialId ? [{ id: credentialId, type: 'public-key' }] : undefined,
      },
    });
  } catch (e) {
    // Hint was wrong (deleted from keychain, never actually synced,
    // user cancelled). Clear localStorage so next attempt offers
    // CREATE PASSKEY instead of USE.
    writePasskeyHint(null);
    return { error: (e as Error).message };
  }
}

/**
 * Create a fresh resident passkey. iOS/Android writes it to iCloud
 * Keychain / Google Password Manager so subsequent visits can
 * authenticate without re-registering.
 */
async function createNewPasskey(nonceB64Url: string): Promise<unknown | { error: string }> {
  const { startRegistration } = await import('@simplewebauthn/browser');
  const rpId = window.location.hostname;
  try {
    // user.id must be valid base64url after SimpleWebAuthn decodes it
    // (iOS Safari rejects non-base64url strings with "invalid characters").
    // Encoding the rpId gives us a value that is:
    //   - valid base64url (no dots, no slashes, no padding)
    //   - stable per host (so repeat registrations on the same device
    //     dedupe in the OS-managed passkey store)
    //   - distinct per host (no privacy leak across hosts)
    const userIdB64Url = btoa(rpId).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const result = await startRegistration({
      optionsJSON: {
        challenge: nonceB64Url,
        rp: { id: rpId, name: 'Argus Pair' },
        user: {
          id: userIdB64Url,
          name: 'pair',
          displayName: 'Argus Pair',
        },
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 },
        ],
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          // 'preferred' so iOS/Android persists the credential.
          residentKey: 'preferred',
          requireResidentKey: false,
          userVerification: 'required',
        },
        // 'none' — Apple/Google strip attestation on platform passkeys
        // anyway, so 'direct' just adds latency without buying trust.
        attestation: 'none',
        timeout: 60_000,
      },
    });
    // We DELIBERATELY do not write the passkey hint here. Earlier
    // versions optimistically wrote it the moment WebAuthn.create()
    // returned a credential, before the server confirmed it stored
    // the registration. When server-side registration failed (rpId
    // mismatch from a mis-deployed QR origin), the hint stuck and
    // every future visit hit USE PASSKEY against a credential the
    // server never stored → permanent credential_not_registered loop.
    //
    // Now the hint is written by the caller AFTER a paired verdict —
    // see submitPhoneAttestation's post-response branch.
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
   * Proof-of-life mode.
   *   - `"passkey-create"`  → registration ceremony (CREATE button)
   *   - `"passkey-auth"`    → authentication ceremony (USE button)
   *   - `"oauth"`           → caller already ran OAuth, pass `oauthResult`
   * Server-side verification handles all three identically as
   * proof-of-life signals.
   */
  mode?: 'passkey-create' | 'passkey-auth' | 'oauth';
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
  // ── Silent redeem path ─────────────────────────────────────────
  const { loadTrustToken, saveTrustToken, clearTrustToken } = await import('./device-trust');
  const trustToken = await loadTrustToken();
  if (trustToken) {
    events.onStatus?.('welcome back — verifying');
    try {
      // Scan was kicked off at WS-connect time and has been running in
      // parallel with the desktop's scan + the desktop-ready wait. Just
      // await it here — typically near-instant by the time we hit this
      // line.
      const run = await info.scanPromise;
      if (run.attestation) {
        try {
          const r = await jsonFetch<AttestResponse>(`${API}/session/${sessionId}/phone-attest`, {
            method: 'POST',
            body: JSON.stringify({
              argusSessionId: run.argusSessionId,
              attestation: run.attestation,
              deviceTrustToken: trustToken,
              desktopEnvelope: info.desktopEnvelope,
              // Top-level (unsigned) cross-bindings — server validates
              // these against the stored desktopAttestation. They no
              // longer live inside the phone's signed envelope, which
              // lets the scan run in parallel with the desktop scan
              // without sacrificing the cross-binding security check.
              desktopArgusSessionId: info.desktopArgusSessionId,
              desktopKeyId: info.desktopKeyId,
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
  // Default to register if the caller didn't pick — first-time visitors
  // hitting older code paths get the cleaner CREATE flow rather than
  // the iOS "no passkeys for this site" dialog.
  const passkeyMode: 'passkey-create' | 'passkey-auth' =
    options.mode === 'passkey-auth' ? 'passkey-auth' : 'passkey-create';

  const webauthnPromise: Promise<unknown | { error: string }> = useOAuth
    ? Promise.resolve({ error: 'mode_oauth_skipped' })
    : passkeyMode === 'passkey-auth'
      ? authenticateExistingPasskey(info.nonce)
      : createNewPasskey(info.nonce);

  // Argus scan was kicked off in awaitDesktopReady (at WS-connect time),
  // running in parallel with the desktop scan + the desktop-ready wait.
  // By the time the user has tapped the button and WebAuthn has run,
  // this scan is usually already done — the await here is near-instant.
  const [webauthnSettled, runSettled] = await Promise.allSettled([
    webauthnPromise,
    info.scanPromise,
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
  try {
    const r = await jsonFetch<AttestResponse>(`${API}/session/${sessionId}/phone-attest`, {
      method: 'POST',
      body: JSON.stringify({
        argusSessionId: run.argusSessionId,
        attestation: run.attestation,
        webauthn,
        desktopEnvelope: info.desktopEnvelope,
        // Top-level (unsigned) cross-bindings — see silent-redeem path.
        desktopArgusSessionId: info.desktopArgusSessionId,
        desktopKeyId: info.desktopKeyId,
        ...(useOAuth && options.oauthResult ? { oauth: options.oauthResult } : {}),
      }),
    });
    if (r.nextDeviceTrust) await saveTrustToken(r.nextDeviceTrust);
    // Server confirmed registration AND the pair succeeded. Now safe
    // to remember the credentialId so future visits offer USE PASSKEY.
    // We only do this on the passkey-create path — passkey-auth was
    // using an existing hint already; OAuth doesn't manage one.
    if (
      r.verdict === 'paired' &&
      passkeyMode === 'passkey-create' &&
      webauthnSettled.status === 'fulfilled'
    ) {
      const wa = webauthnSettled.value;
      if (wa && typeof wa === 'object' && typeof (wa as { id?: unknown }).id === 'string') {
        writePasskeyHint((wa as { id: string }).id);
      }
    }
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
  // Pass the page host as a query param so the server hashes the same
  // siteHash that POST /entry sees (browsers don't send Origin on
  // same-origin GETs). encodeURIComponent guards against weird hosts.
  const site = encodeURIComponent(window.location.host);
  return jsonFetch<RaffleStatus>(`${API}/raffle/status/${sessionId}?site=${site}`);
}

export { HttpError };
