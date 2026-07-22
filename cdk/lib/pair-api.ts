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
 *     → 204 while pending; otherwise { status: 'sealed', envelope, revealKey? }
 *     Authenticated desktop fallback when WebSocket result delivery is missed.
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
import { mintBootstrapToken, openEnvelope, verifyBootstrapToken } from './ws-handler';
import {
  isValkeySessionsEnabled,
  mgetSession,
  recordDesktopAttestationValkey,
  recordPhoneAttestationValkey,
  claimArgusValkey,
} from './session-store';
import { getViewerIp, jsonResp, originAllowed, parseBody } from './pair-api/shared/http';
import { validateSsoAttestation } from './pair-api/attestation/envelope';
import { getTrustSecret, mintDeviceTrust, verifyDeviceTrust } from './pair-api/attestation/trust';
import { createDdbPasskeyStore } from './pair-api/passkey-store';
import { verifyProofOfLife } from './pair-api/proof-of-life';
import { handleTelemetryRoute } from './pair-api/telemetry-routes';
import { claimArgusSessionIdDdb } from './pair-api/argus-session-claim';
import { classifyScan, summarizeDesktopScan } from './pair-api/projection-verdict';
import { mintReturnCode } from './sso-continuity';
import { getVerdictSecret } from './pair-api/verdict-token';
import { createVerdictTokenMintHandler } from './pair-api/verdict-token-mint-route';
import { createVerdictVerificationHandler } from './pair-api/verdict-verification-route';
import { createSessionResultHandler } from './pair-api/session-result-route';
import { mintPairToken, redeemPairToken, type KvStore } from './pair-api/pair-token';
import { createPairTokenMintHandler } from './pair-api/pair-token-mint-route';
import { createDesktopAttestationHandler } from './pair-api/desktop-attestation-route';
import { createPhoneAttestationCommitter } from './pair-api/phone-attestation-commit';
import { preparePhoneAttestation } from './pair-api/phone-attestation-request';
import { createPhoneAttestationHandler } from './pair-api/phone-attestation-route';
import {
  buildSealedResult,
  deliverSealedVerdict,
  isVerdictReleased,
} from './pair-api/verdict-disclosure';
import { fetchProjection, projectionValue } from './pair-api/projection-client';
import { mintApprovalToken, SSO_APPROVAL_TTL_SECONDS } from './pair-api/sso-approval';
import { createSsoApprovalRedemptionHandler } from './pair-api/sso-approval-route';
import { challengeSsoSession } from './pair-api/sso-challenge';
import { storeSsoChallenge } from './pair-api/sso-challenge-store';
import { createSsoMerchantApprovalHandler } from './pair-api/sso-merchant-approval-route';
import { ssoChallengeResp, ssoStartResp } from './pair-api/sso-route-response';
import { validateSsoSession } from './pair-api/sso-validation';
import { verifySsoValidationProof } from './pair-api/sso-validation-proof';
import { ssoValidationResponse } from './pair-api/sso-validation-response';
import { storeSsoValidation } from './pair-api/sso-validation-store';
import { buildSessionStartRateLimit } from './pair-api/session-start-rate-limit';
import { sealPairTokenQr } from './pair-api/sealed-qr';
import { createServerQrRendererPrimer } from './pair-api/qr-renderer-primer';
import { createPairApiWarmupMiddleware } from './pair-api/warmup';
import { verifyWorkerIntegrity } from './pair-api/worker-integrity';
import type { StoredHostPreflight } from './pair-api/host-preflight';
import { collectHostPreflightEvidence } from './pair-api/host-preflight-evidence';
import { prepareAndStoreStartedSession } from './pair-api/session-start-store';
import { startPairSession } from './pair-api/session-start';
import { startSsoSession } from './pair-api/sso-start';
import type { SsoSessionItem } from './pair-api/sso-session';
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
const primeQrRenderer = createServerQrRendererPrimer(PAIR_PUBLIC_ORIGIN);
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
async function claimArgusSessionId(
  argusSessionId: string,
  pairSessionId: string,
  role: 'host' | 'desktop' | 'phone'
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (isValkeySessionsEnabled()) {
    return claimArgusValkey(argusSessionId, pairSessionId, role);
  }
  return claimArgusSessionIdDdb({ argusSessionId, pairSessionId, role }, { ddb, tableName: TABLE });
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

function startPairSessionRequest(body: Record<string, unknown>, viewerIp: string) {
  return startPairSession(body, viewerIp, {
    allowStart: checkSessionStartRateLimit,
    storeSession: (session) => prepareAndStoreStartedSession(session, { ddb, tableName: TABLE }),
    mintBootstrapToken,
    newSessionId: randomUUID,
    newNonce: () => randomBytes(32).toString('base64url'),
    nowEpochSeconds: () => Math.floor(Date.now() / 1000),
    sessionTtlSeconds: SESSION_TTL_SECONDS,
    requireProofOfLife: REQUIRE_PROOF_OF_LIFE,
    wsApiUrl: process.env.WS_API_URL ?? null,
    warn: (message) => console.warn(message),
  });
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

async function storeDesktopAttestation(
  sessionId: string,
  stored: StoredDesktopAttestation
): Promise<boolean> {
  if (isValkeySessionsEnabled()) {
    return recordDesktopAttestationValkey(sessionId, stored as unknown as Record<string, unknown>);
  }
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { PK: `SESSION#${sessionId}`, SK: 'META' },
      UpdateExpression: 'SET desktopAttestation = :d',
      ConditionExpression: 'attribute_exists(PK) AND attribute_not_exists(desktopAttestation)',
      ExpressionAttributeValues: { ':d': stored },
    })
  );
  return true;
}

