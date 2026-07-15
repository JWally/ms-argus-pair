/**
 * HTTP API for the dual-scan co-attestation pairing flow.
 *
 * No WebSockets, no relays, no DataChannel. Each side independently runs
 * an Argus integrity scan and signs an envelope binding (sessionId, nonce,
 * role, ...) with its persistent device key (via the SDK's signAssertion
 * method, see ms-argus-web-integrity#22). Server verifies both signatures
 * and treats the pair as authenticated.
 *
 * Endpoints:
 *   POST /api/session/start
 *     → { sessionId, nonce, expiresAt }   (5-min TTL)
 *
 *   GET /api/session/{id}/info
 *     → { nonce, expiresAt, desktopReady, verdict }
 *     Used by the phone after QR scan to discover the nonce + check
 *     whether the desktop side already submitted.
 *
 *   POST /api/session/{id}/desktop-attest
 *     body: { argusSessionId, attestation, hostPreflight? }
 *     → 200 ok
 *     Verifies the iframe scan and any required merchant scan, then binds both.
 *
 *   POST /api/session/{id}/phone-attest     body: { argusSessionId, attestation }
 *     → { verdict, reason }
 *     Final step. Verifies signature, checks payload binds to the same
 *     session+nonce as the desktop's attestation, and emits a verdict.
 *
 *   GET /api/session/{id}/result
 *     → { verdict, reason }
 *     Polled by the desktop to detect when the phone has completed pairing.
 *
 * Envelope verification follows device-attestation.md from the SDK repo:
 *   1. base64url-decode envelope, parse JSON, check v === 1
 *   2. check now in [iat - skew, exp + skew]
 *   3. check purpose === 'argus-pair-v1'
 *   4. check envelope.keyId derived from publicKey matches
 *   5. ECDSA-P256-SHA-256 verify(signature, raw envelope bytes, publicKey)
 *   6. then app-level: payload.sessionId === session id, payload.nonce === nonce
 */
import { randomBytes, randomUUID } from 'crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import middy from '@middy/core';
import type { MiddlewareObj } from '@middy/core';
import { mintBootstrapToken, openEnvelope, verifyBootstrapToken } from './ws-handler';
import {
  isValkeySessionsEnabled,
  mgetSession,
  recordDesktopAttestationValkey,
  recordPhoneAttestationValkey,
  claimArgusValkey,
  type PhoneBundle,
} from './session-store';
import { getViewerIp, jsonResp, originAllowed, parseBody } from './pair-api/shared/http';
import {
  validateAttestInput,
  validatePairAttestationBody,
  validateSsoAttestation,
  verifyPairAttestationPayload,
} from './pair-api/attestation/envelope';
import {
  getTrustSecret,
  mintDeviceTrust,
  verifyDeviceTrust,
  type DeviceTrustVerifyResult,
} from './pair-api/attestation/trust';
import { createDdbPasskeyStore } from './pair-api/passkey-store';
import {
  isProofOfLifeSatisfied,
  verifyProofOfLife,
  type OAuthAnnotations,
  type WebAuthnAnnotations,
} from './pair-api/proof-of-life';
import { logPhonePerfEvent, proofModeForLog } from './pair-api/phone-observability';
import { diagnoseValkeyConnectivity } from './pair-api/valkey-debug';
import {
  classifyScan,
  computeVerdict,
  isProjectionFresh,
  projectionAgeSeconds,
  PROJECTION_FRESHNESS_WINDOW_SECONDS,
  summarizeDesktopScan,
} from './pair-api/projection-verdict';
import { evaluateSsoContinuity, mintReturnCode, type SsoLegProfile } from './sso-continuity';
import { getVerdictSecret } from './pair-api/verdict-token';
import { createVerdictTokenMintHandler } from './pair-api/verdict-token-mint-route';
import { parseMerchantChallenge } from './pair-api/merchant-challenge';
import { createVerdictVerificationHandler } from './pair-api/verdict-verification-route';
import { mintPairToken, redeemPairToken, type KvStore } from './pair-api/pair-token';
import { validatePairTokenMintBody } from './pair-api/pair-token-request';
import { parseScopedCpi, requiresProofOfLife } from './pair-api/scoped-cpi';
import { evaluateSsoProofPolicy } from './pair-api/sso-assurance';
import {
  buildSealedResult,
  deliverSealedVerdict,
  isVerdictReleased,
} from './pair-api/verdict-disclosure';
import { fetchProjection } from './pair-api/projection-client';
import {
  hashApprovalToken,
  mintApprovalToken,
  SSO_APPROVAL_TTL_SECONDS,
} from './pair-api/sso-approval';
import { createSsoApprovalRedemptionHandler } from './pair-api/sso-approval-route';
import { parseSsoMerchantBinding } from './pair-api/sso-merchant-callback';
import { ssoFailureReturn } from './pair-api/sso-merchant-callback';
import { createSsoMerchantApprovalHandler } from './pair-api/sso-merchant-approval-route';
import { ssoChallengeResp, ssoStartResp } from './pair-api/sso-route-response';
import { ssoValidationResponse } from './pair-api/sso-validation-response';
import { buildSessionStartRateLimit } from './pair-api/session-start-rate-limit';
import { sealPairTokenQr, type QrCompression } from './pair-api/sealed-qr';
import { hashSsoReturnCode, requirePhoneSsoScan, ssoProfileFromScan } from './pair-api/sso-scan';
import { verifyWorkerIntegrity } from './pair-api/worker-integrity';
import type { StoredHostPreflight } from './pair-api/host-preflight';
import { collectHostPreflightEvidence } from './pair-api/host-preflight-evidence';
import { prepareAndStoreStartedSession } from './pair-api/session-start-store';
import {
  prepareDesktopAttestation,
  type StoredDesktopAttestation,
  type StoredPairAttestation,
} from './pair-api/desktop-attest';
// Isomorphic ECIES seal shared with the client QR worker (src/lib) — same
// crypto.subtle code both sides so the contract can't drift.
import { getValkey } from './valkey-client';

// Valkey-backed store for the short pairing token. `take` is an atomic GETDEL,
// so a token can only be redeemed once (single-use).
const pairTokenStore: KvStore = {
  async set(key, value, ttlSec) {
    await getValkey().set(key, value, 'EX', ttlSec);
  },
  async take(key) {
    return getValkey().getdel(key);
  },
};

const TABLE = process.env.TABLE_NAME!;

const SESSION_TTL_SECONDS = 300; // 5 minutes
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// WebAuthn RP identifier. Must match the rpId the phone passes to
// startRegistration on the client (window.location.hostname).
const WEBAUTHN_RP_ID = process.env.WEBAUTHN_RP_ID || 'captcha-dev-jw.argus.pw';
const WEBAUTHN_EXPECTED_ORIGIN = `https://${WEBAUTHN_RP_ID}`;
const PAIR_PUBLIC_ORIGIN = process.env.PAIR_PUBLIC_ORIGIN || `https://${WEBAUTHN_RP_ID}`;
const SSO_CALLBACK_ORIGINS = (process.env.SSO_CALLBACK_ORIGINS || '').split(',').filter(Boolean);

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const passkeyStore = createDdbPasskeyStore(ddb, TABLE);

// ── argusSessionId single-use ledger ──────────────────────────────────────
//
// Without this, an attacker who gets ONE clean argusSessionId pair (via a
// legitimate pairing, a defeat of the argus clean-verdict path, or token
// theft) can drive unlimited subsequent pair-sessions: forge ephemeral
// envelopes per session, reference the recycled ids, fetchProjection
// returns the same clean data on every call. PoC at
// ms-argus-attack-bots/bots/pair-session-recycling.mjs.
//
// We claim each argusSessionId with a DDB conditional put (PK keyed by the
// id) the first time it shows up. Second time → ConditionalCheckFailed →
// 409. TTL'd so the ledger self-cleans on the same horizon as a typical
// argus projection. Per-row writes are independent of the SESSION#… rows.
const ARGUS_SID_LEDGER_TTL_SECONDS = 24 * 3600;

