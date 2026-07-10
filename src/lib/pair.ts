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
import { mintDesktopQr } from './desktop-qr';
import {
  buildProofAttestationBody,
  buildTrustRedeemAttestationBody,
  createdCredentialIdFromProof,
} from './phone-attestation-body';
import type { SecureQrImage } from './qr-keyholder';

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
  onPhoneConnected?: () => void;
}

// ── HOST (desktop) ───────────────────────────────────────────────────────

export interface DesktopSession {
  sessionId: string;
  /**
   * The poisoned QR as server-rendered PNG bytes, opened inside the QR SCIF
   * worker. The plaintext pair URL never crosses into this page realm.
   */
  qr: SecureQrImage;
  expiresAt: number;
  stop: () => void;
  result: Promise<{
    verdict: string;
    reason: string | null;
    annotations?: Record<string, unknown>;
  }>;
  /**
   * Fetch a server-signed verdict token (after the verdict resolves) that the
   * embed widget posts to the host for server-to-server verify. null when the
   * verdict isn't final or signing isn't configured.
   */
  getVerdictToken: () => Promise<string | null>;
}

export interface SsoStartResult {
  sessionId: string;
  nonce: string;
  expiresAt: number;
  challengeUrl: string;
}

export interface SsoChallengeResult {
  ok: true;
  returnCode: string;
  returnUrl: string;
}