async function loadSsoSession(sessionId: string): Promise<SsoSessionItem | null> {
  const res = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { PK: `SSO#${sessionId}`, SK: 'META' } })
  );
  return (res.Item as SsoSessionItem | undefined) ?? null;
}

function startSsoSessionRequest(body: Record<string, unknown>) {
  return startSsoSession(body, {
    callbackOrigins: SSO_CALLBACK_ORIGINS,
    validateAttestation: (requestBody, cpi) =>
      validateSsoAttestation(requestBody, { role: 'merchant-start', cpi }),
    fetchProjection: async (argusSessionId) =>
      projectionValue(await fetchProjection(argusSessionId)),
    storeSession: async (session) => {
      await ddb.send(
        new PutCommand({
          TableName: TABLE,
          Item: session,
          ConditionExpression: 'attribute_not_exists(PK)',
        })
      );
    },
    newSessionId: randomUUID,
    newNonce: () => randomBytes(32).toString('base64url'),
    newMerchantSessionId: randomUUID,
    nowEpochSeconds: () => Math.floor(Date.now() / 1000),
    sessionTtlSeconds: SESSION_TTL_SECONDS,
    requireProofOfLife: REQUIRE_PROOF_OF_LIFE,
  });
}

function challengeSsoSessionRequest(sessionId: string, body: Record<string, unknown>) {
  return challengeSsoSession(sessionId, body, {
    loadSession: loadSsoSession,
    validateAttestation: validateSsoAttestation,
    fetchProjection: async (argusSessionId) =>
      projectionValue(await fetchProjection(argusSessionId)),
    mintReturnCode: (id) => mintReturnCode({ sessionId: id, ttlSeconds: 90 }),
    storeChallenge: (challenge) => storeSsoChallenge(challenge, { ddb, tableName: TABLE }),
  });
}