export async function claimArgusSessionId(
  argusSessionId: string,
  pairSessionId: string,
  role: 'host' | 'desktop' | 'phone'
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (isValkeySessionsEnabled()) {
    return claimArgusValkey(argusSessionId, pairSessionId, role);
  }
  const now = Math.floor(Date.now() / 1000);
  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLE,
        Item: {
          PK: `ARGUSSID#${argusSessionId}`,
          SK: 'CLAIM',
          claimedBy: pairSessionId,
          role,
          claimedAt: now,
          expiresAt: now + ARGUS_SID_LEDGER_TTL_SECONDS,
        },
        ConditionExpression: 'attribute_not_exists(PK)',
      })
    );
    return { ok: true };
  } catch (err: unknown) {
    const isConflict = (err as { name?: string })?.name === 'ConditionalCheckFailedException';
    if (!isConflict) throw err;
    // Idempotent re-claim: a single pair attempt can legitimately submit the
    // same argusSessionId twice — the silent device-trust redeem claims it,
    // fails its IP-pinned verify (mobile IP rotated) and 401s WITHOUT storing
    // an attestation, then the client re-submits the SAME scan on the WebAuthn
    // fallback. That second claim must NOT 409 the user. Only a DIFFERENT pair
    // session reusing the id is the recycling attack the ledger defends.
    // Mirrors the STUN nonce tracker's same-session re-claim acceptance.
    const existing = await ddb.send(
      new GetCommand({
        TableName: TABLE,
        Key: { PK: `ARGUSSID#${argusSessionId}`, SK: 'CLAIM' },
      })
    );
    if (existing.Item?.claimedBy === pairSessionId && existing.Item?.role === role) {
      return { ok: true };
    }
    return { ok: false, reason: 'already_claimed' };
  }
}

// ── proof-of-life requirement (toggle) ─────────────────────────────────────
//
// The design intent was `magic-token || webauthn`: a pair only succeeds if the
// phone proved liveness via a passkey ceremony, an OAuth sign-in, or a redeemed
// device-trust token. That guarantee is OPTIONAL by default here, because the
// orphaned-passkey loop (server returns `credential_not_registered` for a
// passkey the phone still holds) was hard-failing clean, Apple-attested phones
// as `no_proof_of_life`. With it optional, a session pairs on the Argus
// integrity scores alone (both sides clean, scores under the limits, neither on
// a proxy); the passkey / Google buttons (and the "skip" path) still work and
// still mint a device-trust token, they're just no longer mandatory.
//
// To restore the strict `magic-token || webauthn` bar, set
// PAIR_REQUIRE_PROOF_OF_LIFE=true in the Lambda env (needs the two-place CDK
// wiring from CLAUDE.md). SECURITY NOTE: optional weakens the anti-bot bar to
// "clean scan on both sides."
const REQUIRE_PROOF_OF_LIFE = process.env.PAIR_REQUIRE_PROOF_OF_LIFE === 'true';

// Rate-limit backend selection.
/**
 * USE_VALKEY_RATE_LIMITS=true switches rate limits from DDB to Valkey. The
 * Lambda must be VPC-attached with VALKEY_ENDPOINT set; otherwise DDB runs.
 *
 * Both code paths are shipped intentionally — flip the env flag to
 * roll back without a code redeploy.
 */
function isValkeyRateLimitsEnabled(): boolean {
  return process.env.USE_VALKEY_RATE_LIMITS === 'true';
}

// ── #10: throttle POST /session/start ──────────────────────────────────
// Session creation was unbounded — 20 concurrent → 20×200 (verified live
// 2026-06-24), enabling attempt-volume / resource abuse. Cap per source IP
// per fixed window. Generous enough for a shared NAT / enthusiastic tester,
// tight enough to deny a single-IP farm. Hardcoded to avoid CDK env plumbing.
/**
 * Returns true if a new session-start from `ip` is allowed. Single fixed
 * window bucket. Note: we pass `max + 1` to the Valkey rlIncr cap and allow
 * `<= max`; `max + 1` makes the Valkey semantics match the DDB `ct < max`
 * path so both allow exactly `max`.
 */
async function checkSessionStartRateLimit(ip: string): Promise<boolean> {
  const gate = buildSessionStartRateLimit(ip);
  if (isValkeyRateLimitsEnabled()) {
    const { getValkey } = await import('./valkey-client');
    const count = await getValkey().rlIncr(
      `pair:rl:${gate.bucket}:${gate.window}`,
      gate.valkeyCap,
      gate.ttlSeconds
    );
    return Number(count ?? 0) <= gate.max;
  }
  // DDB fallback: ADD ct while ct < max (allows exactly `max`, then trips).
  const ttl = Math.floor(Date.now() / 1000) + gate.ttlSeconds;
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: gate.ddbKey,
        UpdateExpression: 'ADD ct :one SET expiresAt = if_not_exists(expiresAt, :ttl)',
        ConditionExpression: 'attribute_not_exists(ct) OR ct < :max',
        ExpressionAttributeValues: { ':one': 1, ':max': gate.max, ':ttl': ttl },
      })
    );
    return true;
  } catch (e) {
    if ((e as { name?: string }).name === 'ConditionalCheckFailedException') return false;
    throw e;
  }
}

type Verdict = 'pending' | 'paired' | 'failed';

interface SessionItem {
  PK: string;
  SK: string;
  nonce: string;
  expiresAt: number;
  cpi?: string | null;
  challengeId?: string;
  proofRequired?: boolean;
  freshProofRequired?: boolean;
  hostPreflightRequired?: boolean;
  hostOrigin?: string;
  hostAttestation?: StoredHostPreflight;
  desktopAttestation?: StoredDesktopAttestation;
  phoneAttestation?: StoredPairAttestation;
  verdict: Verdict;
  verdictReason?: string;
}

interface SsoSessionItem {
  PK: string;
  SK: 'META';
  nonce: string;
  merchantSessionId: string;
  cpi: string;
  merchantChallengeId?: string;
  merchantCallbackUrl?: string;
  proofRequired: boolean;
  freshProofRequired: boolean;
  startProfile: SsoLegProfile;
  challengeProfile?: SsoLegProfile;
  validateProfile?: SsoLegProfile;
  returnCodeHash?: string;
  returnCodeExpiresAt?: number;
  returnCodeConsumedAt?: number;
  approvalTokenHash?: string;
  approvalRedeemedAt?: number;
  verdict: 'pending' | 'approved' | 'failed';
  verdictReason?: string;
  expiresAt: number;
  approvedAt?: number;
}

async function authenticateSessionParticipant(
  event: {
    queryStringParameters?: Record<string, string | undefined>;
    headers?: Record<string, string | undefined>;
  },
  sessionId: string
): Promise<boolean> {
  const token =
    event.queryStringParameters?.t ||
    (event.headers?.authorization || event.headers?.Authorization || '').replace(/^Bearer\s+/i, '');
  const claims = token ? await verifyBootstrapToken(token) : null;
  return claims?.sessionId === sessionId;
}

/**
 * Real client IP. CloudFront injects the CloudFront-Viewer-Address header
 * on the way to origin AND strips any client-supplied value with the same
 * name (the CloudFront-* prefix is reserved at the edge — verified
 * empirically 2026-05-26 by spoofing the header in a curl: the spoofed
 * value never reaches Lambda). So this header is safe to trust.
 *
 * Note: APIGW HTTP v2's requestContext.http.sourceIp ALSO surfaces the
 * real viewer IP behind a CloudFront integration (not the edge IP, as an
 * earlier version of this comment claimed). Either field is reliable for
 * device-trust IP-pinning; we prefer the header for explicitness.
 */
