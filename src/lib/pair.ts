/**
 * Client-side dual-scan co-attestation flow.
 *
 *   Desktop                                  Server                            Phone
 *   ─────────                                ──────                            ─────
 *   POST /api/session/start ──────────────►
 *      ◄────────────────  {sessionId, nonce, expiresAt}
 *   ─── QR rendered immediately ───
 *
 *   (background) Promise.all([iframe scan, merchant scan])
 *                → POST /desktop-attest
 *
 *   (QR scanned)                                                                ─►
 *                                            redeem short token ◄─────────────
 *                                            WS whoami + phone-here ──────────►
 *      ◄────────────────────────── desktop-ready (authenticated peer relay)
 *
 *                                            user taps "Proof of Life"
 *                                            Promise.all([
 *                                              navigator.credentials.create(...),
 *                                              argus.run({attest: {nonce, ...}}),
 *                                            ])
 *                                            POST /api/session/{id}/phone-attest
 *                                          { argusSessionId, attestation, webauthn }
 *      ◄──────────── sealed verdict; reveal after authenticated phone-done
 *
 * WebAuthn rides as a sibling field in the phone-attest POST body (not
 * inside the Argus envelope payload), so the WebAuthn ceremony and the
 * Argus scan can run concurrently. Both bind to the same server-issued
 * nonce so the proofs stay tied to this specific session.
 */

import { connectAndWhoami, openWs } from './ws';
import { bootstrapDesktopSession } from './desktop-session-bootstrap';
import { mintDesktopQr } from './desktop-qr';
import type { SecureQrImage } from './qr-keyholder';
import { decodeVerdictRevealKey, openFixedVerdictEnvelope } from './verdict-envelope';
import { createDesktopSessionRuntime } from './desktop-session-runtime';
import { jsonFetch } from './json-http';
import {
  ARGUS_CPI,
  baseIntegrityCpi,
  runArgusScan,
  type ArgusAttestation,
  type ArgusRunResult,
} from './argus-client';
import {
  authenticateExistingPasskey,
  createNewPasskey,
  rememberPasskeyCredential,
} from './passkey-client';
import {
  runPhoneAttestation,
  type PhoneAttestationResponse,
  type SubmitPhoneAttestationOptions,
} from './phone-attestation';
import {
  awaitPhoneSessionReady,
  signalPhoneChallengeDone,
  type PhoneSessionInfo,
  type PhoneSessionOptions,
} from './phone-session-runtime';

export type { PhoneSessionInfo } from './phone-session-runtime';
export type { SubmitPhoneAttestationOptions } from './phone-attestation';

const API = '/api';