function validateSsoSessionRequest(
  sessionId: string,
  body: Record<string, unknown>,
  requesterIp: string
) {
  return validateSsoSession(sessionId, body, requesterIp, {
    loadSession: loadSsoSession,
    validateAttestation: validateSsoAttestation,
    fetchProjection: async (argusSessionId) =>
      projectionValue(await fetchProjection(argusSessionId)),
    verifyProof: (input) =>
      verifySsoValidationProof(input, {
        verifyDeviceTrust,
        verifyProofOfLife: (proof) =>
          verifyProofOfLife({
            ...proof,
            rpId: WEBAUTHN_RP_ID,
            expectedOrigin: WEBAUTHN_EXPECTED_ORIGIN,
            allowTestAuthenticators: ALLOW_TEST_AUTHENTICATORS,
            passkeyStore,
            deviceTrustFormat: 'device_trust',
          }),
      }),
    mintApprovalToken,
    mintDeviceTrust,
    storeValidation: (validation) => storeSsoValidation(validation, { ddb, tableName: TABLE }),
    nowEpochSeconds: () => Math.floor(Date.now() / 1000),
    approvalTtlSeconds: SSO_APPROVAL_TTL_SECONDS,
  });
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
const getSessionResult = createSessionResultHandler({
  authenticateParticipant: authenticateSessionParticipant,
  loadSession,
  sealResult: (input) => buildSealedResult({ ddb, tableName: TABLE }, input),
});
const mintPairTokenRequest = createPairTokenMintHandler({
  authenticateParticipant: authenticateSessionParticipant,
  loadSession,
  verifyWorkerIntegrity,
  mintToken: (blob) => mintPairToken(pairTokenStore, blob),
  sealQr: sealPairTokenQr,
  pairOrigin: PAIR_PUBLIC_ORIGIN,
  proofRequiredByDefault: REQUIRE_PROOF_OF_LIFE,
  logWarn: console.warn,
});
const attestDesktop = createDesktopAttestationHandler({
  loadSession,
  prepareDesktopAttestation: (body, session) =>
    prepareDesktopAttestation(body, session, claimArgusSessionId),
  storeDesktopAttestation,
  classifyDesktop: async (argusSessionId) => {
    const projection = projectionValue(await fetchProjection(argusSessionId));
    const scan = classifyScan(projection, 'desktop');
    return scan ? summarizeDesktopScan(scan) : null;
  },
  logWarn: console.warn,
});

const commitPhoneAttestation = createPhoneAttestationCommitter({
  useValkey: isValkeySessionsEnabled,
  recordValkey: recordPhoneAttestationValkey,
  updateDdb: async ({ sessionId, stored, verdict, reason, annotations }) => {
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
  },
  loadSession,
});
const preparePhoneAttestationRequest = (body: Record<string, unknown>, sessionId: string) =>
  preparePhoneAttestation(body, sessionId, {
    loadSession,
    openDesktopEnvelope: openEnvelope,
    claimPhoneArgusSession: (argusSessionId, pairSessionId) =>
      claimArgusSessionId(argusSessionId, pairSessionId, 'phone'),
    nowEpochSeconds: () => Math.floor(Date.now() / 1000),
  });
const attestPhone = createPhoneAttestationHandler({
  prepare: preparePhoneAttestationRequest,
  verifyDeviceTrust,
  verifyProof: (input) =>
    verifyProofOfLife({
      ...input,
      rpId: WEBAUTHN_RP_ID,
      expectedOrigin: WEBAUTHN_EXPECTED_ORIGIN,
      allowTestAuthenticators: ALLOW_TEST_AUTHENTICATORS,
      passkeyStore,
      deviceTrustFormat: 'device_trust_redeem',
    }),
  collectHostEvidence: collectHostPreflightEvidence,
  fetchPhoneProjection: async (argusSessionId) =>
    projectionValue(await fetchProjection(argusSessionId)),
  mintDeviceTrust,
  commit: commitPhoneAttestation,
  deliverVerdict: (input) => deliverSealedVerdict({ ddb, tableName: TABLE }, input),
  nowEpochSeconds: () => Math.floor(Date.now() / 1000),
  proofRequiredByDefault: REQUIRE_PROOF_OF_LIFE,
  logInfo: (message) => console.info(message),
  logWarn: (message) => console.warn(message),
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
    'POST /api/verify',
    'POST /api/pair-token/redeem',
    'POST /api/phone-perf',
    'POST /api/sso/telemetry',
  ]);
  if (!idLessRoutes.has(routeKey) && !SESSION_ID_RE.test(sessionId ?? '')) {
    return jsonResp(400, { error: 'invalid_session_id' });
  }
  const body = parseBody(event.body);
  if (body === null) return jsonResp(400, { error: 'invalid_body' });
  const telemetryResponse = handleTelemetryRoute(routeKey, body, event);
  if (telemetryResponse) return telemetryResponse;

  switch (routeKey) {
    case 'POST /api/session/start': {
      const response = await startPairSessionRequest(body, getViewerIp(event));
      return jsonResp(response.status, response.body);
    }

    case 'POST /api/sso/start': {
      const started = await startSsoSessionRequest(body);
      if (!started.ok) return jsonResp(started.status, started.body);
      return ssoStartResp(started.sessionId, started.session, started.failureReturnUrl);
    }

    case 'POST /api/sso/{id}/challenge': {
      const challenged = await challengeSsoSessionRequest(sessionId!, body);
      if (!challenged.ok) return jsonResp(challenged.status, challenged.body);
      return ssoChallengeResp(
        challenged.sessionId,
        challenged.returnCode,
        challenged.cpi,
        challenged.hasMerchantCallback
      );
    }

    case 'POST /api/sso/{id}/validate': {
      const validated = await validateSsoSessionRequest(sessionId!, body, getViewerIp(event));
      if (!validated.ok) return jsonResp(validated.status, validated.body);
      return ssoValidationResponse(validated);
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
      return attestDesktop(body, sessionId!);
    }

    case 'POST /api/session/{id}/phone-attest': {
      return attestPhone(body, sessionId!, getViewerIp(event));
    }

    case 'GET /api/session/{id}/result': {
      return getSessionResult(event, sessionId!);
    }

    // ── Short pairing token: the sparse QR carries /p/<token>, phone redeems ─
    // The desktop mints once it has the envelope. The spatial-frequency poison
    // needs a sparse QR, so we no longer pack {wsUrl,e,pt,n} into the fragment.
    // Auth = the same bootstrap wsToken as /result (only a participant mints).
    case 'POST /api/session/{id}/pair-token': {
      return mintPairTokenRequest(event, sessionId!, body);
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
// The alias heater sends {source:'serverless-plugin-warmup'} every 10 seconds.
// The middleware pre-hydrates caches and primes the CPU-heavy PNG renderer,
// then short-circuits so the route switch never sees the synthetic event.
//
export const handler = middy(lambdaHandler).use(
  createPairApiWarmupMiddleware({
    hydrateTrustSecret: getTrustSecret,
    warmStoreConnection: () =>
      ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: '__warmup__', SK: 'META' } })),
    primeQrRenderer,
    now: Date.now,
    logInfo: console.info,
    logWarn: console.warn,
  })
);
