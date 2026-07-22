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
import { bootstrapDesktopSession } from './desktop-session-bootstrap';
import { mintDesktopQr } from './desktop-qr';
import {
  buildProofAttestationBody,
  buildTrustRedeemAttestationBody,
  createdCredentialIdFromProof,
} from './phone-attestation-body';
import type { SecureQrImage } from './qr-keyholder';
import {
  decodeVerdictRevealKey,
  openFixedVerdictEnvelope,
  type PhoneStatePayload,
  type SealedVerdictEnvelope,
} from './verdict-envelope';
import { awaitWithDeadline } from './client-deadline';
import { createDesktopResultPoll } from './desktop-result-poll';
import { createDesktopVerdictGate } from './desktop-verdict-gate';
import { HttpError, jsonFetch } from './json-http';
import { withSsoClientStage } from './sso-observability';

const API = '/api';
const ATTEST_PURPOSE = 'argus-pair-v1';
const ATTEST_TTL_SECONDS = 120;
const ARGUS_BOOTSTRAP_TIMEOUT_MS = 15_000;
const ARGUS_CPI =
  (import.meta.env.VITE_MERCHANT_CPI as string | undefined) ??
  'argus_cpi_test_UEeqk7Bk7uetxKKDxNmIdB';

interface ArgusAttestation {
  envelope: string;
  signature: string;
  publicKey: string;
  keyId: string;
}

export interface HostPreflightScan {
  argusSessionId: string;
  attestation: ArgusAttestation;
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
    argusBootstrapReady?: Promise<void>;
  }
}

function getArgus(): ArgusGlobal {
  if (!window.argus) {
    throw new Error('argus SDK not loaded (argus-loader.iife.js missing or blocked)');
  }
  return window.argus;
}