export interface HostPreflightScan {
  argusSessionId: string;
  attestation: ArgusAttestation;
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

export interface StartDesktopOptions {
  /**
   * Merchant CPI to attribute this pairing's attestation + usage to. Defaults
   * to the build-pinned/test CPI when omitted, so the demo and /pair page are
   * unaffected; the embeddable widget passes the host's `data-cpi` through here.
   */
  cpi?: string;
  /** Fresh opaque identifier for the merchant action this verdict may authorize. */
  challengeId?: string;
  /** Cross-origin embeds require merchant evidence before desktop-ready may be sent. */
  hostPreflightRequired?: boolean;
  /** Starts the merchant scan after a Pair session ID exists, without blocking the QR. */
  requestHostPreflight?: (binding: { pairSessionId: string }) => Promise<HostPreflightScan>;
  /** Exact merchant origin signed by the host scan and snapshotted at session start. */
  hostOrigin?: string;
}

export async function startDesktopSession(
  events: PairEvents = {},
  opts: StartDesktopOptions = {}
): Promise<DesktopSession> {
  events.onStatus?.('starting session');
  const challengeId = opts.challengeId ?? crypto.randomUUID();

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
  const { session, desktopConn } = await bootstrapDesktopSession(
    {
      challengeId,
      cpi: opts.cpi,
      hostPreflightRequired: opts.hostPreflightRequired,
      hostOrigin: opts.hostOrigin,
      staticWsUrl: import.meta.env.VITE_PAIR_WS_URL as string | undefined,
      origin: window.location.origin,
    },
    {
      startSession: (body) =>
        jsonFetch(`${API}/session/start`, { method: 'POST', body: JSON.stringify(body) }),
      openSocket: openWs,
      connect: connectAndWhoami,
      warn: (message, error) => console.warn(message, error),
    }
  );

  // Evidence starts as soon as the server-issued session binding exists. The
  // settled wrapper prevents an early rejection from becoming unhandled while
  // WS identity and sealed QR minting continue independently.
  const desktopEvidencePromise = Promise.all([
    runArgusScan({
      cpi: baseIntegrityCpi(opts.cpi || ARGUS_CPI),
      payload: {
        sessionId: session.sessionId,
        nonce: session.nonce,
        role: 'desktop',
      },
    }),
    opts.hostPreflightRequired
      ? (opts.requestHostPreflight?.({ pairSessionId: session.sessionId }) ??
        Promise.reject(new Error('host preflight callback missing')))
      : Promise.resolve(null),
  ]).then(
    ([run, hostScan]) => ({ ok: true as const, run, hostScan }),
    (error: unknown) => ({ ok: false as const, error })
  );

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

  const runtime = createDesktopSessionRuntime({
    sessionId: session.sessionId,
    desktopToken: session.ws.desktopToken,
    expiresAt: session.expiresAt,
    connection: desktopConn,
    onPhoneConnected: events.onPhoneConnected,
  });

  // Background: scan + desktop-attest. When done, queue the desktop-
  // ready peer message (or send immediately if the phone is already up).
  (async () => {
    try {
      const evidence = await desktopEvidencePromise;
      if (!evidence.ok) throw evidence.error;
      const { run, hostScan } = evidence;
      if (!run.attestation) {
        throw new Error(`argus attestation failed: ${run.attestError ?? 'no attestation'}`);
      }
      if (runtime.isCancelled()) return;
      const attResp = await jsonFetch<{
        ok: boolean;
        clean?: boolean;
        summary?: DesktopAttestedSummary['summary'];
      }>(`${API}/session/${session.sessionId}/desktop-attest`, {
        method: 'POST',
        body: JSON.stringify({
          argusSessionId: run.argusSessionId,
          attestation: run.attestation,
          ...(hostScan ? { hostPreflight: hostScan } : {}),
        }),
      });
      events.onDesktopAttested?.({
        clean: !!attResp.clean,
        summary: attResp.summary ?? null,
      });
      runtime.queueDesktopReady({
        kind: 'desktop-ready',
        nonce: session.nonce,
        expiresAt: session.expiresAt,
        desktopArgusSessionId: run.argusSessionId,
        desktopKeyId: run.attestation.keyId,
      });
    } catch (e) {
      events.onError?.(e);
      runtime.fail(e);
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
    stop: runtime.stop,
    result: runtime.result,
    getVerdictToken,
  };
}

// ── CLIENT (phone) ───────────────────────────────────────────────────────

async function startPhoneIntegrityScan(sessionId: string, nonce: string): Promise<ArgusRunResult> {
  const scanPromise = runArgusScan({
    cpi: ARGUS_CPI,
    payload: {
      sessionId,
      nonce,
      role: 'phone',
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

export async function awaitDesktopReady(
  sessionId: string,
  signal?: AbortSignal,
  options: PhoneSessionOptions = {}
): Promise<PhoneSessionInfo> {
  return awaitPhoneSessionReady(sessionId, signal, options, {
    readHash: () => window.location.hash,
    getOrigin: () => window.location.origin,
    startScan: startPhoneIntegrityScan,
    connect: connectAndWhoami,
  });
}

/**
 * @public — called by phone-main via the dynamically imported pair module
 * (`state.pairMod.signalChallengeDone`), which knip cannot trace.
 *
 * Tell the desktop the user finished the drawing challenge. Releases the
 * desktop-side reveal gate armed by `phone-here {challenge:true}` — the
 * verdict itself always travels server→desktop; this only un-holds it.
 * Best-effort by design: the desktop's hold cap and session-expiry timer
 * reveal the verdict anyway if this message never lands.
 */
export function signalChallengeDone(info: PhoneSessionInfo): void {
  signalPhoneChallengeDone(info);
}

export async function submitPhoneAttestation(
  sessionId: string,
  info: PhoneSessionInfo,
  events: PairEvents = {},
  options: SubmitPhoneAttestationOptions = {}
): Promise<PhoneAttestationResponse> {
  const { loadTrustToken, saveTrustToken, clearTrustToken } = await import('./device-trust');
  return runPhoneAttestation(
    { sessionId, info, events, options },
    {
      loadTrustToken,
      saveTrustToken,
      clearTrustToken,
      authenticatePasskey: authenticateExistingPasskey,
      createPasskey: createNewPasskey,
      rememberPasskeyCredential,
      postAttestation: (boundSessionId, body) =>
        jsonFetch(`${API}/session/${boundSessionId}/phone-attest`, {
          method: 'POST',
          body: JSON.stringify(body),
        }),
      openPhoneState: (revealKey, boundSessionId, envelope) =>
        openFixedVerdictEnvelope(decodeVerdictRevealKey(revealKey), boundSessionId, envelope),
    }
  );
}