// Off by default → prod rejects virtual authenticators as proof-of-life. Set
// true only on test/dev stages (lets automated happy-path + red-team runs
// isolate the desktop-score gate). Known-AAGUID list + check in
// ./pair-api/virtual-authenticator.ts (unit-tested).
const ALLOW_TEST_AUTHENTICATORS = process.env.PAIR_ALLOW_TEST_AUTHENTICATORS === 'true';

async function loadSession(sessionId: string): Promise<SessionItem | null> {
  if (isValkeySessionsEnabled()) {
    const { meta, desktop, phone } = await mgetSession(sessionId);
    if (!meta) return null;
    // Reassemble into the SessionItem shape so downstream callers see
    // the same fields regardless of backend. Optional fields stay
    // undefined when their key wasn't present.
    return {
      PK: `SESSION#${sessionId}`,
      SK: 'META',
      nonce: meta.nonce,
      expiresAt: meta.expiresAt,
      cpi: meta.cpi ?? null,
      challengeId: meta.challengeId,
      proofRequired: meta.proofRequired ?? REQUIRE_PROOF_OF_LIFE,
      freshProofRequired: meta.freshProofRequired ?? false,
      hostPreflightRequired: meta.hostPreflightRequired ?? false,
      hostOrigin: meta.hostOrigin,
      hostAttestation:
        (desktop as unknown as StoredDesktopAttestation | null)?.hostAttestation ??
        (meta.hostAttestation as unknown as StoredHostPreflight | undefined),
      verdict: phone?.verdict ?? 'pending',
      verdictReason: phone?.reason ?? undefined,
      desktopAttestation: desktop as unknown as StoredDesktopAttestation | undefined,
      phoneAttestation: phone?.att as unknown as StoredPairAttestation | undefined,
      // annotations live on the row in the DDB shape too.
      ...(phone?.annotations ? { annotations: phone.annotations } : {}),
    } as unknown as SessionItem;
  }
  const res = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { PK: `SESSION#${sessionId}`, SK: 'META' } })
  );
  const item = (res.Item as SessionItem | undefined) ?? null;
  if (item && !item.hostAttestation) {
    item.hostAttestation = item.desktopAttestation?.hostAttestation;
  }
  return item;
}

async function loadSsoSession(sessionId: string): Promise<SsoSessionItem | null> {
  const res = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { PK: `SSO#${sessionId}`, SK: 'META' } })
  );
  return (res.Item as SsoSessionItem | undefined) ?? null;
}

const redeemSsoApprovalRequest = createSsoApprovalRedemptionHandler({
  ddb,
  tableName: TABLE,
  loadSession: loadSsoSession,
});
const exchangeSsoMerchantApproval = createSsoMerchantApprovalHandler({
  ddb,
  tableName: TABLE,
  loadSession: loadSsoSession,
});
const verifyVerdictRequest = createVerdictVerificationHandler({ getSecret: getVerdictSecret });
const mintVerdictTokenRequest = createVerdictTokenMintHandler({
  loadSession,
  verifyParticipant: verifyBootstrapToken,
  isReleased: (sessionId, decidedAt, now) =>
    isVerdictReleased({ ddb, tableName: TABLE }, sessionId, decidedAt, now),
  getSecret: getVerdictSecret,
});