export interface SsoValidateResult {
  verdict: 'approved' | 'failed';
  reason: string;
  reasons: string[];
  merchantSessionId: string;
  nextDeviceTrust?: string | null;
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

export interface StartDesktopOptions {
  /**
   * Merchant CPI to attribute this pairing's attestation + usage to. Defaults
   * to the build-pinned/test CPI when omitted, so the demo and /pair page are
   * unaffected; the embeddable widget passes the host's `data-cpi` through here.
   */
  cpi?: string;
}

export async function startDesktopSession(
  events: PairEvents = {},
  opts: StartDesktopOptions = {}
): Promise<DesktopSession> {
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
    jsonFetch<SessionStartResp>(`${API}/session/start`, {
      method: 'POST',
      body: opts.cpi ? JSON.stringify({ cpi: opts.cpi }) : undefined,
    }),
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

  // Keep the canonical-host build canary. The server now owns QR rendering via
  // PAIR_PUBLIC_ORIGIN, but this still catches the broken deploy class where
  // the pair bundle was built outside `npm run deploy`.
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
  const pairOriginBuildCanary = bakedOrigin ?? window.location.origin;
  // Forward the desktop's `?debug=true` query param through the QR so
  // the phone-side flow can disable its silent-reauth auto-pass. Debug
  // mode is UI-only; does not relax server-side verification.
  const debugMode = new URLSearchParams(window.location.search).get('debug') === 'true';
  // The hash fragment carries the WS routing material end-to-end. Hash
  // fragments are NOT sent to the server in HTTP requests — they stay
  // client-side. Phone parses them on page load.
  // `n` (nonce) lets the phone start its argus.run() scan immediately
  // on arrival, in parallel with the desktop's scan, instead of waiting
  // for the desktop-ready WS message. desktopArgusSessionId and
  // desktopKeyId still arrive via desktop-ready and ship as top-level
  // POST body fields (no longer inside the phone's signed envelope).
  // Mint a short single-use token for the connection blob instead of packing
  // {wsUrl,e,pt,n} into the URL fragment. The server renders a sparse poisoned
  // QR PNG for /p/<token>. Authed with the desktop's own wsToken (only a
  // session participant can mint).
  //
  // The QR is delivered SEALED: the QR keyholder (a Web Worker) mints an
  // ephemeral ECDH pubkey, we send it up, the server renders + seals the
  // poisoned PNG to it, and only image bytes cross back. See qr-keyholder.ts.
  const qr = await mintDesktopQr({
    session,
    desktopEnvelope: desktopConn.envelope,
    debugMode,
    pairOriginBuildCanary,
    postJson: jsonFetch,
  });
  events.onStatus?.('waiting for phone');

  // Routing state. The peer envelope only arrives when the phone sends
  // its first peer message (phone-here); buffer desktopReady until both
  // sides are present.
  let cancelled = false;
  let scanError: Error | null = null;
  let phoneEnvelope: string | null = null;
  let bufferedReady: Record<string, unknown> | null = null;
  let notifiedPhoneConnected = false;
  let isDesktopWsConnected = true;
  let hasStartedResultPoll = false;

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
  // Settle exactly once. The WS verdict push (fast path, from /phone-attest)
  // and the /result poll (fallback) race — whichever lands first wins; later
  // calls and the expiry timer become no-ops.
  let settled = false;
  const settle = (v: VerdictShape) => {
    if (settled) return;
    settled = true;
    resolveResult(v);
  };
  const fail = (e: unknown) => {
    if (settled) return;
    settled = true;
    rejectResult(e);
  };
  const startResultPoll = (initialDelayMs: number) => {
    if (hasStartedResultPoll) return;
    hasStartedResultPoll = true;
    (async () => {
      let stepMs = initialDelayMs;
      while (!cancelled && !settled) {
        await new Promise((r) => window.setTimeout(r, stepMs));
        stepMs = Math.min(10_000, Math.max(2_000, Math.round(stepMs * 1.5)));
        if (cancelled || settled) return;
        try {
          const res = await fetch(
            `${API}/session/${session.sessionId}/result?t=${encodeURIComponent(
              session.ws.desktopToken
            )}`,
            { headers: { accept: 'application/json' } }
          );
          if (res.status === 200) {
            settle((await res.json()) as VerdictShape);
            return;
          }
          // 204 → keep polling. Anything else (401 auth, etc.) → stop the poll
          // and let the WS push / expiry timer be the deciders.
          if (res.status !== 204) return;
        } catch {
          // Transient network error — keep polling until settled or expiry.
        }
      }
    })();
  };

  desktopConn.onDisconnect(() => {
    isDesktopWsConnected = false;
    if (notifiedPhoneConnected) startResultPoll(0);
  });

  desktopConn.onMessage((msg) => {
    if (cancelled) return;
    const data = msg.data as { kind?: string } | null;
    if (!data || typeof data.kind !== 'string') return;
    if (data.kind === 'phone-here') {
      phoneEnvelope = msg.fromEnvelope;
      if (!notifiedPhoneConnected) {
        notifiedPhoneConnected = true;
        events.onPhoneConnected?.();
        startResultPoll(isDesktopWsConnected ? 20_000 : 0);
      }
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
      settle({
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
    fail(new Error('session expired'));
  }, expiryMs);

  // WS verdict push is the primary path. /result is now only a delayed fallback
  // after the phone has appeared, or immediate fallback if the desktop socket
  // disconnects during that phase. This avoids hammering /result while the QR is
  // simply sitting on screen waiting to be scanned.

  // Background: scan + desktop-attest. When done, queue the desktop-
  // ready peer message (or send immediately if the phone is already up).
  (async () => {
    try {
      const argus = getArgus();
      const run = await argus.run({
        cpi: opts.cpi || ARGUS_CPI,
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
      fail(e);
    }
  })();

  const getVerdictToken = async (): Promise<string | null> => {
    try {
      const r = await jsonFetch<{ token?: string }>(
        `${API}/session/${session.sessionId}/verdict-token?t=${encodeURIComponent(
          session.ws.desktopToken
        )}`
      );
      return r.token ?? null;
    } catch {
      return null;
    }
  };

  return {
    sessionId: session.sessionId,
    qr,
    expiresAt: session.expiresAt,
    stop: () => {
      cancelled = true;
      desktopConn.close();
      if (scanError) {
        // Surface the still-buffered error if nothing else has resolved.
        fail(scanError);
      }
    },
    result,
    getVerdictToken,
  };
}

async function runSsoLeg(payload: Record<string, unknown>): Promise<{
  argusSessionId: string;
  attestation: ArgusAttestation;
}> {
  const run = await getArgus().run({
    cpi: ARGUS_CPI,
    timeoutMs: 30_000,
    attest: {
      purpose: ATTEST_PURPOSE,
      ttlSeconds: ATTEST_TTL_SECONDS,
      payload,
    },
  });
  if (!run.attestation) {
    throw new Error(`argus attestation failed: ${run.attestError ?? 'no attestation'}`);
  }
  return { argusSessionId: run.argusSessionId, attestation: run.attestation };
}

export async function startSsoSession(merchantSessionId: string): Promise<SsoStartResult> {
  const leg = await runSsoLeg({ role: 'merchant-start', merchantSessionId });
  return jsonFetch<SsoStartResult>(`${API}/sso/start`, {
    method: 'POST',
    body: JSON.stringify({ merchantSessionId, ...leg }),
  });
}

export async function submitSsoChallenge(
  sessionId: string,
  nonce: string
): Promise<SsoChallengeResult> {
  const leg = await runSsoLeg({ role: 'argus-challenge', ssoSessionId: sessionId, nonce });
  return jsonFetch<SsoChallengeResult>(`${API}/sso/${encodeURIComponent(sessionId)}/challenge`, {
    method: 'POST',
    body: JSON.stringify(leg),
  });
}

export async function validateSsoReturn({
  sessionId,
  nonce,
  returnCode,
  mode,
  oauthResult,
  deviceTrustToken,
}: {
  sessionId: string;
  nonce: string;
  returnCode: string;
  mode?: 'passkey-create' | 'passkey-auth' | 'oauth' | 'device-trust';
  oauthResult?: { provider: 'google' | 'github' | 'facebook'; token: string };
  deviceTrustToken?: string;
}): Promise<SsoValidateResult> {
  const useOAuth = mode === 'oauth';
  const useDeviceTrust = mode === 'device-trust';
  const passkeyMode = mode === 'passkey-auth' ? 'passkey-auth' : 'passkey-create';
  const webauthnPromise: Promise<unknown | { error: string }> =
    useOAuth || useDeviceTrust
      ? Promise.resolve({ error: `mode_${mode}_skipped` })
      : passkeyMode === 'passkey-auth'
        ? authenticateExistingPasskey(nonce)
        : createNewPasskey(nonce);
  const legPromise = runSsoLeg({
    role: 'merchant-validate',
    ssoSessionId: sessionId,
    nonce,
    returnCode,
  });
  const [webauthnSettled, legSettled] = await Promise.allSettled([webauthnPromise, legPromise]);
  if (legSettled.status !== 'fulfilled') throw legSettled.reason;
  const webauthn =
    webauthnSettled.status === 'fulfilled'
      ? webauthnSettled.value
      : { error: (webauthnSettled.reason as Error).message };
  const createdCredentialId =
    passkeyMode === 'passkey-create' &&
    webauthnSettled.status === 'fulfilled' &&
    webauthnSettled.value !== null &&
    typeof webauthnSettled.value === 'object' &&
    typeof (webauthnSettled.value as { id?: unknown }).id === 'string'
      ? (webauthnSettled.value as { id: string }).id
      : null;

  const result = await jsonFetch<SsoValidateResult>(
    `${API}/sso/${encodeURIComponent(sessionId)}/validate`,
    {
      method: 'POST',
      body: JSON.stringify({
        returnCode,
        ...legSettled.value,
        ...(useDeviceTrust && deviceTrustToken ? { deviceTrustToken } : {}),
        ...(!useDeviceTrust && !useOAuth ? { webauthn } : {}),
        ...(useOAuth && oauthResult ? { oauth: oauthResult } : {}),
      }),
    }
  ).catch((e) => {
    if (e instanceof HttpError && e.status === 403 && e.bodyJson?.verdict === 'failed') {
      return e.bodyJson as unknown as SsoValidateResult;
    }
    throw e;
  });
  if (result.nextDeviceTrust) {
    const { saveTrustToken } = await import('./device-trust');
    await saveTrustToken(result.nextDeviceTrust);
  }
  if (result.verdict === 'approved' && createdCredentialId) writePasskeyHint(createdCredentialId);
  return result;
}

/** Result of a claim submission (the SSO name-claim gate). */
export interface RaffleEntryResult {
  ok: true;
  /** Short public identifier (`xxxx-xxxx`) derived from the handle hash. */
  code: string;
  count: number;
}

export async function submitSsoClaim(
  sessionId: string,
  handle: string
): Promise<RaffleEntryResult> {
  return jsonFetch<RaffleEntryResult>(`${API}/sso/${encodeURIComponent(sessionId)}/claim`, {
    method: 'POST',
    body: JSON.stringify({ handle: handle.trim().toLowerCase() }),
  });
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
  /**
   * The phone's WS bootstrap token (from the QR hash). Used to authenticate
   * the GET /result fallback (#10) — /result now requires a valid session
   * token for either role.
   */
  phoneToken: string;
  /** Live WS connection the phone opened to receive `desktop-ready`. */
  conn: WsConnection;
  /**
   * Lazily starts the phone integrity scan after the cheap dialpad has
   * loaded and the user advances. Memoized so silent trust fallback and
   * proof-of-life paths share the same scan. Signed payload only binds
   * {sessionId, nonce, role: phone}; desktopArgusSessionId/desktopKeyId
   * travel as unsigned top-level body fields and are validated
   * server-side against storage.
   */
  getScanPromise: () => Promise<ArgusRunResult>;
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

function startPhoneIntegrityScan(sessionId: string, nonce: string): Promise<ArgusRunResult> {
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
  // Surface scan errors lazily — if a caller starts a scan and then the
  // user closes the tab before awaiting it, the runtime would log an
  // unhandled-rejection warning. This .catch keeps the rejection
  // attached without consuming it; the eventual awaiter still sees it.
  scanPromise.catch(() => {
    /* surfaced by submitPhoneAttestation */
  });
  return scanPromise;
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
  let scanPromise: Promise<ArgusRunResult> | null = null;
  const getScanPromise = () => {
    scanPromise ??= startPhoneIntegrityScan(sessionId, nonce);
    return scanPromise;
  };

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
      phoneToken,
      conn,
      getScanPromise,
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

/** @public — passkey-hint UI helper, dormant while passkeys are off the
 *  mobile UX (Pair.tsx no longer renders passkey buttons). Kept for if/when
 *  passkeys are reinstated. */
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
 *
 * @public — dormant while passkeys are off the mobile UX; kept for reinstating.
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

function webauthnError(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const error = (value as { error?: unknown }).error;
  return typeof error === 'string' && error.length > 0 ? error : null;
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
  /**
   * Try only the IndexedDB device-trust token path. Used by the phone's
   * background fast-pass flow so an expired token never opens WebAuthn
   * without an explicit user tap.
   */
  trustOnly?: boolean;
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
  if (!trustToken && options.trustOnly) {
    throw new Error('device_trust_unavailable');
  }
  if (trustToken) {
    events.onStatus?.('welcome back — verifying');
    try {
      const run = await info.getScanPromise();
      if (run.attestation) {
        try {
          const r = await jsonFetch<AttestResponse>(`${API}/session/${sessionId}/phone-attest`, {
            method: 'POST',
            body: JSON.stringify(
              buildTrustRedeemAttestationBody(
                { argusSessionId: run.argusSessionId, attestation: run.attestation },
                info,
                trustToken
              )
            ),
          });
          if (r.nextDeviceTrust) await saveTrustToken(r.nextDeviceTrust);
          return r;
        } catch (postErr) {
          if (postErr instanceof HttpError) {
            // 409 already_attested: this device already paired in this
            // session (likely a retried request whose first response was
            // lost). Treat as success — fetch the existing verdict.
            if (postErr.status === 409 && postErr.bodyJson?.error === 'already_attested') {
              // /result requires the bootstrap token — without ?t= the server
              // 401s and this recovery path used to defeat itself (cleared the
              // trust token and forced WebAuthn on an already-paired session).
              const fallback = await jsonFetch<AttestResponse>(
                `${API}/session/${sessionId}/result?t=${encodeURIComponent(info.phoneToken)}`,
                { method: 'GET' }
              );
              return fallback;
            }
            if (postErr.status === 401) {
              await clearTrustToken();
              events.onStatus?.('trust expired — re-verifying');
              if (options.trustOnly) throw postErr;
            } else {
              await clearTrustToken();
              events.onStatus?.('falling back to webauthn');
              if (options.trustOnly) throw postErr;
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
      if (options.trustOnly) throw e;
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

  // Start the expensive Argus scan only after the cheap dialpad has
  // loaded and the user advances. For WebAuthn, it still runs in
  // parallel with proof-of-life so the user does not pay the full sum.
  const [webauthnSettled, runSettled] = await Promise.allSettled([
    webauthnPromise,
    info.getScanPromise(),
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
  const proofError = useOAuth ? null : webauthnError(webauthn);
  if (proofError) {
    throw new Error(proofError);
  }

  events.onStatus?.('submitting');
  // Credential id from this fresh registration, if any. We persist it as
  // the USE-PASSKEY hint once the server confirms a paired verdict (see
  // rememberPasskey). Captured BEFORE the request so both the normal
  // response and the 409 already_attested fallback can record it: on
  // mobile the winning request frequently lands on the fallback (double-
  // tap / lost first response), and skipping the hint there was making
  // every visit re-mint a brand-new passkey. We only track the create
  // path — passkey-auth reuses an existing hint, OAuth manages none.
  const createdCredentialId = createdCredentialIdFromProof(passkeyMode, webauthnSettled);
  const rememberPasskey = (verdict: string): void => {
    if (verdict === 'paired' && createdCredentialId) writePasskeyHint(createdCredentialId);
  };
  try {
    const r = await jsonFetch<AttestResponse>(`${API}/session/${sessionId}/phone-attest`, {
      method: 'POST',
      body: JSON.stringify(
        buildProofAttestationBody({
          run: { argusSessionId: run.argusSessionId, attestation: run.attestation },
          bindings: info,
          webauthn,
          oauth: useOAuth ? options.oauthResult : undefined,
        })
      ),
    });
    if (r.nextDeviceTrust) await saveTrustToken(r.nextDeviceTrust);
    // Server confirmed registration AND the pair succeeded.
    rememberPasskey(r.verdict);
    return r;
  } catch (e) {
    // Session is already paired (a prior request from this device succeeded
    // server-side even if the response was lost or retried). Treat as
    // success: fetch the existing verdict from /result instead of bubbling
    // the error up. Without this, transient network retries or double-fire
    // touch events on mobile make the phone show "Something went wrong"
    // even though the desktop sees the pairing succeed.
    if (e instanceof HttpError && e.status === 409 && e.bodyJson?.error === 'already_attested') {
      const fallback = await jsonFetch<AttestResponse>(
        `${API}/session/${sessionId}/result?t=${encodeURIComponent(info.phoneToken)}`,
        { method: 'GET' }
      );
      // This double-submit is exactly the case that used to drop the hint
      // and force a re-mint next visit. Record it off the fallback verdict.
      rememberPasskey(fallback.verdict);
      return fallback;
    }
    throw e;
  }
}

// Raffle/leaderboard frontend fetchers moved out with the marketing pages
// (Demo/ClaimSpot → ms-argus-www), then the dormant /api/raffle/* backend
// was removed too. The shared rate limiter (checkRaffleRateLimits) lives on
// for SSO claims.

export { HttpError };