async function waitForArgus(): Promise<ArgusGlobal> {
  // The stable bootstrap verifies a signed manifest before installing the SDK.
  // Phone code can execute while that async chain is still in flight. Await the
  // bootstrap's canonical readiness promise so eager scanning starts at the
  // earliest safe moment without racing window.argus initialization.
  await awaitWithDeadline(
    window.argusBootstrapReady ?? Promise.resolve(),
    ARGUS_BOOTSTRAP_TIMEOUT_MS,
    'argus_bootstrap'
  );
  return getArgus();
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
  cpi: string;
  proofRequired: boolean;
  freshProofRequired: boolean;
  challengeUrl: string;
  failureReturnUrl: string;
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
  cpi: string;
  approvalCode?: string;
  merchantCallbackUrl?: string;
  merchantChallengeId?: string;
  nextDeviceTrust?: string | null;
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

/** Argus ingestion remains partitioned by the base CPI; Pair binds the full scoped CPI. */
function integrityCpi(cpi: string): string {
  return cpi.replace(/\.(?:fastpass|stepup|forceauth)$/, '');
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
    waitForArgus().then((argus) =>
      argus.run({
        cpi: integrityCpi(opts.cpi || ARGUS_CPI),
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
      })
    ),
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

  // Routing state. The peer envelope only arrives when the phone sends
  // its first peer message (phone-here); buffer desktopReady until both
  // sides are present.
  let cancelled = false;
  let scanError: Error | null = null;
  let phoneEnvelope: string | null = null;
  let bufferedReady: Record<string, unknown> | null = null;
  let notifiedPhoneConnected = false;
  let isDesktopWsConnected = true;

  const sendReadyIfBothUp = () => {
    if (phoneEnvelope && bufferedReady) {
      desktopConn.sendPeer(phoneEnvelope, bufferedReady);
      bufferedReady = null;
    }
  };

  // The gate owns exactly-once settlement and withholds both pass and fail
  // results while the phone's drawing challenge is visible. Keeping this state
  // outside the transport workflow makes the timing-oracle boundary explicit.
  const verdictGate = createDesktopVerdictGate(session.sessionId);
  const resultPoll = createDesktopResultPoll({
    sessionId: session.sessionId,
    desktopToken: session.ws.desktopToken,
    gate: verdictGate,
    isCancelled: () => cancelled,
  });

  desktopConn.onDisconnect(() => {
    isDesktopWsConnected = false;
    if (notifiedPhoneConnected) void resultPoll.start(0);
  });

  desktopConn.onMessage((msg) => {
    if (cancelled) return;
    const data = msg.data as { kind?: string } | null;
    if (!data || typeof data.kind !== 'string') return;
    if (data.kind === 'phone-here') {
      if (!msg.fromEnvelope) return;
      phoneEnvelope = msg.fromEnvelope;
      verdictGate.notePhoneChallenge((data as { challenge?: boolean }).challenge === true);
      if (!notifiedPhoneConnected) {
        notifiedPhoneConnected = true;
        events.onPhoneConnected?.();
        void resultPoll.start(isDesktopWsConnected ? 20_000 : 0);
      }
      sendReadyIfBothUp();
    } else if (data.kind === 'phone-done') {
      // The phone user finished the drawing challenge (tapped DONE or the
      // challenge screen was dismissed). Only the real phone role can send
      // this — the relay stamps `from` server-side. It can't fabricate a
      // verdict; it only releases one the server already pushed.
      if ((msg as unknown as { from?: string }).from !== 'phone') return;
      verdictGate.releaseHeldVerdict();
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
      verdictGate.settle({
        verdict: (data as { verdict: string }).verdict,
        reason: (data as { reason: string | null }).reason ?? null,
        annotations: (data as { annotations?: Record<string, unknown> }).annotations,
      });
    } else if (data.kind === 'verdict-sealed') {
      if (msg.from !== 'server') return;
      void verdictGate.receiveSealedVerdict((data as { envelope: SealedVerdictEnvelope }).envelope);
    } else if (data.kind === 'verdict-release') {
      if (msg.from !== 'server') return;
      void verdictGate.receiveRevealKey((data as { revealKey: string }).revealKey);
    }
  });

  // Bound the wait. Session TTL is 5 minutes — once the server-side row
  // is gone /phone-attest will 404 anyway and no verdict push will land,
  // so reject locally rather than spin forever.
  const expiryMs = Math.max(0, session.expiresAt * 1000 - Date.now());
  window.setTimeout(() => {
    if (cancelled) return;
    // A verdict held for the phone's DONE tap is still a verdict — reveal
    // it rather than expiring a session that actually succeeded.
    if (verdictGate.hasHeldVerdict()) {
      verdictGate.releaseHeldVerdict();
      return;
    }
    verdictGate.fail(new Error('session expired'));
  }, expiryMs);

  // WS verdict push is the primary path. /result is now only a delayed fallback
  // after the phone has appeared, or immediate fallback if the desktop socket
  // disconnects during that phase. This avoids hammering /result while the QR is
  // simply sitting on screen waiting to be scanned.

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
          ...(hostScan ? { hostPreflight: hostScan } : {}),
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
      verdictGate.fail(e);
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
        verdictGate.fail(scanError);
      }
    },
    result: verdictGate.result,
    getVerdictToken,
  };
}

export function defaultSsoCpi(): string {
  return `${integrityCpi(ARGUS_CPI)}.stepup`;
}

async function runSsoLeg(
  cpi: string,
  payload: Record<string, unknown>
): Promise<{
  argusSessionId: string;
  attestation: ArgusAttestation;
}> {
  const stage = typeof payload.role === 'string' ? payload.role : 'unknown';
  const sessionId = typeof payload.ssoSessionId === 'string' ? payload.ssoSessionId : null;
  return withSsoClientStage(stage, 'argus_leg', sessionId, async () => {
    const argus = await waitForArgus();
    const run = await argus.run({
      cpi: integrityCpi(cpi),
      timeoutMs: 30_000,
      attest: {
        purpose: ATTEST_PURPOSE,
        ttlSeconds: ATTEST_TTL_SECONDS,
        payload: { ...payload, cpi },
      },
    });
    if (!run.attestation) {
      throw new Error(`argus attestation failed: ${run.attestError ?? 'no attestation'}`);
    }
    return { argusSessionId: run.argusSessionId, attestation: run.attestation };
  });
}

export async function startSsoSession(
  merchantSessionId: string,
  cpi: string,
  merchantBinding?: { challengeId: string; callbackUrl: string }
): Promise<SsoStartResult> {
  const leg = await runSsoLeg(cpi, { role: 'merchant-start', merchantSessionId });
  return withSsoClientStage('merchant-start', 'http_request', null, () =>
    jsonFetch<SsoStartResult>(`${API}/sso/start`, {
      method: 'POST',
      body: JSON.stringify({
        merchantSessionId,
        cpi,
        ...(merchantBinding
          ? {
              merchantChallengeId: merchantBinding.challengeId,
              merchantCallbackUrl: merchantBinding.callbackUrl,
            }
          : {}),
        ...leg,
      }),
    })
  );
}