const lambdaHandler = async (event: {
  routeKey: string;
  pathParameters?: Record<string, string | undefined>;
  queryStringParameters?: Record<string, string | undefined>;
  body?: string;
  headers?: Record<string, string | undefined>;
  cookies?: string[];
}) => {
  if (!originAllowed(event)) return jsonResp(403, { error: 'origin_not_allowed' });

  const routeKey = event.routeKey;
  const sessionId = event.pathParameters?.id?.toLowerCase();
  // Routes that don't carry an {id} path parameter — skip the UUID check.
  const idLessRoutes = new Set([
    'POST /api/session/start',
    'POST /api/sso/start',
    'POST /api/sso/approval/redeem',
    'POST /api/sso/approval/exchange',
    'GET /api/_valkey-debug',
    'POST /api/verify',
    'POST /api/pair-token/redeem',
    'POST /api/phone-perf',
  ]);
  if (!idLessRoutes.has(routeKey) && !SESSION_ID_RE.test(sessionId ?? '')) {
    return jsonResp(400, { error: 'invalid_session_id' });
  }
  const body = parseBody(event.body);
  if (body === null) return jsonResp(400, { error: 'invalid_body' });

  switch (routeKey) {
    case 'POST /api/phone-perf': {
      logPhonePerfEvent({
        body,
        ip: getViewerIp(event),
        userAgent: event.headers?.['user-agent'] ?? event.headers?.['User-Agent'],
      });
      return {
        statusCode: 204,
        headers: { 'Cache-Control': 'no-store' },
        body: '',
      };
    }

    case 'GET /api/_valkey-debug': {
      // Diagnostic-only endpoint. Tries DNS → raw TCP → TLS → ioredis
      // and reports where the chain breaks. Safe to expose because it
      // only reports connectivity outcomes; no Valkey command is run.
      return jsonResp(200, await diagnoseValkeyConnectivity());
    }
    case 'POST /api/session/start': {
      // #10: per-IP throttle. Fail OPEN on limiter error — a Valkey/DDB hiccup
      // must not take down all pairing; the cap is abuse-bounding, not a
      // security boundary on its own.
      let startAllowed = true;
      try {
        startAllowed = await checkSessionStartRateLimit(getViewerIp(event));
      } catch (e) {
        console.warn(`[pair] session-start rate-limit check failed open: ${(e as Error).message}`);
      }
      if (!startAllowed) {
        return jsonResp(429, { error: 'rate_limited', scope: 'session_start' });
      }
      const merchantChallenge = parseMerchantChallenge(body.challengeId);
      if (body.challengeId === undefined) {
        return jsonResp(400, { error: 'missing_challenge_id' });
      }
      if (!merchantChallenge) return jsonResp(400, { error: 'invalid_challenge_id' });
      const id = randomUUID();
      const nonce = randomBytes(32).toString('base64url');
      const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
      // The suffix is public, but its meaning is server-owned and snapshotted
      // here. Unknown scopes fail instead of silently becoming an unscoped CPI.
      const rawCpi = (body as { cpi?: unknown }).cpi;
      const scopedCpi = parseScopedCpi(rawCpi);
      if (rawCpi !== undefined && !scopedCpi) {
        return jsonResp(400, { error: 'invalid_cpi' });
      }
      const cpi = scopedCpi?.cpi ?? null;
      const proofRequired = requiresProofOfLife(scopedCpi, REQUIRE_PROOF_OF_LIFE);
      const freshProofRequired = scopedCpi?.freshProofRequired ?? false;
      const started = await prepareAndStoreStartedSession(
        {
          id,
          nonce,
          expiresAt,
          challengeId: merchantChallenge,
          cpi,
          proofRequired,
          freshProofRequired,
          hostPreflightRequired: body.hostPreflightRequired === true,
          hostOrigin: typeof body.hostOrigin === 'string' ? body.hostOrigin : undefined,
        },
        { ddb, tableName: TABLE }
      );
      if (!started.ok) return jsonResp(started.status, started.body);
      // Bootstrap WebSocket tokens — one per role. Client opens WSS,
      // sends whoami with the matching token, server returns an AES-
      // sealed connection-identity envelope. See cdk/lib/ws-handler.ts.
      const [desktopWsToken, phoneWsToken] = await Promise.all([
        mintBootstrapToken(id, 'desktop'),
        mintBootstrapToken(id, 'phone'),
      ]);
      return jsonResp(200, {
        sessionId: id,
        nonce,
        expiresAt,
        ws: {
          url: process.env.WS_API_URL ?? null,
          desktopToken: desktopWsToken,
          phoneToken: phoneWsToken,
        },
      });
    }

    case 'POST /api/sso/start': {
      const rawCpi = body.cpi;
      if (rawCpi === undefined) return jsonResp(400, { error: 'missing_cpi' });
      const scopedCpi = parseScopedCpi(rawCpi);
      if (!scopedCpi) return jsonResp(400, { error: 'invalid_cpi' });
      const checked = validateSsoAttestation(body, {
        role: 'merchant-start',
        cpi: scopedCpi.cpi,
      });
      if (!checked.ok) return jsonResp(checked.status, checked.body);
      const argusSessionId = body.argusSessionId as string;
      const id = randomUUID();
      const nonce = randomBytes(32).toString('base64url');
      const merchantSessionId =
        typeof body.merchantSessionId === 'string' && body.merchantSessionId.length > 0
          ? body.merchantSessionId.slice(0, 128)
          : randomUUID();
      const merchantBinding = parseSsoMerchantBinding(body, SSO_CALLBACK_ORIGINS);
      if (!merchantBinding.ok) {
        return jsonResp(400, { error: 'invalid_sso_merchant_binding' });
      }
      const failureReturnUrl = ssoFailureReturn(id, scopedCpi.cpi, merchantBinding.value);
      const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
      const proofRequired = requiresProofOfLife(scopedCpi, REQUIRE_PROOF_OF_LIFE);
      const projection = await fetchProjection(argusSessionId);
      const scan = classifyScan(projection, 'sso_start');
      const phoneCheck = requirePhoneSsoScan(scan, 'start', failureReturnUrl);
      if (!phoneCheck.ok) return phoneCheck.response;
      const item: SsoSessionItem = {
        PK: `SSO#${id}`,
        SK: 'META',
        nonce,
        merchantSessionId,
        cpi: scopedCpi.cpi,
        ...merchantBinding.value,
        proofRequired,
        freshProofRequired: scopedCpi.freshProofRequired,
        startProfile: ssoProfileFromScan(argusSessionId, checked.attestation, scan),
        verdict: 'pending',
        expiresAt,
      };
      await ddb.send(
        new PutCommand({
          TableName: TABLE,
          Item: item,
          ConditionExpression: 'attribute_not_exists(PK)',
        })
      );
      return ssoStartResp(id, item, failureReturnUrl);
    }

    case 'POST /api/sso/{id}/challenge': {
      const s = await loadSsoSession(sessionId!);
      if (!s) return jsonResp(404, { error: 'sso_session_not_found' });
      if (s.challengeProfile) return jsonResp(409, { error: 'sso_challenge_already_completed' });
      const failureReturnUrl = ssoFailureReturn(sessionId!, s.cpi, s);
      const checked = validateSsoAttestation(body, {
        role: 'argus-challenge',
        sessionId: sessionId!,
        nonce: s.nonce,
        cpi: s.cpi,
      });
      if (!checked.ok) return jsonResp(checked.status, checked.body);
      const argusSessionId = body.argusSessionId as string;
      const projection = await fetchProjection(argusSessionId);
      const scan = classifyScan(projection, 'sso_challenge');
      const phoneCheck = requirePhoneSsoScan(scan, 'challenge', failureReturnUrl);
      if (!phoneCheck.ok) return phoneCheck.response;
      const challengeProfile = ssoProfileFromScan(argusSessionId, checked.attestation, scan);
      const code = mintReturnCode({ sessionId: sessionId!, ttlSeconds: 90 });
      await ddb.send(
        new UpdateCommand({
          TableName: TABLE,
          Key: { PK: `SSO#${sessionId}`, SK: 'META' },
          UpdateExpression:
            'SET challengeProfile = :c, returnCodeHash = :h, returnCodeExpiresAt = :e',
          ConditionExpression: 'attribute_exists(PK) AND attribute_not_exists(challengeProfile)',
          ExpressionAttributeValues: {
            ':c': challengeProfile,
            ':h': hashSsoReturnCode(code.value),
            ':e': Math.floor(code.expiresAt / 1000),
          },
        })
      );
      return ssoChallengeResp(sessionId!, code.value, s.cpi, !!s.merchantCallbackUrl);
    }

    case 'POST /api/sso/{id}/validate': {
      const s = await loadSsoSession(sessionId!);
      if (!s) return jsonResp(404, { error: 'sso_session_not_found' });
      if (!s.challengeProfile || !s.returnCodeHash || !s.returnCodeExpiresAt) {
        return jsonResp(409, { error: 'sso_challenge_not_completed' });
      }
      if (s.returnCodeConsumedAt) {
        return jsonResp(409, { error: 'sso_return_code_consumed' });
      }
      const returnCode = typeof body.returnCode === 'string' ? body.returnCode : '';
      if (!returnCode || hashSsoReturnCode(returnCode) !== s.returnCodeHash) {
        return jsonResp(401, { error: 'sso_return_code_invalid' });
      }
      const now = Math.floor(Date.now() / 1000);
      if (now > s.returnCodeExpiresAt) {
        return jsonResp(401, { error: 'sso_return_code_expired' });
      }
      const checked = validateSsoAttestation(body, {
        role: 'merchant-validate',
        sessionId: sessionId!,
        nonce: s.nonce,
        returnCode,
        cpi: s.cpi,
      });
      if (!checked.ok) return jsonResp(checked.status, checked.body);
      const argusSessionId = body.argusSessionId as string;
      const projection = await fetchProjection(argusSessionId);
      const scan = classifyScan(projection, 'sso_validate');
      const phoneCheck = requirePhoneSsoScan(
        scan,
        'validate',
        ssoFailureReturn(sessionId!, s.cpi, s)
      );
      if (!phoneCheck.ok) return phoneCheck.response;
      const validateProfile = ssoProfileFromScan(argusSessionId, checked.attestation, scan);
      const requesterIp = getViewerIp(event);
      const deviceTrustToken =
        typeof body.deviceTrustToken === 'string' ? body.deviceTrustToken : undefined;
      const oauthInput = body.oauth;
      const webauthnInput = body.webauthn;
      let trustResult: DeviceTrustVerifyResult | null = null;
      let proofOfLife = false;
      let proofAnnotations: Record<string, unknown> = {};

      if (s.freshProofRequired && deviceTrustToken) {
        return jsonResp(401, { error: 'fresh_proof_required' });
      }
      if (deviceTrustToken) {
        trustResult = await verifyDeviceTrust(
          deviceTrustToken,
          requesterIp,
          checked.attestation.publicKey
        );
        if (!trustResult.ok) {
          return jsonResp(401, {
            error: 'device_trust_rejected',
            reason: trustResult.reason,
            clearDeviceTrust: true,
          });
        }
      }
      const proof = await verifyProofOfLife({
        webauthn: webauthnInput,
        oauth: oauthInput,
        expectedNonce: s.nonce,
        argusPubkey: checked.attestation.publicKey,
        rpId: WEBAUTHN_RP_ID,
        expectedOrigin: WEBAUTHN_EXPECTED_ORIGIN,
        allowTestAuthenticators: ALLOW_TEST_AUTHENTICATORS,
        passkeyStore,
        trustRedeemed: trustResult?.ok === true,
        deviceTrustFormat: 'device_trust',
      });
      proofOfLife = isProofOfLifeSatisfied(proof);
      proofAnnotations = {
        ...(proof as unknown as Record<string, unknown>),
        ...(trustResult?.ok ? { phone_device_trust_redeemed: true } : {}),
        ...(trustResult?.ipChanged ? { phone_device_trust_ip_changed: true } : {}),
      };

      const proofDecision = evaluateSsoProofPolicy(
        {
          proofRequired: s.proofRequired,
          freshProofRequired: s.freshProofRequired,
        },
        {
          proofSatisfied: proofOfLife,
          usedDeviceTrust: trustResult?.ok === true,
        }
      );
      if (!proofDecision.ok) {
        return jsonResp(401, {
          error: proofDecision.reason,
          annotations: proofAnnotations,
        });
      }
      const verdict = evaluateSsoContinuity({
        start: s.startProfile,
        challenge: s.challengeProfile,
        validate: validateProfile,
      });
      const approvedAt = verdict.ok ? now : undefined;
      const approvalToken = verdict.ok ? mintApprovalToken() : null;
      let nextDeviceTrust: string | null = null;
      if (verdict.ok && !trustResult?.ok && proofAnnotations.phone_webauthn_attested === true) {
        nextDeviceTrust = await mintDeviceTrust(
          checked.attestation.publicKey,
          checked.attestation.keyId,
          requesterIp
        );
      }
      await ddb.send(
        new UpdateCommand({
          TableName: TABLE,
          Key: { PK: `SSO#${sessionId}`, SK: 'META' },
          UpdateExpression:
            'SET validateProfile = :v, verdict = :verdict, verdictReason = :reason, returnCodeConsumedAt = :now, proofAnnotations = :proof' +
            (approvedAt
              ? ', approvedAt = :approvedAt, approvalTokenHash = :approvalTokenHash, expiresAt = :approvalExpiresAt'
              : ''),
          ConditionExpression:
            'attribute_exists(PK) AND attribute_not_exists(returnCodeConsumedAt)',
          ExpressionAttributeValues: {
            ':v': validateProfile,
            ':verdict': verdict.ok ? 'approved' : 'failed',
            ':reason': verdict.reason,
            ':now': now,
            ':proof': proofAnnotations,
            ...(approvedAt && approvalToken
              ? {
                  ':approvedAt': approvedAt,
                  ':approvalTokenHash': hashApprovalToken(approvalToken),
                  ':approvalExpiresAt': approvedAt + SSO_APPROVAL_TTL_SECONDS,
                }
              : {}),
          },
        })
      );
      return ssoValidationResponse({
        verdict,
        approvalToken,
        merchantSessionId: s.merchantSessionId,
        cpi: s.cpi,
        merchantCallbackUrl: s.merchantCallbackUrl,
        merchantChallengeId: s.merchantChallengeId,
        nextDeviceTrust,
      });
    }

    case 'POST /api/sso/approval/redeem': {
      return redeemSsoApprovalRequest(body, event.cookies);
    }

    case 'POST /api/sso/approval/exchange': {
      return exchangeSsoMerchantApproval(body);
    }

    case 'GET /api/session/{id}/info': {
      const s = await loadSession(sessionId!);
      if (!s) return jsonResp(200, { expired: true });
      // SECURITY (#8): this endpoint is UNAUTHENTICATED — anyone who knows
      // the sessionId can call it. It MUST NOT leak the pairing secrets.
      // `nonce`, `desktopArgusSessionId`, and `desktopKeyId` used to be
      // returned here; that let a relay/farm pair against a desktop session
      // knowing only its sessionId (verified live 2026-06-24). They are now
      // delivered ONLY over the authenticated WebSocket `desktop-ready`
      // message (gated by the phoneToken in the QR fragment) and via the QR
      // hash — see src/lib/pair.ts awaitDesktopReady(). No legitimate client
      // reads them from /info. Keep this response free of binding material.
      return jsonResp(200, {
        expiresAt: s.expiresAt,
        desktopReady: !!s.desktopAttestation,
        verdict: s.verdict,
      });
    }

    case 'POST /api/session/{id}/desktop-attest': {
      const s = await loadSession(sessionId!);
      if (!s) return jsonResp(404, { error: 'session_not_found' });
      if (s.desktopAttestation) return jsonResp(409, { error: 'already_attested' });
      const prepared = await prepareDesktopAttestation(
        body,
        {
          pairSessionId: sessionId!,
          nonce: s.nonce,
          challengeId: s.challengeId,
          cpi: s.cpi,
          hostPreflightRequired: s.hostPreflightRequired,
          hostOrigin: s.hostOrigin,
        },
        claimArgusSessionId
      );
      if (!prepared.ok) return jsonResp(prepared.status, prepared.body);
      const stored = prepared.stored;
      const argusSessionId = stored.argusSessionId;
      if (isValkeySessionsEnabled()) {
        const claimed = await recordDesktopAttestationValkey(
          sessionId!,
          stored as unknown as Record<string, unknown>
        );
        if (!claimed) {
          // Lost the race — another desktop-attest beat us. Mirrors the
          // DDB conditional-write rejection.
          return jsonResp(409, { error: 'already_attested' });
        }
      } else {
        await ddb.send(
          new UpdateCommand({
            TableName: TABLE,
            Key: { PK: `SESSION#${sessionId}`, SK: 'META' },
            UpdateExpression: 'SET desktopAttestation = :d',
            ConditionExpression:
              'attribute_exists(PK) AND attribute_not_exists(desktopAttestation)',
            ExpressionAttributeValues: { ':d': stored },
          })
        );
      }

      // Optimistic desktop classification — purely for the "APPROVED, no QR
      // needed in production" UX hint. Real verdict still runs in
      // phone-attest after both sides arrive. Best-effort: if the
      // projection isn't ready yet, the frontend just hides the banner.
      let summary: Record<string, unknown> | null = null;
      let clean = false;
      try {
        const proj = await fetchProjection(argusSessionId);
        const c = classifyScan(proj, 'desktop');
        if (c) {
          ({ clean, summary } = summarizeDesktopScan(c));
        }
      } catch (e) {
        console.warn(`[pair] desktop-attest optimistic classify failed: ${(e as Error).message}`);
      }

      return jsonResp(200, { ok: true, clean, summary });
    }

    case 'POST /api/session/{id}/phone-attest': {
      const pairBody = validatePairAttestationBody(body);
      if (!pairBody.ok) return jsonResp(pairBody.status, pairBody.body);
      const { argusSessionId, attestation: att } = pairBody;
      // WebAuthn now arrives as a sibling field (not inside the Argus
      // envelope payload) so the client can run WebAuthn + Argus scan in
      // parallel. Both still bind to the session nonce, verified
      // independently below.
      const webauthnInput = body.webauthn;
      // OAuth proof-of-life. Alternative to WebAuthn: client completed a
      // Google/GitHub/Facebook flow on the phone and posts the resulting
      // token here. Verifier binds the token's nonce/state to the pair
      // session.nonce. See oauth-providers.ts for per-provider details.
      const oauthInput = body.oauth;
      // Device-trust token. Alternative to a fresh ceremony — proves
      // "this device passed proof-of-life recently from this same IP".
      // Strict IP-pin; any verify failure returns 401 so the client can
      // clear the stale token and fall back to fresh WebAuthn or OAuth.
      const deviceTrustToken =
        typeof body.deviceTrustToken === 'string' ? body.deviceTrustToken : undefined;
      const s = await loadSession(sessionId!);
      if (!s) return jsonResp(404, { error: 'session_not_found' });
      if (!s.desktopAttestation) {
        return jsonResp(409, { error: 'desktop_not_attested_yet' });
      }
      if (s.freshProofRequired && deviceTrustToken) {
        return jsonResp(401, { error: 'fresh_proof_required', clearDeviceTrust: false });
      }
      // QR sessions are single-use. If a phoneAttestation already exists,
      // distinguish two cases by pubkey:
      //   - Same pubkey  → same device retrying (network blip, double-tap).
      //                    Return idempotent success below in the catch.
      //   - Different pubkey → a SECOND scanner. Tell them the session is
      //                        spoken for so their UI doesn't falsely claim
      //                        success. The desktop already saw the first
      //                        phone's verdict; we won't replace it.
      const earlyAtt = validateAttestInput(body);
      if (s.phoneAttestation) {
        if (earlyAtt && earlyAtt.publicKey === s.phoneAttestation.publicKey) {
          return jsonResp(409, { error: 'already_attested' });
        }
        return jsonResp(409, {
          error: 'session_paired_with_other_device',
          reason: 'This QR code is already paired with a different device.',
        });
      }
      const verified = verifyPairAttestationPayload(att, {
        role: 'phone',
        sessionId: sessionId!,
        nonce: s.nonce,
        argusSessionId,
      });
      if (!verified.ok) return jsonResp(verified.status, verified.body);
      // SECURITY (#8) — cross-sign / authenticate the desktop binding.
      //
      // The binding used to be trusted from `body.desktopArgusSessionId` /
      // `body.desktopKeyId` (plaintext), whose values were ALSO handed out by
      // the unauthenticated GET /info — so anyone with the sessionId could
      // satisfy this check and pair against a desktop session they never
      // co-operated (relay / farm pool-decoupling, verified live 2026-06-24).
      //
      // We now require the phone to present the server-sealed `desktopEnvelope`
      // — the AES-256-GCM identity the WS handler minted for the desktop's
      // authenticated connection. The phone obtains it ONLY over the
      // authenticated WebSocket `desktop-ready` relay, which is gated by the
      // phoneToken carried in the QR-hash fragment. It is unforgeable
      // (auth-tag) and bound to {sessionId, role}. There is exactly one
      // desktop per session, so an authentic role:'desktop' envelope for THIS
      // session uniquely proves the phone went through the legitimate paired
      // channel. /info no longer leaks any of this material.
      const desktopEnv =
        typeof body.desktopEnvelope === 'string' && body.desktopEnvelope.length > 0
          ? await openEnvelope(body.desktopEnvelope)
          : null;
      if (!desktopEnv || desktopEnv.sessionId !== sessionId || desktopEnv.role !== 'desktop') {
        return jsonResp(400, { error: 'desktop_binding_unauthenticated' });
      }

      // Defense-in-depth: the phone-presented binding values (sourced from the
      // authenticated WS desktop-ready message client-side) must still match
      // what the desktop actually stored server-side. These are no longer the
      // authenticity boundary (the sealed envelope above is) — they catch a
      // mis-bound or stale phone client.
      const desktopArgusSessionIdInput = body.desktopArgusSessionId as string | undefined;
      const desktopKeyIdInput = body.desktopKeyId as string | undefined;
      if (
        !desktopArgusSessionIdInput ||
        desktopArgusSessionIdInput !== s.desktopAttestation.argusSessionId
      ) {
        return jsonResp(400, { error: 'desktop_argus_session_mismatch' });
      }
      if (!desktopKeyIdInput || desktopKeyIdInput !== s.desktopAttestation.keyId) {
        return jsonResp(400, { error: 'desktop_keyId_mismatch' });
      }
      // Optional integrity check: phone & desktop must be different devices.
      if (att.keyId === s.desktopAttestation.keyId) {
        return jsonResp(400, { error: 'same_device_both_sides' });
      }
      // Claim the phone argusSessionId before storing — closes Tier-1 recycling.
      const phoneClaim = await claimArgusSessionId(argusSessionId, sessionId!, 'phone');
      if (!phoneClaim.ok) {
        return jsonResp(409, {
          error: 'argus_session_already_claimed',
          reason: phoneClaim.reason,
        });
      }
      const stored: StoredPairAttestation = {
        ...att,
        argusSessionId,
        receivedAt: Math.floor(Date.now() / 1000),
        envelopeDecoded: verified.decoded,
      };
      // If the phone presented a device-trust token, verify it FIRST.
      // Strict IP-pin: any failure → 401 + clear-token signal to client.
      const requesterIp = getViewerIp(event);
      let trustResult: DeviceTrustVerifyResult | null = null;
      if (deviceTrustToken) {
        trustResult = await verifyDeviceTrust(deviceTrustToken, requesterIp, att.publicKey);
        if (!trustResult.ok) {
          // 401 — client clears its cached token and retries with fresh
          // WebAuthn. This is the "any failure forces re-WebAuthn" rule.
          return jsonResp(401, {
            error: 'device_trust_invalid',
            reason: trustResult.reason,
          });
        }
      }

      // Both attestations are signature-valid + bound to the same
      // session/nonce + cross-bound (phone signed over the desktop's keyId
      // and argusSessionId). Now fetch the Argus scan projections and
      // verify the WebAuthn proof-of-life in parallel.
      //
      // If device-trust was redeemed above, we skip WebAuthn verification
      // (trust IS the proof of prior WebAuthn) and synthesize the
      // attested-true annotations from the trust result.
      // Proof-of-life selector. Precedence: device-trust redeem (silent)
      // → OAuth (if client sent an oauth field) → WebAuthn (legacy). Only
      // one path runs per request; the unified annotations shape lets the
      // downstream verdict code stay homogeneous.
      const proofPath: Promise<WebAuthnAnnotations | OAuthAnnotations> = verifyProofOfLife({
        webauthn: webauthnInput,
        oauth: oauthInput,
        expectedNonce: s.nonce,
        argusPubkey: att.publicKey,
        rpId: WEBAUTHN_RP_ID,
        expectedOrigin: WEBAUTHN_EXPECTED_ORIGIN,
        allowTestAuthenticators: ALLOW_TEST_AUTHENTICATORS,
        passkeyStore,
        trustRedeemed: trustResult?.ok === true,
        deviceTrustFormat: 'device_trust_redeem',
      });

      const [hostEvidence, phoneProj, webauthnResult] = await Promise.all([
        collectHostPreflightEvidence({
          hostArgusSessionId: s.hostAttestation?.argusSessionId ?? null,
          iframeArgusSessionId: s.desktopAttestation.argusSessionId,
          pairSessionId: sessionId!,
        }),
        fetchProjection(argusSessionId),
        proofPath,
      ]);
      const desktopProj = hostEvidence.iframeProjection;
      const desktopClass = hostEvidence.iframeScan;
      const phoneClass = classifyScan(phoneProj, 'phone');

      // Proof of life: the phone side must have EITHER passed a fresh
      // WebAuthn registration OR redeemed a valid device-trust token
      // (which itself is proof of a prior WebAuthn from the same IP).
      // `webauthnResult.phone_webauthn_attested` is already unified for
      // both paths above — the trust-redeem branch synthesizes it as
      // true. Without proof of life, fail the pair even when integrity
      // scans look clean — design intent is `magic-token || webauthn`.
      const proofOfLife = isProofOfLifeSatisfied(webauthnResult);

      let verdict: Verdict;
      let reason: string;
      let annotations: Record<string, unknown>;
      const desktopAgeSec = projectionAgeSeconds(desktopProj);
      const phoneAgeSec = projectionAgeSeconds(phoneProj);

      if ((s.proofRequired ?? REQUIRE_PROOF_OF_LIFE) && !proofOfLife) {
        verdict = 'failed';
        reason = 'no_proof_of_life';
        annotations = {
          desktop_projection_present: !!desktopProj,
          phone_projection_present: !!phoneProj,
          ...webauthnResult,
        };
      } else if (!desktopClass || !phoneClass) {
        // Projection lookup failed for at least one side. Old behavior was
        // fail-OPEN ("paired" with lookup_unavailable_skipped), which let
        // any attacker who could sign an envelope choose argusSessionIds
        // that don't exist in Argus and ride the fall-through to a
        // verdict. Fail CLOSED instead — the whole captcha premise is
        // that the integrity scans actually ran, so if we can't read them
        // we don't pair. Operational risk (Argus genuinely down) is
        // accepted: better to fail visibly than authenticate silently.
        verdict = 'failed';
        reason = 'projection_lookup_failed';
        annotations = {
          score_lookup_skipped: true,
          desktop_projection_present: !!desktopProj,
          phone_projection_present: !!phoneProj,
          ...webauthnResult,
        };
      } else if (!isProjectionFresh(desktopProj) || !isProjectionFresh(phoneProj)) {
        // Secondary defense alongside the single-use ledger. Stale
        // projections (legacy or recycled past the freshness window) get
        // rejected even if they somehow slipped past the ledger. Strict
        // on missing created_at — real argus scans backfill that field.
        verdict = 'failed';
        reason = 'projection_stale';
        annotations = {
          desktop_projection_age_sec: desktopAgeSec,
          phone_projection_age_sec: phoneAgeSec,
          freshness_window_sec: PROJECTION_FRESHNESS_WINDOW_SECONDS,
          ...webauthnResult,
        };
      } else {
        const computed = computeVerdict(desktopClass, phoneClass);
        verdict = computed.verdict;
        reason = computed.reason;
        annotations = { ...computed.annotations, ...webauthnResult, proof_of_life: proofOfLife };
      }

      // Preserve the raw host/iframe comparison and the narrow Brave policy
      // annotations. hostEvidence.iframeScan already carries the effective
      // score used above; every unqualified shape retains the raw API score.
      annotations = { ...annotations, ...hostEvidence.annotations };

      // Always log the verdict reason + the proof-of-life sub-error so
      // a fail-pattern is debuggable from CloudWatch without reading
      // the WS-pushed annotations off the desktop screen. The webauthn
      // result already ships to the client; logging it server-side is
      // pure operational visibility.
      if (verdict !== 'paired') {
        const wa = webauthnResult as WebAuthnAnnotations & {
          phone_webauthn_error?: string;
        };
        const oa = webauthnResult as OAuthAnnotations & {
          phone_oauth_error?: string;
        };
        console.warn(
          `[pair] verdict=${verdict} reason=${reason} ` +
            `proofOfLife=${proofOfLife} ` +
            `phone_webauthn_attested=${(webauthnResult as WebAuthnAnnotations).phone_webauthn_attested} ` +
            `phone_webauthn_error=${wa.phone_webauthn_error ?? 'none'} ` +
            `phone_oauth_error=${oa.phone_oauth_error ?? 'none'} ` +
            `trust_redeemed=${!!trustResult?.ok}`
        );
      }

      // Mint a fresh device-trust token if this phone just passed fresh
      // WebAuthn (not a redeem). The next pairing within 12h from the
      // same IP can skip the biometric prompt.
      let nextDeviceTrust: string | null = null;
      if (
        verdict === 'paired' &&
        !trustResult?.ok &&
        (webauthnResult as WebAuthnAnnotations).phone_webauthn_attested
      ) {
        nextDeviceTrust = await mintDeviceTrust(att.publicKey, att.keyId, requesterIp);
      }
      if (trustResult?.ok) {
        annotations.phone_device_trust_redeemed = true;
        if (trustResult.ipChanged) annotations.phone_device_trust_ip_changed = true;
      }

      {
        const wa = webauthnResult as WebAuthnAnnotations & {
          phone_webauthn_error?: string;
        };
        const oa = webauthnResult as OAuthAnnotations & {
          phone_oauth_error?: string;
        };
        const proofMode = proofModeForLog({
          trustRedeemed: trustResult?.ok === true,
          oauthInput,
          webauthnInput,
          annotations: webauthnResult,
        });
        console.info(
          `[pair] proof verdict=${verdict} reason=${reason} ` +
            `proofOfLife=${proofOfLife} ` +
            `proof_mode=${proofMode} ` +
            `proof_format=${wa.phone_webauthn_format ?? 'none'} ` +
            `phone_webauthn_attested=${wa.phone_webauthn_attested} ` +
            `phone_webauthn_error=${wa.phone_webauthn_error ?? 'none'} ` +
            `phone_oauth_error=${oa.phone_oauth_error ?? 'none'} ` +
            `trust_redeemed=${!!trustResult?.ok} ` +
            `trust_ip_changed=${!!trustResult?.ipChanged} ` +
            `device_trust_minted=${!!nextDeviceTrust}`
        );
      }

      if (isValkeySessionsEnabled()) {
        // Single atomic SET NX commits phone att + verdict + reason +
        // annotations in one shot — no separate "set then update verdict"
        // step, no Lua, no race window between the claim and the
        // verdict-record.
        const bundle: PhoneBundle = {
          att: stored as unknown as Record<string, unknown>,
          verdict,
          reason,
          annotations,
        };
        const r = await recordPhoneAttestationValkey(sessionId!, bundle);
        if (!r.ok) {
          // Lost the race. Idempotency mirror of the DDB catch path
          // below: same-device retry → return winning verdict, other-
          // device scanner → 409 session_paired_with_other_device.
          const winningAttPub = (r.existing?.att as { publicKey?: string } | undefined)?.publicKey;
          const sameDevice = winningAttPub === att.publicKey;
          if (r.existing && sameDevice && r.existing.verdict && r.existing.verdict !== 'pending') {
            return jsonResp(200, {
              verdict: 'complete',
              reason: null,
              annotations: {},
              concurrent_loser: true,
            });
          }
          if (r.existing?.att && !sameDevice) {
            return jsonResp(409, {
              error: 'session_paired_with_other_device',
              reason: 'This QR code is already paired with a different device.',
            });
          }
          return jsonResp(409, { error: 'write_conflict' });
        }
      } else {
        try {
          await ddb.send(
            new UpdateCommand({
              TableName: TABLE,
              Key: { PK: `SESSION#${sessionId}`, SK: 'META' },
              UpdateExpression:
                'SET phoneAttestation = :p, verdict = :v, verdictReason = :r, annotations = :a',
              ConditionExpression:
                'attribute_exists(PK) AND attribute_exists(desktopAttestation) AND attribute_not_exists(phoneAttestation)',
              ExpressionAttributeValues: {
                ':p': stored,
                ':v': verdict,
                ':r': reason,
                ':a': annotations,
              },
            })
          );
        } catch (writeErr: unknown) {
          // Two concurrent phone-attest POSTs can race past the read-time
          // `s.phoneAttestation` check (both read pre-write state, both
          // proceed). The loser's conditional write throws
          // ConditionalCheckFailedException. Make this endpoint idempotent
          // by reading the winner's stored verdict and returning that —
          // semantically the device DID pair, the only question is which
          // of two identical attempts gets credit.
          const isConflict =
            (writeErr as { name?: string })?.name === 'ConditionalCheckFailedException';
          if (!isConflict) throw writeErr;
          const existing = await loadSession(sessionId!);
          // Same-device retry (same pubkey) → idempotent success: return
          // the winner's verdict. Different-device second scanner → tell
          // them the session is paired with someone else so their UI
          // doesn't falsely claim success.
          const sameDevice = existing?.phoneAttestation?.publicKey === att.publicKey;
          if (existing && sameDevice && existing.verdict && existing.verdict !== 'pending') {
            return jsonResp(200, {
              verdict: 'complete',
              reason: null,
              annotations: {},
              concurrent_loser: true,
            });
          }
          if (existing?.phoneAttestation && !sameDevice) {
            return jsonResp(409, {
              error: 'session_paired_with_other_device',
              reason: 'This QR code is already paired with a different device.',
            });
          }
          return jsonResp(409, { error: 'write_conflict' });
        }
      }
      // The verdict is ready, but neither browser receives plaintext yet.
      // Push a fixed-size AES-GCM envelope to the desktop and return a separate
      // sealed continuation state to the phone. The authenticated phone-done
      // WS message releases their shared session key. This removes pass/fail
      // timing and response-shape oracles while preserving pre-DONE latency.
      const phoneCompletion = await deliverSealedVerdict(
        { ddb, tableName: TABLE },
        {
          desktopEnv,
          sessionId: sessionId!,
          verdict,
          reason,
          annotations,
          nextDeviceTrust,
          decidedAt: stored.receivedAt,
          now: Math.floor(Date.now() / 1000),
        }
      );
      return jsonResp(200, phoneCompletion);
    }

    case 'GET /api/session/{id}/result': {
      // #10: authenticate. The verdict (and its annotations) used to be
      // readable by anyone who knew the sessionId. Require a valid bootstrap
      // token for THIS session — either role, since both the desktop and the
      // phone are legitimate session participants. The token is the same HMAC
      // wsToken minted at /session/start (desktop holds desktopToken; the
      // phone holds phoneToken from the QR hash). 5-min TTL matches the
      // session TTL, so it covers the whole polling window.
      if (!(await authenticateSessionParticipant(event, sessionId!))) {
        return jsonResp(401, { error: 'result_unauthorized' });
      }
      const s = await loadSession(sessionId!);
      if (!s) return jsonResp(410, { error: 'session_expired' });
      // 204 No Content while still pending — saves polling clients a few
      // bytes per tick and is semantically correct. Real verdicts return
      // 200 + JSON. Client checks status === 204 to decide whether to
      // keep polling.
      if (s.verdict === 'pending') {
        return {
          statusCode: 204,
          headers: { 'Cache-Control': 'no-store' },
          body: '',
        };
      }
      const annotations =
        (s as unknown as { annotations?: Record<string, unknown> }).annotations ?? {};
      const decidedAt = s.phoneAttestation?.receivedAt ?? Math.floor(Date.now() / 1000);
      return jsonResp(
        200,
        await buildSealedResult(
          { ddb, tableName: TABLE },
          {
            sessionId: sessionId!,
            verdict: s.verdict,
            reason: s.verdictReason ?? null,
            annotations,
            nextDeviceTrust: null,
            decidedAt,
            now: Math.floor(Date.now() / 1000),
          }
        )
      );
    }

    // ── Short pairing token: the sparse QR carries /p/<token>, phone redeems ─
    // The desktop mints once it has the envelope. The spatial-frequency poison
    // needs a sparse QR, so we no longer pack {wsUrl,e,pt,n} into the fragment.
    // Auth = the same bootstrap wsToken as /result (only a participant mints).
    case 'POST /api/session/{id}/pair-token': {
      if (!(await authenticateSessionParticipant(event, sessionId!))) {
        return jsonResp(401, { error: 'pair_token_unauthorized' });
      }
      const parsedPairTokenBody = validatePairTokenMintBody(body);
      if (!parsedPairTokenBody.ok) {
        return jsonResp(parsedPairTokenBody.status, parsedPairTokenBody.body);
      }
      const pb = parsedPairTokenBody.body;
      const pairSession = await loadSession(sessionId!);
      if (!pairSession) return jsonResp(404, { error: 'session_not_found' });
      const workerIntegrity = await verifyWorkerIntegrity({
        workerUrl: pb.workerUrl,
        workerSha256: pb.workerSha256,
      });
      if (!workerIntegrity.ok) {
        return jsonResp(workerIntegrity.status, {
          error: workerIntegrity.error,
          reason: workerIntegrity.reason,
        });
      }
      const token = await mintPairToken(pairTokenStore, {
        sessionId: sessionId!,
        wsUrl: pb.wsUrl,
        e: pb.e,
        pt: pb.pt,
        n: pb.n,
        proofRequired: pairSession.proofRequired ?? REQUIRE_PROOF_OF_LIFE,
        freshProofRequired: pairSession.freshProofRequired ?? false,
      });
      try {
        const compression: QrCompression = 'none';
        return jsonResp(
          200,
          await sealPairTokenQr({
            pairOrigin: PAIR_PUBLIC_ORIGIN,
            token,
            suffix: pb.debug === true ? '?debug=true' : '',
            clientPublicKey: pb.cPub,
            compression,
          })
        );
      } catch (e) {
        console.warn(`[pair] pair-token seal failed, refusing plaintext: ${(e as Error).message}`);
        return jsonResp(400, { error: 'bad_client_pubkey' });
      }
    }

    // Phone redeems the short token (single-use) for the connection blob.
    case 'POST /api/pair-token/redeem': {
      const rt = (body as { token?: unknown }).token;
      if (typeof rt !== 'string') return jsonResp(400, { error: 'missing_token' });
      const blob = await redeemPairToken(pairTokenStore, rt);
      if (!blob) return jsonResp(410, { error: 'token_expired_or_used' });
      return jsonResp(200, blob);
    }

    // ── Embeddable widget: mint a signed verdict token (siteverify) ──────
    // The desktop (embed iframe) calls this after the paired verdict, then
    // postMessages the token to the host page. Auth is the same bootstrap
    // wsToken as /result — only a session participant can mint.
    case 'GET /api/session/{id}/verdict-token': {
      return mintVerdictTokenRequest(event, sessionId!);
    }

    // ── Server-to-server token verification (the host's backend calls this) ─
    case 'POST /api/verify': {
      return verifyVerdictRequest(body);
    }

    default:
      // Catch-all returns 200 + error body so CloudFront's errorResponses[404]
      // (which rewrites to the SPA HTML) doesn't turn an unknown API path into
      // unparseable HTML. See the long road that led here in commit history.
      return jsonResp(200, { error: 'no_matching_route', routeKey });
  }
};

// ── Warmer wiring ──────────────────────────────────────────────────────
// EventBridge fires {source:'serverless-plugin-warmup'} every 5 min (see
// pair-stack.ts → PairApiWarmupRule). The middleware below detects that,
// pre-hydrates caches, and short-circuits — the route switch above never
// sees the synthetic event.
//
// @middy/warmup v6 dropped its onWarmup callback (it's now a pure
// short-circuiter), so we roll a tiny middleware that does both.
const isWarmingUp = (event: unknown): boolean => {
  if (!event || typeof event !== 'object') return false;
  const e = event as { source?: unknown; warmup?: unknown };
  return e.source === 'serverless-plugin-warmup' || e.warmup === true;
};

const warmupMiddleware = (): MiddlewareObj<unknown, unknown> => ({
  before: async (request) => {
    if (!isWarmingUp(request.event)) return;
    // Pre-fetch the device-trust secret so the first real /phone-attest
    // after a cold container start skips the SecretsManager round-trip,
    // and drive one DDB call to warm the underlying HTTPS pool.
    try {
      await Promise.all([
        getTrustSecret(),
        ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: '__warmup__', SK: 'META' } })),
      ]);
    } catch (e) {
      console.warn(`[pair] warmup hydration failed: ${(e as Error).message}`);
    }
    // Returning a value short-circuits the rest of the chain — the real
    // lambdaHandler (and the route switch) never runs for warmup pings.
    request.response = { warmed: true };
  },
});

export const handler = middy(lambdaHandler).use(warmupMiddleware());