export async function submitSsoChallenge(
  sessionId: string,
  nonce: string,
  cpi: string
): Promise<SsoChallengeResult> {
  const leg = await runSsoLeg(cpi, { role: 'argus-challenge', ssoSessionId: sessionId, nonce });
  return withSsoClientStage('argus-challenge', 'http_request', sessionId, () =>
    jsonFetch<SsoChallengeResult>(`${API}/sso/${encodeURIComponent(sessionId)}/challenge`, {
      method: 'POST',
      body: JSON.stringify(leg),
    })
  );
}

export async function validateSsoReturn({
  sessionId,
  nonce,
  returnCode,
  cpi,
  mode,
  oauthResult,
  deviceTrustToken,
}: {
  sessionId: string;
  nonce: string;
  returnCode: string;
  cpi: string;
  mode?: 'integrity-only' | 'passkey-create' | 'passkey-auth' | 'oauth' | 'device-trust';
  oauthResult?: { provider: 'google'; token: string };
  deviceTrustToken?: string;
}): Promise<SsoValidateResult> {
  const useOAuth = mode === 'oauth';
  const useDeviceTrust = mode === 'device-trust';
  const useIntegrityOnly = mode === 'integrity-only';
  const passkeyMode = mode === 'passkey-auth' ? 'passkey-auth' : 'passkey-create';
  const webauthnPromise: Promise<unknown | { error: string }> =
    useOAuth || useDeviceTrust || useIntegrityOnly
      ? Promise.resolve({ error: `mode_${mode}_skipped` })
      : passkeyMode === 'passkey-auth'
        ? authenticateExistingPasskey(nonce)
        : createNewPasskey(nonce);
  const legPromise = runSsoLeg(cpi, {
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

  const result = await withSsoClientStage('merchant-validate', 'http_request', sessionId, () =>
    jsonFetch<SsoValidateResult>(`${API}/sso/${encodeURIComponent(sessionId)}/validate`, {
      method: 'POST',
      body: JSON.stringify({
        returnCode,
        ...legSettled.value,
        ...(useDeviceTrust && deviceTrustToken ? { deviceTrustToken } : {}),
        ...(!useDeviceTrust && !useOAuth && !useIntegrityOnly ? { webauthn } : {}),
        ...(useOAuth && oauthResult ? { oauth: oauthResult } : {}),
      }),
    })
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

export async function redeemSsoApproval(
  sessionId: string,
  expectedCpi: string
): Promise<{ verdict: 'approved'; reason: 'approved'; cpi: string; scope: string }> {
  return jsonFetch<{ verdict: 'approved'; reason: 'approved'; cpi: string; scope: string }>(
    `${API}/sso/approval/redeem`,
    {
      method: 'POST',
      credentials: 'same-origin',
      body: JSON.stringify({ sessionId, cpi: expectedCpi }),
    }
  );
}

// ── CLIENT (phone) ───────────────────────────────────────────────────────

export interface PhoneSessionInfo {
  nonce: string;
  /** Server-resolved CPI policy delivered through the single-use QR token. */
  proofRequired: boolean;
  /** True when cached device trust cannot satisfy this session. */
  freshProofRequired: boolean;
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
  /** Resolves only after the server authenticates this phone's DONE message. */
  getVerdictRevealKey: () => Promise<string>;
  /**
   * Returns the phone integrity scan started as soon as the QR bootstrap is
   * parsed. Silent trust and proof-of-life paths share the same scan. The
   * signed payload only binds {sessionId, nonce, role: phone}; desktop
   * bindings travel as top-level fields and are validated server-side.
   */
  getScanPromise: () => Promise<ArgusRunResult>;
}

interface PairHashParams {
  wsUrl: string;
  desktopEnvelope: string;
  phoneToken: string;
  nonce: string;
  proofRequired: boolean;
  freshProofRequired: boolean;
}

function parsePairHash(): PairHashParams {
  const raw = window.location.hash.replace(/^#/, '');
  const params = new URLSearchParams(raw);
  const wsUrl = params.get('wsUrl');
  const e = params.get('e');
  const pt = params.get('pt');
  const n = params.get('n');
  // Missing means strict for compatibility with QR tokens minted before this field existed.
  const proofRequired = params.get('pr') !== '0';
  const freshProofRequired = params.get('fr') === '1';
  if (!wsUrl || !e || !pt || !n) {
    throw new Error('pair URL is missing WebSocket routing material in the fragment — open via QR');
  }
  return {
    wsUrl,
    desktopEnvelope: e,
    phoneToken: pt,
    nonce: n,
    proofRequired,
    freshProofRequired,
  };
}

async function startPhoneIntegrityScan(sessionId: string, nonce: string): Promise<ArgusRunResult> {
  const argus = await waitForArgus();
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
  signal?: AbortSignal,
  opts: {
    /**
     * Phone is showing an interactive challenge (bio-draw). Rides on the
     * `phone-here` announcement so the desktop holds the reveal of a
     * `paired` verdict until `phone-done` (see signalChallengeDone).
     */
    challenge?: boolean;
    onScanStart?: () => void;
    onScanDone?: (result: ArgusRunResult) => void;
    onScanError?: (error: unknown) => void;
  } = {}
): Promise<PhoneSessionInfo> {
  if (signal?.aborted) throw new Error('aborted');
  const { wsUrl, desktopEnvelope, phoneToken, nonce, proofRequired, freshProofRequired } =
    parsePairHash();

  // LATENCY CONTRACT: DO NOT move this scan behind desktop-ready or a user tap.
  // The nonce arrives in the QR, so no later desktop field is needed to start.
  // A previous lazy-on-tap change exposed 3.3-5.5 seconds of scan latency after
  // SEND. Starting here hides that work behind the connection handshake and
  // challenge UI; the server still withholds the verdict until every binding
  // and assurance requirement is verified.
  opts.onScanStart?.();
  const scanPromise = startPhoneIntegrityScan(sessionId, nonce);
  void scanPromise.then(opts.onScanDone, opts.onScanError);
  const getScanPromise = () => scanPromise;

  const conn = await connectAndWhoami({
    url: wsUrl,
    token: phoneToken,
    origin: window.location.origin,
  });

  const verdictRevealKey = new Promise<string>((resolve) => {
    const unsubscribe = conn.onMessage((message) => {
      const data = message.data as { kind?: unknown; revealKey?: unknown } | null;
      if (
        message.from === 'server' &&
        data?.kind === 'verdict-release' &&
        typeof data.revealKey === 'string'
      ) {
        unsubscribe();
        resolve(data.revealKey);
      }
    });
  });

  if (signal?.aborted) {
    conn.close();
    throw new Error('aborted');
  }
  const onAbort = () => conn.close();
  signal?.addEventListener('abort', onAbort);
  try {
    // Tell the desktop we're here. Server auto-includes our envelope on
    // the relayed message so the desktop can address us back.
    conn.sendPeer(desktopEnvelope, { kind: 'phone-here', challenge: opts.challenge === true });

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
      proofRequired,
      freshProofRequired,
      expiresAt: data.expiresAt,
      desktopArgusSessionId: data.desktopArgusSessionId,
      desktopKeyId: data.desktopKeyId,
      desktopEnvelope,
      phoneToken,
      conn,
      getVerdictRevealKey: () => verdictRevealKey,
      getScanPromise,
    };
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
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
  try {
    info.conn.sendPeer(info.desktopEnvelope, { kind: 'phone-done' });
  } catch {
    /* best effort — desktop hold cap covers the loss */
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

/** @public — passkey-hint UI helper used by the canonical phone entry and SSO. */
export function hasPasskeyHint(): boolean {
  try {
    return window.localStorage.getItem(PASSKEY_HINT_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Clear the passkey hint so the next button screen offers CREATE
 * PASSKEY instead of USE PASSKEY. Called from phone-main.tsx when the
 * server reports the stored credential isn't recognized server-side
 * (the classic stuck-hint failure mode after a registration-time
 * rpId mismatch).
 *
 * @public — shared by phone pairing and mobile SSO.
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
  phoneState?: SealedVerdictEnvelope;
  revealKey?: string;
  /** Persist released phone-only state after DONE without exposing it earlier. */
  finalizeAfterDone?: () => Promise<'paired' | 'failed' | null>;
}

function attachPhoneStateFinalizer(
  response: AttestResponse,
  info: PhoneSessionInfo,
  createdCredentialId: string | null = null
): AttestResponse {
  if (response.verdict !== 'complete' || !response.phoneState) return response;
  let finalization: Promise<'paired' | 'failed' | null> | null = null;
  return {
    ...response,
    finalizeAfterDone: () => {
      finalization ??= (async () => {
        const revealKey = response.revealKey ?? (await info.getVerdictRevealKey());
        const payload = await openFixedVerdictEnvelope(
          decodeVerdictRevealKey(revealKey),
          info.conn.sessionId,
          response.phoneState!
        );
        if (payload.kind !== 'phone-state') throw new Error('unexpected phone state payload kind');
        const phoneState = payload as PhoneStatePayload;
        if (phoneState.nextDeviceTrust) {
          const { saveTrustToken } = await import('./device-trust');
          await saveTrustToken(phoneState.nextDeviceTrust);
        }
        if (phoneState.verdict === 'paired' && createdCredentialId) {
          writePasskeyHint(createdCredentialId);
        }
        return phoneState.verdict;
      })();
      return finalization;
    },
  };
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
  mode?: 'integrity' | 'passkey-create' | 'passkey-auth' | 'oauth';
  /** When `mode === "oauth"`, the result from one of the
   *  `runGoogleProofOfLife(...)` in `src/lib/oauth.ts`. */
  oauthResult?: { provider: 'google'; token: string };
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
  const trustToken = info.freshProofRequired ? null : await loadTrustToken();
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
          return attachPhoneStateFinalizer(r, info);
        } catch (postErr) {
          if (postErr instanceof HttpError) {
            // 409 already_attested: this device already paired in this
            // session (likely a retried request whose first response was
            // lost). Treat as success — fetch the existing verdict.
            if (postErr.status === 409 && postErr.bodyJson?.error === 'already_attested') {
              // The winner already delivered the sealed desktop verdict. Do
              // not fetch /result here: it is desktop-only ciphertext and the
              // phone must remain decision-blind.
              return { verdict: 'complete', reason: null, annotations: {} };
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
  const integrityOnly = options.mode === 'integrity';
  // Default to register if the caller didn't pick — first-time visitors
  // hitting older code paths get the cleaner CREATE flow rather than
  // the iOS "no passkeys for this site" dialog.
  const passkeyMode: 'passkey-create' | 'passkey-auth' =
    options.mode === 'passkey-auth' ? 'passkey-auth' : 'passkey-create';

  const webauthnPromise: Promise<unknown | { error: string }> = integrityOnly
    ? Promise.resolve({ error: 'mode_integrity_only' })
    : useOAuth
      ? Promise.resolve({ error: 'mode_oauth_skipped' })
      : passkeyMode === 'passkey-auth'
        ? authenticateExistingPasskey(info.nonce)
        : createNewPasskey(info.nonce);

  // The Argus scan started during QR bootstrap and has been running behind
  // the challenge UI. WebAuthn still runs in parallel when interactive proof
  // is required.
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
  const proofError = useOAuth || integrityOnly ? null : webauthnError(webauthn);
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
    // Legacy plaintext responses are finalized immediately. Sealed responses
    // defer trust persistence and the passkey hint until authenticated DONE.
    rememberPasskey(r.verdict);
    return attachPhoneStateFinalizer(r, info, createdCredentialId);
  } catch (e) {
    // Session is already paired (a prior request from this device succeeded
    // server-side even if the response was lost or retried). Treat as
    // success: fetch the existing verdict from /result instead of bubbling
    // the error up. Without this, transient network retries or double-fire
    // touch events on mobile make the phone show "Something went wrong"
    // even though the desktop sees the pairing succeed.
    if (e instanceof HttpError && e.status === 409 && e.bodyJson?.error === 'already_attested') {
      // The first request already pushed the sealed result. Returning a
      // neutral completion keeps retries from becoming a plaintext oracle.
      return { verdict: 'complete', reason: null, annotations: {} };
    }
    throw e;
  }
}

export { HttpError };
