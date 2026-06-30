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
 *   POST /api/session/{id}/desktop-attest   body: { argusSessionId, attestation }
 *     → 200 ok
 *     Verifies the envelope signature, binds the desktop scan to this session.
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
import { createHash, randomBytes, randomUUID } from 'crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server';
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
  WebAuthnCredential,
} from '@simplewebauthn/server';
import middy from '@middy/core';
import type { MiddlewareObj } from '@middy/core';
import {
  isOAuthProvider,
  verifyOAuth,
  type OAuthProvider,
  type OAuthVerifyResult,
} from './oauth-providers';
import { mintBootstrapToken, openEnvelope, postToPeer, verifyBootstrapToken } from './ws-handler';
import {
  isValkeySessionsEnabled,
  mgetSession,
  startSessionValkey,
  recordDesktopAttestationValkey,
  recordPhoneAttestationValkey,
  claimArgusValkey,
  setRaffleHashValkey,
  type PhoneBundle,
} from './session-store';
import { getViewerIp, jsonResp, originAllowed, parseBody } from './pair-api/shared/http';
import {
  validateAttestInput,
  verifyAttestation,
  type AttestationInput,
  type EnvelopeDecoded,
} from './pair-api/attestation/envelope';
import {
  getTrustSecret,
  mintDeviceTrust,
  verifyDeviceTrust,
  type DeviceTrustVerifyResult,
} from './pair-api/attestation/trust';
import { evaluateSsoContinuity, mintReturnCode, type SsoLegProfile } from './sso-continuity';
import { getVerdictSecret, signVerdict, verifyVerdictToken } from './pair-api/verdict-token';

const TABLE = process.env.TABLE_NAME!;

/** Public merchant client id embedded in the widget; attributes a pairing. */
const CPI_FORMAT = /^argus_cpi_(test|live)_[A-Za-z0-9]{10,40}$/;

const MERCHANT_API_URL = process.env.MERCHANT_API_URL || '';
const MERCHANT_API_CREDENTIAL = process.env.MERCHANT_API_CREDENTIAL || '';
const MERCHANT_CPI = process.env.MERCHANT_CPI || '';

const SESSION_TTL_SECONDS = 300; // 5 minutes
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Verdict thresholds (per spec). Individual = max(automation, device_tampering,
// network_tampering) for one side. Total = sum of the two sides' individual
// scores.
const INDIVIDUAL_SCORE_LIMIT = 30;
const TOTAL_SCORE_LIMIT = 50;
// #13: PAT is a strong Apple-device signal but FARMABLE (the upstream
// /v1/pat-attestation challenge is unbound + not single-use). So PAT is no
// longer an unconditional golden ticket. It EXTENDS the per-side score
// tolerance from INDIVIDUAL_SCORE_LIMIT up to PAT_SCORE_FLOOR for an
// attested side, but cannot whitewash hard automation/tampering evidence
// (score >= floor), and no longer exempts the datacenter or total-score
// checks. A genuine Apple device scores well under 30, so this never costs a
// legit PAT user; it only denies a farmed PAT stapled onto a dirty device.
const PAT_SCORE_FLOOR = 70;

// WebAuthn RP identifier. Must match the rpId the phone passes to
// startRegistration on the client (window.location.hostname).
const WEBAUTHN_RP_ID = process.env.WEBAUTHN_RP_ID || 'captcha-dev-jw.argus.pw';
const WEBAUTHN_EXPECTED_ORIGIN = `https://${WEBAUTHN_RP_ID}`;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

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
  role: 'desktop' | 'phone'
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

// ── projection freshness ──────────────────────────────────────────────────
//
// Secondary defense. Even if the single-use ledger somehow misses (e.g.,
// race resolved in attacker's favor on a multi-region write, or a future
// edit drops the ledger), require the projection's scan timestamp to be
// recent. 180s comfortably covers the user flow: desktop scan + QR + phone
// scan + tap is typically 30-90s; 180s leaves slack for slow phones.
//
// Strict: a missing created_at on the projection (legacy records pre-
// dating the field) is treated as STALE. Real argus scans backfill this
// field; only ancient cached projections wouldn't have it.
const PROJECTION_FRESHNESS_WINDOW_SECONDS = 180;

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

function projectionAgeSeconds(p: MerchantProjection | null): number | null {
  if (!p || typeof p.created_at !== 'number') return null;
  return Math.round((Date.now() - p.created_at) / 1000);
}

function isProjectionFresh(p: MerchantProjection | null): boolean {
  const age = projectionAgeSeconds(p);
  if (age === null) return false;
  return age >= -PROJECTION_FRESHNESS_WINDOW_SECONDS && age <= PROJECTION_FRESHNESS_WINDOW_SECONDS;
}

// ── Raffle / leaderboard ──────────────────────────────────────────────────
//
// After a paired verdict, the desktop can submit a handle to claim one
// leaderboard entry. Three independent rate-limit buckets, each capped per
// rolling hour, ALL scoped by the desktop's site host so one phone (or
// desktop, or UA+IP) can spend its 5/hr separately on each site:
//   1. phone device pubkey + site   (SDK persistent key — strongest anti-Sybil)
//   2. desktop device pubkey + site (same on the host side)
//   3. UA + IP + site               (weakest, catches header-swap reruns)
// "Site" is the desktop's loaded alias (Origin header), not a fixed string —
// CloudFront's ALL_VIEWER_EXCEPT_HOST_HEADER policy strips Host, so Origin is
// the trustworthy signal here (and originAllowed has already validated it
// against ALLOWED_ORIGINS by the time we read it).
const RAFFLE_FALLBACK_SITE = 'unknown';
const RAFFLE_BUCKET_MAX = 3;
const RAFFLE_BUCKET_TTL_SECONDS = 2 * 3600;
const RAFFLE_LEADERBOARD_TOP = 25;
const HANDLE_RE = /^[a-z0-9._@-]{3,64}$/;

const md5hex = (s: string) => createHash('md5').update(s).digest('hex');

function normalizeHandle(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const h = raw.trim().toLowerCase();
  return HANDLE_RE.test(h) ? h : null;
}

/**
 * Hash the submitted handle for storage + display. The doubled
 * `${h}::${h}` input is a cheap domain-separator so the stored hash
 * isn't directly lookup-able against a rainbow table of plain
 * md5(email). md5 is fine here — this is privacy hygiene, not auth.
 *
 * Returns:
 *   - `hash`: full 32-char hex (used as the DDB partition key)
 *   - `code`: short public identifier (`xxxx-xxxx`, 8 hex chars +
 *             dash, ~4B-space — collision-safe up to ~65k entries by
 *             the birthday bound, which comfortably covers any contest
 *             this site will run)
 */
function handleHash(h: string): { hash: string; code: string } {
  const hash = md5hex(`${h}::${h}`);
  const code = `${hash.slice(0, 4)}-${hash.slice(4, 8)}`;
  return { hash, code };
}

function hashToCode(hash: string): string {
  return `${hash.slice(0, 4)}-${hash.slice(4, 8)}`;
}

async function incrementLeaderboard(handle: string): Promise<{
  hash: string;
  code: string;
  count: number;
}> {
  const { hash, code } = handleHash(handle);
  const updated = await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { PK: `HANDLE#${hash}`, SK: 'CT' },
      // `lbPk` and `code` aren't used by the increment itself — they
      // exist so LeaderboardIndex (GSI) can serve the top-N Query
      // without a Scan. `lbPk` is a constant partition key all
      // leaderboard rows share; `code` is the user-facing 6-char
      // handle code projected into the index so the read doesn't
      // have to recompute it from PK on every page view.
      UpdateExpression: 'ADD ct :one SET lastEntryAt = :t, lbPk = :lb, code = :code',
      ExpressionAttributeValues: {
        ':one': 1,
        ':t': Math.floor(Date.now() / 1000),
        ':lb': 'LB',
        ':code': code,
      },
      ReturnValues: 'ALL_NEW',
    })
  );
  const count = Number((updated.Attributes as { ct?: number } | undefined)?.ct ?? 1);
  return { hash, code, count };
}

/**
 * Pull the desktop's site host from the Origin header. CloudFront forwards
 * Origin (it's not in the "except" list of ALL_VIEWER_EXCEPT_HOST_HEADER),
 * and originAllowed has already validated it against ALLOWED_ORIGINS.
 */
function desktopSiteHost(event: { headers?: Record<string, string | undefined> }): string {
  const raw = event.headers?.origin ?? event.headers?.Origin ?? '';
  try {
    return new URL(raw).host.toLowerCase();
  } catch {
    return RAFFLE_FALLBACK_SITE;
  }
}

interface RateLimitResult {
  ok: boolean;
  tripped?: string;
  siteHash?: string;
}

interface RatePeekResult {
  /** Worst used count across the three buckets. */
  used: number;
  /** Configured cap (RAFFLE_BUCKET_MAX). */
  cap: number;
  /** Whether at least one bucket is at the cap (entry would 429). */
  tripped: boolean;
  /** Epoch seconds when the hour bucket rolls over. */
  resetAt: number;
  siteHash: string;
}

/**
 * Read-only counterpart to `checkRaffleRateLimits`. Probes each of the
 * three buckets WITHOUT incrementing so we can answer "would entry
 * succeed right now?" without consuming a slot. Used by GET
 * /api/raffle/status so the desktop UI can hide the raffle form when
 * the user has already hit their hourly cap.
 */
/**
 * Inputs for the raffle rate-limit gate. Five orthogonal axes, any one
 * tripping → 429.
 *
 *   - phonePub:     Argus pubkey from the phone scan (defeated by phone
 *                   incognito, since IDB regenerates the persistent key)
 *   - desktopPub:   same on the desktop side
 *   - desktopUa+desktopIp: stable per desktop browser instance on a
 *                   network; switches when attacker rotates browsers
 *   - phoneUa+phoneIp: stable per physical phone regardless of incognito
 *                   (UA never changes mid-session, IP rarely does);
 *                   captured from the phone's Argus projection at
 *                   phone-attest time and persisted on the session row
 *   - authIdentity: passkey credentialId OR oauth subject. Stable across
 *                   incognito (iCloud Keychain / OAuth providers don't
 *                   reset per-browser-mode). Skipped when neither path
 *                   produced an identity (e.g. silent reauth on a fresh
 *                   browser).
 */
interface RateLimitInputs {
  phonePub: string;
  desktopPub: string;
  desktopUa: string;
  desktopIp: string;
  phoneUa: string;
  phoneIp: string;
  authIdentity: string | null;
  siteHost: string;
}

/**
 * Resolve the auth-identity string from a session's annotations. Preferred
 * source order:
 *   1. OAuth subject (Google sub / GitHub id / Facebook user_id) — stable
 *      per provider account forever
 *   2. WebAuthn credentialId — stable per passkey (iCloud Keychain /
 *      Google Password Manager keep this across incognito)
 *   3. Phone Argus pubkey from the device-trust silent-reauth path —
 *      stable for any user whose HMAC token survived (implies they're
 *      NOT in incognito, so this is a useful fallback)
 * Returns null when none of the above are available — caller skips the
 * identity bucket and relies on the other four axes.
 */
function resolveRaffleAuthIdentity(
  annotations: Record<string, unknown>,
  session: { phoneAttestation?: { publicKey?: string } }
): string | null {
  const sub = annotations.phone_oauth_subject;
  if (typeof sub === 'string' && sub.length > 0) return `oauth:${sub}`;
  const credId = annotations.phone_webauthn_credential_id;
  if (typeof credId === 'string' && credId.length > 0) return `passkey:${credId}`;
  const trustRedeemed = annotations.phone_device_trust_redeemed === true;
  const pub = session.phoneAttestation?.publicKey;
  if (trustRedeemed && typeof pub === 'string' && pub.length > 0) {
    return `argus-pub:${pub}`;
  }
  return null;
}

/** Build the per-axis bucket keys. Identity bucket omitted when caller
 *  has no identity to bind to. */
function buildRaffleBuckets(inputs: RateLimitInputs): { siteHash: string; buckets: string[] } {
  const siteHash = md5hex(inputs.siteHost);
  const buckets = [
    md5hex(inputs.phonePub + siteHash),
    md5hex(inputs.desktopPub + siteHash),
    md5hex(inputs.desktopUa + inputs.desktopIp + siteHash),
    md5hex(inputs.phoneUa + inputs.phoneIp + siteHash),
  ];
  if (inputs.authIdentity) {
    buckets.push(md5hex(inputs.authIdentity + siteHash));
  }
  return { siteHash, buckets };
}

/**
 * USE_VALKEY_RATE_LIMITS=true switches the 5 rate-limit buckets from
 * DDB (5 UpdateCommand / 5 GetCommand per call) to Valkey (1 pipeline
 * of 5 INCR-or-GET commands). The Lambda must be VPC-attached with
 * VALKEY_ENDPOINT set; otherwise the DDB path runs.
 *
 * Both code paths are shipped intentionally — flip the env flag to
 * roll back without a code redeploy.
 */
function isValkeyRateLimitsEnabled(): boolean {
  return process.env.USE_VALKEY_RATE_LIMITS === 'true';
}

async function peekRaffleRateLimits(inputs: RateLimitInputs): Promise<RatePeekResult> {
  const { siteHash, buckets } = buildRaffleBuckets(inputs);
  const hour = Math.floor(Date.now() / 3_600_000);
  const resetAt = (hour + 1) * 3600;

  if (isValkeyRateLimitsEnabled()) {
    const { getValkey } = await import('./valkey-client');
    const valkey = getValkey();
    const pipeline = valkey.pipeline();
    for (const k of buckets) {
      pipeline.get(`pair:rl:${k}:${hour}`);
    }
    const results = (await pipeline.exec()) ?? [];
    let used = 0;
    for (const [, val] of results) {
      const n = Number(val ?? 0);
      if (n > used) used = n;
    }
    return {
      used,
      cap: RAFFLE_BUCKET_MAX,
      tripped: used >= RAFFLE_BUCKET_MAX,
      resetAt,
      siteHash,
    };
  }

  // DDB path — fallback / rollback target.
  const reads = await Promise.all(
    buckets.map((k) =>
      ddb.send(
        new GetCommand({
          TableName: TABLE,
          Key: { PK: `RL#${k}#${hour}`, SK: 'CT' },
          ConsistentRead: false,
          ProjectionExpression: 'ct',
        })
      )
    )
  );
  let used = 0;
  for (const r of reads) {
    const ct = Number((r.Item as { ct?: number } | undefined)?.ct ?? 0);
    if (ct > used) used = ct;
  }
  return {
    used,
    cap: RAFFLE_BUCKET_MAX,
    tripped: used >= RAFFLE_BUCKET_MAX,
    resetAt,
    siteHash,
  };
}

async function checkRaffleRateLimits(inputs: RateLimitInputs): Promise<RateLimitResult> {
  const { siteHash, buckets } = buildRaffleBuckets(inputs);
  const hour = Math.floor(Date.now() / 3_600_000);
  const ttl = Math.floor(Date.now() / 1000) + RAFFLE_BUCKET_TTL_SECONDS;

  if (isValkeyRateLimitsEnabled()) {
    const { getValkey } = await import('./valkey-client');
    const valkey = getValkey();
    // One pipelined round-trip: each EVAL atomically reads the counter,
    // returns it unchanged if over cap, otherwise INCRs (and EXPIREs on
    // first hit). Lua serializes the GET-check-INCR sequence so two
    // concurrent requests can't both slip past cap. Same hard-stop
    // semantics as the DDB ConditionalCheck path.
    const pipeline = valkey.pipeline();
    for (const k of buckets) {
      pipeline.rlIncr(`pair:rl:${k}:${hour}`, RAFFLE_BUCKET_MAX, RAFFLE_BUCKET_TTL_SECONDS);
    }
    const results = (await pipeline.exec()) ?? [];
    for (let i = 0; i < results.length; i++) {
      const [err, val] = results[i];
      if (err) throw err;
      if (Number(val ?? 0) > RAFFLE_BUCKET_MAX) {
        // Cap held — script returned the pre-existing over-cap value
        // without incrementing. Same axis-naming convention as the DDB
        // path (first 8 chars of the bucket hash).
        return { ok: false, tripped: buckets[i].slice(0, 8), siteHash };
      }
      // val === RAFFLE_BUCKET_MAX is the edge case where this caller
      // is the LAST one allowed; let it through but note that any
      // subsequent caller for the same bucket trips.
    }
    return { ok: true, siteHash };
  }

  // DDB path — fallback / rollback target. allSettled keeps the loop
  // simple: every bucket's conditional update runs independently;
  // any one rejecting with ConditionalCheckFailed is a 429 trip.
  const results = await Promise.allSettled(
    buckets.map((k) =>
      ddb.send(
        new UpdateCommand({
          TableName: TABLE,
          Key: { PK: `RL#${k}#${hour}`, SK: 'CT' },
          UpdateExpression: 'ADD ct :one SET expiresAt = if_not_exists(expiresAt, :ttl)',
          ConditionExpression: 'attribute_not_exists(ct) OR ct < :max',
          ExpressionAttributeValues: {
            ':one': 1,
            ':max': RAFFLE_BUCKET_MAX,
            ':ttl': ttl,
          },
        })
      )
    )
  );
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'rejected') {
      const isConflict =
        (r.reason as { name?: string } | undefined)?.name === 'ConditionalCheckFailedException';
      if (isConflict) return { ok: false, tripped: buckets[i].slice(0, 8), siteHash };
      throw r.reason;
    }
  }
  return { ok: true, siteHash };
}

// ── #10: throttle POST /session/start ──────────────────────────────────
// Session creation was unbounded — 20 concurrent → 20×200 (verified live
// 2026-06-24), enabling attempt-volume / resource abuse. Cap per source IP
// per fixed window. Generous enough for a shared NAT / enthusiastic tester,
// tight enough to deny a single-IP farm. Hardcoded (like RAFFLE_BUCKET_MAX)
// to avoid CDK env plumbing.
const SESSION_START_RL_MAX = 20; // allow this many starts …
const SESSION_START_RL_WINDOW_SEC = 60; // … per IP per this window
/**
 * Returns true if a new session-start from `ip` is allowed. Single fixed
 * window bucket. Note: we pass `max + 1` to the Valkey rlIncr cap and allow
 * `<= max` — the Lua caps the counter AT the cap and the raffle path's
 * strict `> cap` check never trips at the boundary; `max + 1` makes the
 * Valkey semantics match the DDB `ct < max` path (both allow exactly `max`).
 */
async function checkSessionStartRateLimit(ip: string): Promise<boolean> {
  const max = SESSION_START_RL_MAX;
  const windowSec = SESSION_START_RL_WINDOW_SEC;
  const win = Math.floor(Date.now() / (windowSec * 1000));
  const bucket = createHash('sha256')
    .update(`ss:${ip || 'unknown'}`)
    .digest('hex')
    .slice(0, 32);
  if (isValkeyRateLimitsEnabled()) {
    const { getValkey } = await import('./valkey-client');
    const count = await getValkey().rlIncr(`pair:rl:${bucket}:${win}`, max + 1, windowSec + 60);
    return Number(count ?? 0) <= max;
  }
  // DDB fallback: ADD ct while ct < max (allows exactly `max`, then trips).
  const ttl = Math.floor(Date.now() / 1000) + windowSec + 60;
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { PK: `RL#${bucket}#${win}`, SK: 'CT' },
        UpdateExpression: 'ADD ct :one SET expiresAt = if_not_exists(expiresAt, :ttl)',
        ConditionExpression: 'attribute_not_exists(ct) OR ct < :max',
        ExpressionAttributeValues: { ':one': 1, ':max': max, ':ttl': ttl },
      })
    );
    return true;
  } catch (e) {
    if ((e as { name?: string }).name === 'ConditionalCheckFailedException') return false;
    throw e;
  }
}

type Verdict = 'pending' | 'paired' | 'failed';

interface StoredAttestation extends AttestationInput {
  argusSessionId: string;
  receivedAt: number;
  envelopeDecoded: EnvelopeDecoded;
}

interface SessionItem {
  PK: string;
  SK: string;
  nonce: string;
  expiresAt: number;
  cpi?: string | null;
  desktopAttestation?: StoredAttestation;
  phoneAttestation?: StoredAttestation;
  verdict: Verdict;
  verdictReason?: string;
}

interface SsoSessionItem {
  PK: string;
  SK: 'META';
  nonce: string;
  merchantSessionId: string;
  startProfile: SsoLegProfile;
  challengeProfile?: SsoLegProfile;
  validateProfile?: SsoLegProfile;
  returnCodeHash?: string;
  returnCodeExpiresAt?: number;
  returnCodeConsumedAt?: number;
  claimHash?: string;
  claimEnteredAt?: number;
  verdict: 'pending' | 'approved' | 'failed';
  verdictReason?: string;
  expiresAt: number;
  approvedAt?: number;
}

// ── Verdict pipeline ───────────────────────────────────────────────────────

interface MerchantProjection {
  automation?: number;
  device_tampering?: number;
  network_tampering?: number;
  /** Epoch ms; null on legacy records. From ms-argus-api MerchantSafeResponse. */
  created_at?: number | null;
  verdict?: string;
  identification?: {
    browserDetails?: {
      device?: string | null;
      os?: string | null;
    };
  };
  tags?: string[];
  // Apple Private Access Token — present on Safari/iOS when issuer succeeds.
  // Exact field name in the projection varies; we look in both `pat_*` and
  // tag form. See ms-argus-api `project_argus_pat.md` memory.
  pat_attested?: boolean;
}

interface ClassifiedScan {
  individualScore: number; // max of three tampering axes (0-100)
  isPhone: boolean;
  isDatacenter: boolean;
  isProxy: boolean;
  patAttested: boolean;
  ok: boolean; // basic projection-level verdict pass
  // Display fields surfaced into the side-by-side comparison panel.
  browserName: string | null;
  browserVersion: string | null;
  os: string | null;
  ip: string | null;
  ua: string | null;
  asnName: string | null;
  city: string | null;
  country: string | null;
  isMobileNetwork: boolean;
  isVpn: boolean;
  raw?: MerchantProjection; // for debug
}

function splitCredential(credential: string): { keyId: string; token: string } {
  const idx = credential.indexOf('.');
  if (idx <= 0) throw new Error('credential malformed: missing keyId.token separator');
  return { keyId: credential.slice(0, idx), token: credential.slice(idx + 1) };
}

/**
 * Fetch the merchant-safe projection for an argusSessionId. Returns null
 * if the lookup is impossible (missing config) so the verdict pipeline
 * can degrade to "skipped" rather than block on Argus availability.
 */
async function fetchProjection(argusSessionId: string): Promise<MerchantProjection | null> {
  if (!MERCHANT_API_URL || !MERCHANT_API_CREDENTIAL || !MERCHANT_CPI) {
    console.warn('[pair] fetchProjection: merchant config missing');
    return null;
  }
  try {
    const { keyId, token } = splitCredential(MERCHANT_API_CREDENTIAL);
    const url = `${MERCHANT_API_URL}/v1/session/${encodeURIComponent(MERCHANT_CPI)}/${encodeURIComponent(argusSessionId)}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'x-api-key': keyId, 'x-argus-token': token },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(
        `[pair] fetchProjection: ${res.status} for argusSessionId=${argusSessionId} body=${body.slice(0, 200)}`
      );
      return null;
    }
    return (await res.json().catch(() => null)) as MerchantProjection | null;
  } catch (e) {
    console.warn(`[pair] fetchProjection: threw ${(e as Error).message}`);
    return null;
  }
}

/** Lowercased tag check, defensive against missing/empty tags array. */
function hasTagLike(tags: string[] | undefined, ...patterns: string[]): boolean {
  if (!Array.isArray(tags) || tags.length === 0) return false;
  const lc = tags.map((t) => String(t).toLowerCase());
  return patterns.some((p) => {
    const needle = p.toLowerCase();
    return lc.some((t) => t.includes(needle));
  });
}

function classifyScan(p: MerchantProjection | null, side: string): ClassifiedScan | null {
  if (!p) return null;
  const individualScore = Math.max(
    p.automation ?? 0,
    p.device_tampering ?? 0,
    p.network_tampering ?? 0
  );

  // Argus's projection fields drift across pipeline versions, so look in
  // every plausible spot for the mobile/desktop signal. Cast through
  // Record<string, unknown> to read fields not in our narrow TS type.
  const projAny = p as unknown as Record<string, unknown>;
  const bd = (projAny.identification as Record<string, unknown> | undefined)?.browserDetails as
    | Record<string, unknown>
    | undefined;
  const deviceLabel = String(bd?.device ?? '').toLowerCase();
  const deviceType = String(bd?.deviceType ?? '').toLowerCase();
  const platform = String(bd?.platform ?? '').toLowerCase();
  const os = String(bd?.os ?? '').toLowerCase();
  const ua = String(bd?.userAgent ?? '');

  // Treat as phone if ANY of:
  //   - device or deviceType is "mobile" or "tablet"
  //   - platform/os matches a phone OS (iOS, Android, iPadOS)
  //   - userAgent contains the canonical mobile markers
  const phoneSignals = [deviceLabel, deviceType, platform, os].some(
    (v) => v === 'mobile' || v === 'tablet' || v === 'phone'
  );
  const phoneOsRe = /\b(ios|ipados|android|iphone|ipod)\b/i;
  const isPhone =
    phoneSignals ||
    phoneOsRe.test(os) ||
    phoneOsRe.test(platform) ||
    /Mobile|Android|iPhone|iPad|iPod/.test(ua);

  const ipInfo = projAny.ipInfo as
    | {
        asn?: { organization?: string | null };
        datacenter?: { result?: boolean };
        mobile?: { result?: boolean };
        vpn?: { result?: boolean };
        hosting?: { result?: boolean };
      }
    | undefined;
  const ipLocation = projAny.ipLocation as
    | { city?: string | null; country?: string | null }
    | undefined;

  const isProxy = hasTagLike(p.tags, 'proxy') || ipInfo?.hosting?.result === true;
  const isDatacenter =
    hasTagLike(p.tags, 'datacenter', 'hyperscaler', 'dc_asn') ||
    ipInfo?.datacenter?.result === true;
  // Argus emits `apple_attested` as a top-level tag when
  // integrity.pat.attested === true (see ms-argus-api merchant-
  // projection buildTags rule). Match exactly that — earlier spellings
  // (pat_attested / apple_pat) never existed in the projection schema.
  const patAttested = p.pat_attested === true || hasTagLike(p.tags, 'apple_attested');
  const ok = (p.verdict ?? 'PASS').toUpperCase() === 'PASS';

  const browserName = (bd?.browserName as string | null | undefined) ?? null;
  const browserVersion = (bd?.browserVersion as string | null | undefined) ?? null;
  const osLabel = (bd?.os as string | null | undefined) ?? null;
  const ip = (projAny.ip as string | null | undefined) ?? null;
  const asnName = ipInfo?.asn?.organization ?? null;
  const city = ipLocation?.city ?? null;
  const country = ipLocation?.country ?? null;
  const isMobileNetwork = ipInfo?.mobile?.result === true;
  const isVpn = ipInfo?.vpn?.result === true;

  console.log(
    `[pair] classifyScan side=${side} score=${individualScore} isPhone=${isPhone} isProxy=${isProxy} isDC=${isDatacenter} pat=${patAttested} verdict=${p.verdict} ` +
      `device=${JSON.stringify({ deviceLabel, deviceType, platform, os, ua: ua.slice(0, 80) })} tags=${JSON.stringify(p.tags ?? null)}`
  );

  return {
    individualScore,
    isPhone,
    isDatacenter,
    isProxy,
    patAttested,
    ok,
    browserName,
    browserVersion,
    os: osLabel,
    ip,
    ua: ua || null,
    asnName,
    city,
    country,
    isMobileNetwork,
    isVpn,
  };
}

function ssoProfileFromScan(
  argusSessionId: string,
  attestation: AttestationInput,
  scan: ClassifiedScan | null
): SsoLegProfile {
  return {
    argusSessionId,
    keyId: attestation.keyId,
    ip: scan?.ip ?? null,
    asnName: scan?.asnName ?? null,
    country: scan?.country ?? null,
    city: scan?.city ?? null,
    score: scan?.individualScore ?? null,
    isPhone: scan?.isPhone === true,
    isProxy: scan?.isProxy ?? false,
    isDatacenter: scan?.isDatacenter ?? false,
    isVpn: scan?.isVpn ?? false,
  };
}

function requirePhoneSsoScan(
  scan: ClassifiedScan | null,
  leg: 'start' | 'challenge' | 'validate'
): { ok: true } | { ok: false; response: ReturnType<typeof jsonResp> } {
  if (scan?.isPhone === true) return { ok: true };
  return {
    ok: false,
    response: jsonResp(403, {
      error: 'sso_requires_phone',
      leg,
      message: 'SSO is only available from phone-classified Argus scans.',
    }),
  };
}

function hashSsoReturnCode(code: string): string {
  return createHash('sha256').update(`argus-pair-sso-return:${code}`).digest('hex');
}

function validateSsoAttestation(
  body: Record<string, unknown>,
  expected: { role: string; sessionId?: string; nonce?: string; returnCode?: string }
): { ok: true; attestation: AttestationInput } | { ok: false; status: number; body: unknown } {
  const att = validateAttestInput(body);
  const argusSessionId = body.argusSessionId as string | undefined;
  if (!argusSessionId || !att) {
    return {
      ok: false,
      status: 400,
      body: { error: 'missing_argusSessionId_or_attestation' },
    };
  }
  const verified = verifyAttestation(att);
  if (!verified.ok || !verified.decoded) {
    return {
      ok: false,
      status: 400,
      body: { error: 'attestation_invalid', reason: verified.reason },
    };
  }
  const payload = verified.decoded.payload as {
    role?: string;
    ssoSessionId?: string;
    nonce?: string;
    returnCode?: string;
  };
  if (payload.role !== expected.role) {
    return { ok: false, status: 400, body: { error: 'payload_role_mismatch' } };
  }
  if (expected.sessionId && payload.ssoSessionId !== expected.sessionId) {
    return { ok: false, status: 400, body: { error: 'payload_session_mismatch' } };
  }
  if (expected.nonce && payload.nonce !== expected.nonce) {
    return { ok: false, status: 400, body: { error: 'payload_nonce_mismatch' } };
  }
  if (expected.returnCode && payload.returnCode !== expected.returnCode) {
    return { ok: false, status: 400, body: { error: 'payload_return_code_mismatch' } };
  }
  return { ok: true, attestation: att };
}

interface VerdictResult {
  verdict: Verdict;
  reason: string;
  annotations: Record<string, unknown>;
}

/**
 * Apply the rules from the spec:
 *   Hard deny — any of:
 *     1. either side on a proxy
 *     2. either side individual score >= 30
 *     3. sum of scores >= 50
 *     4. both sides classified as desktop/laptop
 *   PAT (#13): extends a side's score tolerance to PAT_SCORE_FLOOR — NOT an
 *     unconditional override. It does not whitewash hard evidence (score >=
 *     floor) and does not exempt the datacenter or total-score checks.
 *   Soft rules: DC OK on desktop, NOT OK on phone.
 *   Allow-with-annotation: both sides classified as phone.
 *   VPN: no penalty either way (already absent from rules above).
 */
function computeVerdict(desktop: ClassifiedScan, phone: ClassifiedScan): VerdictResult {
  const annotations: Record<string, unknown> = {
    desktop_score: desktop.individualScore,
    phone_score: phone.individualScore,
    total_score: desktop.individualScore + phone.individualScore,
    pat_used_desktop: desktop.patAttested,
    pat_used_phone: phone.patAttested,
    desktop_is_phone: desktop.isPhone,
    phone_is_phone: phone.isPhone,
    desktop_dc_asn: desktop.isDatacenter,
    phone_dc_asn: phone.isDatacenter,
    phone_to_phone: desktop.isPhone && phone.isPhone,
    // Per-side display fields for the side-by-side comparison panel.
    desktop_browser_name: desktop.browserName,
    desktop_browser_version: desktop.browserVersion,
    desktop_os: desktop.os,
    desktop_ip: desktop.ip,
    desktop_ua: desktop.ua,
    desktop_asn_name: desktop.asnName,
    desktop_city: desktop.city,
    desktop_country: desktop.country,
    desktop_is_mobile_network: desktop.isMobileNetwork,
    desktop_is_proxy: desktop.isProxy,
    desktop_is_vpn: desktop.isVpn,
    phone_browser_name: phone.browserName,
    phone_browser_version: phone.browserVersion,
    phone_os: phone.os,
    phone_ip: phone.ip,
    // Phone UA + IP feed the per-phone rate-limit bucket on raffle entry.
    // Without them, an incognito phone regenerates its Argus pubkey each
    // session and the pubkey bucket is useless. UA + IP are stable per
    // physical phone (UA never changes mid-session, IP rarely does).
    phone_ua: phone.ua,
    phone_asn_name: phone.asnName,
    phone_city: phone.city,
    phone_country: phone.country,
    phone_is_mobile_network: phone.isMobileNetwork,
    phone_is_proxy: phone.isProxy,
    phone_is_vpn: phone.isVpn,
  };

  // Hard #1 — proxy on either side. No golden ticket overrides this.
  if (desktop.isProxy) return { verdict: 'failed', reason: 'desktop_on_proxy', annotations };
  if (phone.isProxy) return { verdict: 'failed', reason: 'phone_on_proxy', annotations };

  // Score gate (#13). PAT extends tolerance to PAT_SCORE_FLOOR but cannot
  // override hard evidence at/above the floor. A side passes if its score is
  // under the normal limit, OR (PAT-attested AND under the higher floor).
  const scoreOk = (s: ClassifiedScan) =>
    s.individualScore < INDIVIDUAL_SCORE_LIMIT ||
    (s.patAttested && s.individualScore < PAT_SCORE_FLOOR);
  if (!scoreOk(desktop)) {
    return { verdict: 'failed', reason: 'desktop_score_high', annotations };
  }
  if (!scoreOk(phone)) {
    return { verdict: 'failed', reason: 'phone_score_high', annotations };
  }

  // Total score — always enforced (#13). PAT no longer grants a both-sides
  // exemption: two farmed PATs must not stack borderline scores past the cap.
  // Two genuine Apple devices score far below this, so legit pairs are safe.
  const totalScore = desktop.individualScore + phone.individualScore;
  if (totalScore >= TOTAL_SCORE_LIMIT) {
    return { verdict: 'failed', reason: 'total_score_high', annotations };
  }

  // Phone-on-datacenter — hard deny (#13). PAT no longer exempts: a genuine
  // Apple device is never on a datacenter IP, so PAT + datacenter egress
  // means a farmed/relayed token. (Proxy is already an unconditional deny.)
  if (phone.isDatacenter) {
    return { verdict: 'failed', reason: 'phone_on_datacenter', annotations };
  }

  // Both-desktop is the only "shape" deny. Both-phone is allowed (annotated).
  if (!desktop.isPhone && !phone.isPhone) {
    return { verdict: 'failed', reason: 'both_sides_desktop', annotations };
  }

  return {
    verdict: 'paired',
    reason: annotations.phone_to_phone ? 'paired_phone_to_phone' : 'paired_desktop_and_phone',
    annotations,
  };
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
// ── WebAuthn proof-of-life verification ────────────────────────────────────

interface WebAuthnAnnotations {
  phone_webauthn_attested: boolean;
  phone_webauthn_aaguid?: string;
  phone_webauthn_format?: string;
  /** Stable per-user identifier for the auth-identity rate-limit bucket.
   *  Passkey path → credentialId; populated by both registration and
   *  authentication so the same user gets the same bucket whether they
   *  just created or just used their passkey. */
  phone_webauthn_credential_id?: string;
  phone_webauthn_credential_backed_up?: boolean;
  phone_webauthn_user_verified?: boolean;
  phone_webauthn_error?: string;
}

// ── Passkey persistence (resident credentials) ─────────────────────────
//
// When the client opts into resident-credential creation
// (residentKey: 'preferred' on the registration request), we persist the
// (credentialId, publicKey, signCount) tuple so future visits can complete
// authentication WITHOUT another registration ceremony. The HMAC
// device-trust silent-reauth path keeps running alongside — passkey
// authentication is an additional path, not a replacement.
//
// Storage shape: PK=PASSKEY#<credentialIdBase64Url>, SK=META on the
// existing PairSessions table. TTL refreshes to +1y on every successful
// authentication, so actively-used passkeys never expire; abandoned ones
// GC themselves a year after last use.
//
// We DO NOT enforce uniqueness per argus pubkey — iCloud Keychain may
// distribute the same passkey across the user's Apple devices, each of
// which produces the same credentialId.

const PASSKEY_TTL_SECONDS = 365 * 24 * 60 * 60; // 1 year

interface StoredPasskey {
  credentialId: string;
  publicKey: string; // base64
  signCount: number;
  argusPubkey: string | null;
  createdAt: number;
  lastUsedAt: number;
}

function publicKeyBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function base64ToBytes(s: string): Uint8Array<ArrayBuffer> {
  // Copy into a fresh Uint8Array backed by a real ArrayBuffer (Buffer's
  // underlying ArrayBufferLike isn't assignable to the simplewebauthn
  // WebAuthnCredential publicKey type, which insists on ArrayBuffer).
  const src = Buffer.from(s, 'base64');
  const out = new Uint8Array(new ArrayBuffer(src.length));
  out.set(src);
  return out;
}

async function loadPasskey(credentialId: string): Promise<StoredPasskey | null> {
  const res = await ddb.send(
    new GetCommand({
      TableName: TABLE,
      Key: { PK: `PASSKEY#${credentialId}`, SK: 'META' },
    })
  );
  return (res.Item as StoredPasskey | undefined) ?? null;
}

async function savePasskey(p: StoredPasskey): Promise<void> {
  const ttl = Math.floor(Date.now() / 1000) + PASSKEY_TTL_SECONDS;
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { PK: `PASSKEY#${p.credentialId}`, SK: 'META' },
      UpdateExpression:
        'SET publicKey = :pk, signCount = :sc, argusPubkey = :ap, ' +
        'createdAt = if_not_exists(createdAt, :now), lastUsedAt = :now, ' +
        'expiresAt = :ttl, credentialId = :cid',
      ExpressionAttributeValues: {
        ':pk': p.publicKey,
        ':sc': p.signCount,
        ':ap': p.argusPubkey,
        ':now': p.lastUsedAt,
        ':ttl': ttl,
        ':cid': p.credentialId,
      },
    })
  );
}

/**
 * Verify a stored-passkey authentication assertion. Returns the same
 * annotations shape as verifyWebAuthn() so the verdict branch can stay
 * homogeneous. Bumps signCount + lastUsedAt on success.
 *
 * Replay protection: the server's stored signCount is compared against
 * the new counter the authenticator reports. If the new counter is not
 * strictly greater AND not zero (zero indicates an authenticator that
 * doesn't implement counters — most platform authenticators), reject.
 */
async function verifyPasskeyAuthentication(
  webauthn: unknown,
  expectedNonce: string,
  argusPubkey: string
): Promise<WebAuthnAnnotations> {
  if (!webauthn || typeof webauthn !== 'object') {
    return { phone_webauthn_attested: false, phone_webauthn_error: 'missing' };
  }
  const w = webauthn as Record<string, unknown>;
  if (typeof w.error === 'string') {
    return { phone_webauthn_attested: false, phone_webauthn_error: w.error };
  }
  const auth = webauthn as AuthenticationResponseJSON;
  if (!auth.id) {
    return { phone_webauthn_attested: false, phone_webauthn_error: 'missing_credential_id' };
  }
  const stored = await loadPasskey(auth.id);
  if (!stored) {
    return { phone_webauthn_attested: false, phone_webauthn_error: 'credential_not_registered' };
  }
  try {
    const credential: WebAuthnCredential = {
      id: stored.credentialId,
      publicKey: base64ToBytes(stored.publicKey),
      counter: stored.signCount,
    };
    const verification = await verifyAuthenticationResponse({
      response: auth,
      expectedChallenge: expectedNonce,
      expectedOrigin: WEBAUTHN_EXPECTED_ORIGIN,
      expectedRPID: WEBAUTHN_RP_ID,
      credential,
      requireUserVerification: true,
    });
    if (!verification.verified) {
      return { phone_webauthn_attested: false, phone_webauthn_error: 'not_verified' };
    }
    // Update sign counter + last-used. Re-binds argusPubkey to the most
    // recent device that proved possession (passkeys can sync across
    // user's devices via iCloud Keychain).
    await savePasskey({
      credentialId: stored.credentialId,
      publicKey: stored.publicKey,
      signCount: verification.authenticationInfo.newCounter,
      argusPubkey,
      createdAt: stored.createdAt,
      lastUsedAt: Math.floor(Date.now() / 1000),
    });
    return {
      phone_webauthn_attested: true,
      phone_webauthn_format: 'passkey_authentication',
      phone_webauthn_credential_id: stored.credentialId,
      phone_webauthn_user_verified: verification.authenticationInfo.userVerified,
      phone_webauthn_credential_backed_up: verification.authenticationInfo.credentialBackedUp,
    };
  } catch (e) {
    return {
      phone_webauthn_attested: false,
      phone_webauthn_error: (e as Error).message,
    };
  }
}

/**
 * Verify the phone's WebAuthn proof-of-life ceremony.
 *
 * Branches on the response shape:
 *   - response.attestationObject present → registration (first visit).
 *     Verify with verifyRegistrationResponse(). If a credentialId
 *     came back (resident-key flow), persist it for later
 *     authentication.
 *   - response.signature present → authentication (return visit).
 *     Verify with verifyAuthenticationResponse() against the stored
 *     publicKey, bump signCount.
 *
 * Either path produces the same WebAuthnAnnotations shape, so the
 * verdict branch downstream doesn't need to know which happened.
 */
async function verifyWebAuthn(
  webauthn: unknown,
  expectedNonce: string,
  argusPubkey: string
): Promise<WebAuthnAnnotations> {
  if (!webauthn || typeof webauthn !== 'object') {
    return { phone_webauthn_attested: false, phone_webauthn_error: 'missing' };
  }
  const w = webauthn as Record<string, unknown>;
  if (typeof w.error === 'string') {
    return { phone_webauthn_attested: false, phone_webauthn_error: w.error };
  }
  const response = w.response as Record<string, unknown> | undefined;
  const isAuthentication =
    typeof response?.signature === 'string' && typeof response?.authenticatorData === 'string';
  if (isAuthentication) {
    return verifyPasskeyAuthentication(webauthn, expectedNonce, argusPubkey);
  }
  try {
    const verification = await verifyRegistrationResponse({
      response: webauthn as RegistrationResponseJSON,
      expectedChallenge: expectedNonce,
      expectedOrigin: WEBAUTHN_EXPECTED_ORIGIN,
      expectedRPID: WEBAUTHN_RP_ID,
      requireUserVerification: true,
    });
    if (!verification.verified || !verification.registrationInfo) {
      return { phone_webauthn_attested: false, phone_webauthn_error: 'not_verified' };
    }
    const info = verification.registrationInfo;
    // Persist the credential if the authenticator gave us a resident
    // credentialId. Catches failures silently — the verdict still
    // succeeds on the registration alone; a missing passkey row just
    // means the user falls back to a fresh registration next visit.
    if (info.credential?.id && info.credential?.publicKey) {
      const now = Math.floor(Date.now() / 1000);
      void savePasskey({
        credentialId: info.credential.id,
        publicKey: publicKeyBase64(info.credential.publicKey),
        signCount: info.credential.counter ?? 0,
        argusPubkey,
        createdAt: now,
        lastUsedAt: now,
      }).catch(() => {
        /* non-fatal — paired succeeds either way */
      });
    }
    // We DO NOT gate on fmt or AAGUID. Earlier attempts to require a
    // phone-platform attestation format (apple / android-key /
    // android-safetynet) or a non-zero AAGUID broke real iOS and
    // Android users. Modern platform authenticators emit
    // `fmt:'none'` + all-zero AAGUID by default for privacy:
    //   - iOS Safari Touch ID / Face ID since iOS 14+
    //   - macOS Safari Touch ID
    //   - Android GPM passkeys (Play Services 13+) in most flows
    // Direct attestation only comes back when the RP is on a
    // platform-specific enterprise allowlist (Apple Anonymous CA,
    // Android Play Integrity hardware attestation). Not viable for a
    // public demo.
    //
    // This means the WebAuthn step is structurally forgeable from a
    // Node script with hand-rolled CBOR + a self-generated P-256
    // keypair (see ms-argus-attack-bots/bots/pair-webauthn-bypass.mjs).
    // That's accepted: WebAuthn here is the proof-of-life /
    // interactivity ceremony, NOT the anchor of trust. The anchor is
    // the merchant projection lookup gated by Fix 1 — without real
    // Argus sessions on both sides, the verdict still fails.
    return {
      phone_webauthn_attested: true,
      phone_webauthn_aaguid: info.aaguid,
      phone_webauthn_format: info.fmt,
      phone_webauthn_credential_id: info.credential?.id,
      phone_webauthn_credential_backed_up: info.credentialBackedUp,
      phone_webauthn_user_verified: info.userVerified,
    };
  } catch (e) {
    return {
      phone_webauthn_attested: false,
      phone_webauthn_error: (e as Error).message,
    };
  }
}

async function loadSession(sessionId: string): Promise<SessionItem | null> {
  if (isValkeySessionsEnabled()) {
    const { meta, desktop, phone, raffle } = await mgetSession(sessionId);
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
      verdict: phone?.verdict ?? 'pending',
      verdictReason: phone?.reason ?? undefined,
      desktopAttestation: desktop as unknown as StoredAttestation | undefined,
      phoneAttestation: phone?.att as unknown as StoredAttestation | undefined,
      // raffleHash / annotations live on the row in the DDB shape too,
      // see the cast sites in /raffle/entry and /raffle/status.
      ...(phone?.annotations ? { annotations: phone.annotations } : {}),
      ...(raffle ? { raffleHash: raffle.hash, raffleEnteredAt: raffle.enteredAt } : {}),
    } as unknown as SessionItem;
  }
  const res = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { PK: `SESSION#${sessionId}`, SK: 'META' } })
  );
  return (res.Item as SessionItem) ?? null;
}

async function loadSsoSession(sessionId: string): Promise<SsoSessionItem | null> {
  const res = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { PK: `SSO#${sessionId}`, SK: 'META' } })
  );
  return (res.Item as SsoSessionItem | undefined) ?? null;
}

// ── OAuth proof-of-life ────────────────────────────────────────────────
//
// Same shape as WebAuthnAnnotations so the verdict branch below stays
// homogeneous: `phone_webauthn_attested` is the unified proof-of-life
// boolean, regardless of how the proof was produced (WebAuthn,
// device-trust redeem, or OAuth completion). Provider-specific fields
// surface on top for fraud correlation.
//
// On nonce binding: the OAuth verifier checks the token's nonce
// (Google OIDC) or relies on the client's state round-trip (GitHub /
// Facebook). Either way, replay across pair sessions fails because
// each pair session.nonce is unique.

interface OAuthAnnotations extends WebAuthnAnnotations {
  phone_oauth_provider?: OAuthProvider;
  phone_oauth_subject?: string;
  phone_oauth_email_verified?: boolean;
  phone_oauth_real_user_hint?: 'likely_real' | 'unknown' | 'unsupported';
  phone_oauth_error?: string;
}

interface OAuthInput {
  provider: unknown;
  token: unknown;
}

function readOAuthInput(raw: unknown): { provider: OAuthProvider; token: string } | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as OAuthInput;
  if (!isOAuthProvider(o.provider)) return null;
  if (typeof o.token !== 'string' || o.token.length === 0) return null;
  return { provider: o.provider, token: o.token };
}

async function verifyOAuthProofOfLife(
  rawInput: unknown,
  expectedNonce: string
): Promise<OAuthAnnotations> {
  const input = readOAuthInput(rawInput);
  if (!input) {
    return { phone_webauthn_attested: false, phone_oauth_error: 'missing_or_malformed' };
  }
  let result: OAuthVerifyResult;
  try {
    result = await verifyOAuth(input.provider, {
      token: input.token,
      expectedNonce,
    });
  } catch (e) {
    return {
      phone_webauthn_attested: false,
      phone_oauth_provider: input.provider,
      phone_oauth_error: (e as Error).message,
    };
  }
  if (!result.ok) {
    return {
      phone_webauthn_attested: false,
      phone_oauth_provider: input.provider,
      phone_oauth_error: result.reason ?? 'verify_failed',
    };
  }
  return {
    phone_webauthn_attested: true,
    phone_webauthn_user_verified: true,
    phone_webauthn_format: `oauth_${result.provider}`,
    phone_oauth_provider: result.provider,
    phone_oauth_subject: result.subject,
    phone_oauth_email_verified: result.emailVerified,
    phone_oauth_real_user_hint: result.realUserHint,
  };
}

const lambdaHandler = async (event: {
  routeKey: string;
  pathParameters?: Record<string, string | undefined>;
  queryStringParameters?: Record<string, string | undefined>;
  body?: string;
  headers?: Record<string, string | undefined>;
}) => {
  if (!originAllowed(event)) return jsonResp(403, { error: 'origin_not_allowed' });

  const routeKey = event.routeKey;
  const sessionId = event.pathParameters?.id?.toLowerCase();
  // Routes that don't carry an {id} path parameter — skip the UUID check.
  const idLessRoutes = new Set([
    'POST /api/session/start',
    'POST /api/sso/start',
    'POST /api/raffle/entry',
    'GET /api/raffle/leaderboard',
    'GET /api/_valkey-debug',
    'POST /api/verify',
  ]);
  if (!idLessRoutes.has(routeKey) && !SESSION_ID_RE.test(sessionId ?? '')) {
    return jsonResp(400, { error: 'invalid_session_id' });
  }
  const body = parseBody(event.body);
  if (body === null) return jsonResp(400, { error: 'invalid_body' });

  switch (routeKey) {
    case 'GET /api/_valkey-debug': {
      // Diagnostic-only endpoint. Tries DNS → raw TCP → TLS → ioredis
      // and reports where the chain breaks. Safe to expose because it
      // only reports connectivity outcomes; no Valkey command is run.
      const host = process.env.VALKEY_ENDPOINT ?? '';
      const port = Number(process.env.VALKEY_PORT ?? '6379');
      const result: Record<string, unknown> = { host, port };
      const dnsmod = await import('node:dns/promises');
      try {
        const addrs = await dnsmod.resolve4(host);
        result.dns = { ok: true, addrs };
      } catch (e) {
        result.dns = { ok: false, err: (e as Error).message };
        return jsonResp(200, result);
      }
      const ips = (result.dns as { addrs: string[] }).addrs;
      const tcpResults: Record<string, unknown>[] = [];
      const netmod = await import('node:net');
      for (const ip of ips) {
        const tcp: Record<string, unknown> = { ip };
        try {
          const t0 = Date.now();
          await new Promise<void>((resolve, reject) => {
            const sock = netmod.createConnection({ host: ip, port, timeout: 2000 });
            sock.once('connect', () => {
              sock.end();
              resolve();
            });
            sock.once('error', (err) => reject(err));
            sock.once('timeout', () => reject(new Error('tcp_timeout')));
          });
          tcp.ok = true;
          tcp.ms = Date.now() - t0;
        } catch (e) {
          tcp.ok = false;
          tcp.err = (e as Error).message;
        }
        tcpResults.push(tcp);
      }
      result.tcp = tcpResults;
      const tlsmod = await import('node:tls');
      const tlsResults: Record<string, unknown>[] = [];
      for (const ip of ips) {
        const t: Record<string, unknown> = { ip };
        try {
          const t0 = Date.now();
          await new Promise<void>((resolve, reject) => {
            const sock = tlsmod.connect({
              host: ip,
              port,
              servername: host,
              timeout: 3000,
              rejectUnauthorized: false,
            });
            sock.once('secureConnect', () => {
              sock.end();
              resolve();
            });
            sock.once('error', (err) => reject(err));
            sock.once('timeout', () => reject(new Error('tls_timeout')));
          });
          t.ok = true;
          t.ms = Date.now() - t0;
        } catch (e) {
          t.ok = false;
          t.err = (e as Error).message;
        }
        tlsResults.push(t);
      }
      result.tls = tlsResults;
      // Finally exercise the cached ioredis path end-to-end with a PING.
      // If this passes, the rate-limit Lua call uses the same client and
      // should work too.
      try {
        const { getValkey } = await import('./valkey-client');
        const t0 = Date.now();
        const valkey = getValkey();
        const pong = await valkey.ping();
        result.ioredisPing = { ok: true, pong, ms: Date.now() - t0, status: valkey.status };
      } catch (e) {
        result.ioredisPing = { ok: false, err: (e as Error).message };
      }
      return jsonResp(200, result);
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
      const id = randomUUID();
      const nonce = randomBytes(32).toString('base64url');
      const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
      // Embeddable widget attributes the pairing to the merchant's CPI. Only a
      // well-formed CPI is persisted; anything else stays null (demo/own-site).
      const rawCpi = (body as { cpi?: unknown }).cpi;
      const cpi = typeof rawCpi === 'string' && CPI_FORMAT.test(rawCpi) ? rawCpi : null;
      if (isValkeySessionsEnabled()) {
        const created = await startSessionValkey(id, { nonce, expiresAt, cpi });
        if (!created) {
          // UUIDv4 collision — vanishingly rare, but mirrors the
          // DDB ConditionExpression rejection so the caller can retry.
          return jsonResp(409, { error: 'session_id_collision' });
        }
      } else {
        const item: SessionItem = {
          PK: `SESSION#${id}`,
          SK: 'META',
          nonce,
          expiresAt,
          cpi,
          verdict: 'pending',
        };
        await ddb.send(
          new PutCommand({
            TableName: TABLE,
            Item: item,
            ConditionExpression: 'attribute_not_exists(PK)',
          })
        );
      }
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
      const checked = validateSsoAttestation(body, { role: 'merchant-start' });
      if (!checked.ok) return jsonResp(checked.status, checked.body);
      const argusSessionId = body.argusSessionId as string;
      const id = randomUUID();
      const nonce = randomBytes(32).toString('base64url');
      const merchantSessionId =
        typeof body.merchantSessionId === 'string' && body.merchantSessionId.length > 0
          ? body.merchantSessionId.slice(0, 128)
          : randomUUID();
      const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
      const projection = await fetchProjection(argusSessionId);
      const scan = classifyScan(projection, 'sso_start');
      const phoneCheck = requirePhoneSsoScan(scan, 'start');
      if (!phoneCheck.ok) return phoneCheck.response;
      const item: SsoSessionItem = {
        PK: `SSO#${id}`,
        SK: 'META',
        nonce,
        merchantSessionId,
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
      return jsonResp(200, {
        sessionId: id,
        nonce,
        expiresAt,
        challengeUrl: `/sso/challenge/${id}`,
      });
    }

    case 'POST /api/sso/{id}/challenge': {
      const s = await loadSsoSession(sessionId!);
      if (!s) return jsonResp(404, { error: 'sso_session_not_found' });
      if (s.challengeProfile) return jsonResp(409, { error: 'sso_challenge_already_completed' });
      const checked = validateSsoAttestation(body, {
        role: 'argus-challenge',
        sessionId: sessionId!,
        nonce: s.nonce,
      });
      if (!checked.ok) return jsonResp(checked.status, checked.body);
      const argusSessionId = body.argusSessionId as string;
      const projection = await fetchProjection(argusSessionId);
      const scan = classifyScan(projection, 'sso_challenge');
      const phoneCheck = requirePhoneSsoScan(scan, 'challenge');
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
      return jsonResp(200, {
        ok: true,
        returnCode: code.value,
        returnUrl: `/merchant/validate?session=${encodeURIComponent(sessionId!)}&code=${encodeURIComponent(code.value)}`,
      });
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
      });
      if (!checked.ok) return jsonResp(checked.status, checked.body);
      const argusSessionId = body.argusSessionId as string;
      const projection = await fetchProjection(argusSessionId);
      const scan = classifyScan(projection, 'sso_validate');
      const phoneCheck = requirePhoneSsoScan(scan, 'validate');
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
        proofOfLife = true;
        proofAnnotations = {
          phone_webauthn_attested: true,
          phone_webauthn_format: 'device_trust',
          phone_device_trust_redeemed: true,
        };
      } else {
        const proof = oauthInput
          ? await verifyOAuthProofOfLife(oauthInput, s.nonce)
          : await verifyWebAuthn(webauthnInput, s.nonce, checked.attestation.publicKey);
        proofOfLife = proof.phone_webauthn_attested === true;
        proofAnnotations = proof as unknown as Record<string, unknown>;
      }

      if (!proofOfLife) {
        return jsonResp(401, {
          error: 'proof_of_life_required',
          annotations: proofAnnotations,
        });
      }
      const verdict = evaluateSsoContinuity({
        start: s.startProfile,
        challenge: s.challengeProfile,
        validate: validateProfile,
      });
      const approvedAt = verdict.ok ? now : undefined;
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
            (approvedAt ? ', approvedAt = :approvedAt' : ''),
          ConditionExpression:
            'attribute_exists(PK) AND attribute_not_exists(returnCodeConsumedAt)',
          ExpressionAttributeValues: {
            ':v': validateProfile,
            ':verdict': verdict.ok ? 'approved' : 'failed',
            ':reason': verdict.reason,
            ':now': now,
            ':proof': proofAnnotations,
            ...(approvedAt ? { ':approvedAt': approvedAt } : {}),
          },
        })
      );
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      };
      return {
        statusCode: verdict.ok ? 200 : 403,
        headers,
        ...(verdict.ok
          ? {
              cookies: [
                `argus_sso_approval=${encodeURIComponent(sessionId!)}; Path=/merchant; Max-Age=600; Secure; HttpOnly; SameSite=Lax`,
              ],
            }
          : {}),
        body: JSON.stringify({
          verdict: verdict.ok ? 'approved' : 'failed',
          reason: verdict.reason,
          reasons: verdict.reasons,
          merchantSessionId: s.merchantSessionId,
          nextDeviceTrust,
        }),
      };
    }

    case 'POST /api/sso/{id}/claim': {
      const handle = normalizeHandle(body.handle);
      if (!handle) {
        return jsonResp(400, {
          error: 'invalid_handle',
          allowed: '3-64 chars, [a-z0-9._@-]',
        });
      }
      const s = await loadSsoSession(sessionId!);
      if (!s) return jsonResp(410, { error: 'sso_session_not_found' });
      if (s.verdict !== 'approved' || !s.challengeProfile || !s.validateProfile) {
        return jsonResp(409, { error: 'sso_session_not_approved', verdict: s.verdict });
      }
      if (s.claimHash) {
        return jsonResp(409, {
          error: 'session_already_entered',
          code: hashToCode(s.claimHash),
        });
      }

      const siteHost = desktopSiteHost(event);
      const deviceKey = s.validateProfile.keyId || s.challengeProfile.keyId || s.startProfile.keyId;
      if (!deviceKey) return jsonResp(409, { error: 'sso_session_missing_device_key' });

      // Reuse the game/raffle rate limiter for SSO claims. The SSO flow
      // is single-device, so its buckets map to the stable SDK key plus
      // the observed start/return networks instead of phone+desktop.
      const rl = await checkRaffleRateLimits({
        phonePub: deviceKey,
        desktopPub: s.startProfile.keyId ?? deviceKey,
        desktopUa: 'sso-start',
        desktopIp: s.startProfile.ip ?? '',
        phoneUa: 'sso-validate',
        phoneIp: s.validateProfile.ip ?? '',
        authIdentity: `sso-device:${deviceKey}`,
        siteHost,
      });
      if (!rl.ok) {
        return jsonResp(429, {
          error: 'rate_limited',
          bucket: rl.tripped,
          site: siteHost,
        });
      }

      const { hash, code } = handleHash(handle);
      const enteredAt = Math.floor(Date.now() / 1000);
      try {
        await ddb.send(
          new UpdateCommand({
            TableName: TABLE,
            Key: { PK: `SSO#${sessionId}`, SK: 'META' },
            UpdateExpression: 'SET claimHash = :h, claimEnteredAt = :t',
            ConditionExpression: 'attribute_exists(PK) AND attribute_not_exists(claimHash)',
            ExpressionAttributeValues: {
              ':h': hash,
              ':t': enteredAt,
            },
          })
        );
      } catch (err: unknown) {
        const isConflict = (err as { name?: string })?.name === 'ConditionalCheckFailedException';
        if (isConflict) return jsonResp(409, { error: 'session_already_entered' });
        throw err;
      }

      const entry = await incrementLeaderboard(handle);
      const count = entry.count;
      return jsonResp(200, { ok: true, code, count });
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
      const argusSessionId = body.argusSessionId as string | undefined;
      const att = validateAttestInput(body);
      if (!argusSessionId || !att) {
        return jsonResp(400, { error: 'missing_argusSessionId_or_attestation' });
      }
      const s = await loadSession(sessionId!);
      if (!s) return jsonResp(404, { error: 'session_not_found' });
      if (s.desktopAttestation) return jsonResp(409, { error: 'already_attested' });
      const v = verifyAttestation(att);
      if (!v.ok || !v.decoded) {
        return jsonResp(400, { error: 'attestation_invalid', reason: v.reason });
      }
      const payload = v.decoded.payload as { sessionId?: string; nonce?: string; role?: string };
      if (payload.sessionId !== sessionId) {
        return jsonResp(400, { error: 'payload_session_mismatch' });
      }
      if (payload.nonce !== s.nonce) {
        return jsonResp(400, { error: 'payload_nonce_mismatch' });
      }
      if (payload.role !== 'desktop') {
        return jsonResp(400, { error: 'payload_role_mismatch' });
      }
      // Claim the argusSessionId before storing — closes Tier-1 recycling.
      const desktopClaim = await claimArgusSessionId(argusSessionId, sessionId!, 'desktop');
      if (!desktopClaim.ok) {
        return jsonResp(409, {
          error: 'argus_session_already_claimed',
          reason: desktopClaim.reason,
        });
      }
      const stored: StoredAttestation = {
        ...att,
        argusSessionId,
        receivedAt: Math.floor(Date.now() / 1000),
        envelopeDecoded: v.decoded,
      };
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
          clean =
            c.patAttested &&
            !c.isProxy &&
            !c.isDatacenter &&
            c.individualScore < INDIVIDUAL_SCORE_LIMIT;
          summary = {
            score: c.individualScore,
            pat_attested: c.patAttested,
            is_proxy: c.isProxy,
            is_datacenter: c.isDatacenter,
            is_vpn: c.isVpn,
            is_mobile_network: c.isMobileNetwork,
            browser_name: c.browserName,
            browser_version: c.browserVersion,
            os: c.os,
            ip: c.ip,
            asn_name: c.asnName,
            city: c.city,
            country: c.country,
          };
        }
      } catch (e) {
        console.warn(`[pair] desktop-attest optimistic classify failed: ${(e as Error).message}`);
      }

      return jsonResp(200, { ok: true, clean, summary });
    }

    case 'POST /api/session/{id}/phone-attest': {
      const argusSessionId = body.argusSessionId as string | undefined;
      const att = validateAttestInput(body);
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
      if (!argusSessionId || !att) {
        return jsonResp(400, { error: 'missing_argusSessionId_or_attestation' });
      }
      const s = await loadSession(sessionId!);
      if (!s) return jsonResp(404, { error: 'session_not_found' });
      if (!s.desktopAttestation) {
        return jsonResp(409, { error: 'desktop_not_attested_yet' });
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
      const v = verifyAttestation(att);
      if (!v.ok || !v.decoded) {
        return jsonResp(400, { error: 'attestation_invalid', reason: v.reason });
      }
      const payload = v.decoded.payload as {
        sessionId?: string;
        nonce?: string;
        role?: string;
      };
      if (payload.sessionId !== sessionId) {
        return jsonResp(400, { error: 'payload_session_mismatch' });
      }
      if (payload.nonce !== s.nonce) {
        return jsonResp(400, { error: 'payload_nonce_mismatch' });
      }
      if (payload.role !== 'phone') {
        return jsonResp(400, { error: 'payload_role_mismatch' });
      }
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
      const stored: StoredAttestation = {
        ...att,
        argusSessionId,
        receivedAt: Math.floor(Date.now() / 1000),
        envelopeDecoded: v.decoded,
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
      const proofPath: Promise<WebAuthnAnnotations | OAuthAnnotations> = trustResult?.ok
        ? Promise.resolve<WebAuthnAnnotations>({
            phone_webauthn_attested: true,
            phone_webauthn_user_verified: true,
            phone_webauthn_format: 'device_trust_redeem',
          } as WebAuthnAnnotations)
        : oauthInput
          ? verifyOAuthProofOfLife(oauthInput, s.nonce)
          : verifyWebAuthn(webauthnInput, s.nonce, att.publicKey);

      const [desktopProj, phoneProj, webauthnResult] = await Promise.all([
        fetchProjection(s.desktopAttestation.argusSessionId),
        fetchProjection(argusSessionId),
        proofPath,
      ]);
      const desktopClass = classifyScan(desktopProj, 'desktop');
      const phoneClass = classifyScan(phoneProj, 'phone');

      // Proof of life: the phone side must have EITHER passed a fresh
      // WebAuthn registration OR redeemed a valid device-trust token
      // (which itself is proof of a prior WebAuthn from the same IP).
      // `webauthnResult.phone_webauthn_attested` is already unified for
      // both paths above — the trust-redeem branch synthesizes it as
      // true. Without proof of life, fail the pair even when integrity
      // scans look clean — design intent is `magic-token || webauthn`.
      const proofOfLife = (webauthnResult as WebAuthnAnnotations).phone_webauthn_attested === true;

      let verdict: Verdict;
      let reason: string;
      let annotations: Record<string, unknown>;
      const desktopAgeSec = projectionAgeSeconds(desktopProj);
      const phoneAgeSec = projectionAgeSeconds(phoneProj);

      if (REQUIRE_PROOF_OF_LIFE && !proofOfLife) {
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
              verdict: r.existing.verdict,
              reason: r.existing.reason ?? null,
              annotations: r.existing.annotations ?? {},
              nextDeviceTrust: null,
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
              verdict: existing.verdict,
              reason: existing.verdictReason ?? null,
              annotations:
                (existing as unknown as { annotations?: Record<string, unknown> }).annotations ??
                {},
              nextDeviceTrust: null,
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
      // WS push: when the phone arrived via the QR'd hash fragment it
      // also carries the desktop's sealed connection envelope. Decrypt,
      // validate it's bound to THIS session + the desktop role, then
      // PostToConnection the verdict straight into the desktop's open
      // socket. Replaces the desktop's /result polling on the happy
      // path; fire-and-forget — push failure does not fail the response.
      // Reuse the desktopEnv we already authenticated above (#8) — same sealed
      // envelope, already verified session/role-bound, so no need to re-open.
      const mgmtEndpoint = process.env.WS_MGMT_ENDPOINT;
      if (!mgmtEndpoint) {
        console.warn('[pair] WS_MGMT_ENDPOINT not configured; skipping verdict push');
      } else {
        console.log(
          `[pair] verdict-push: posting to cid=${desktopEnv.connectionId} verdict=${verdict}`
        );
        // Wrap in the same shape the WS handler uses for relayed peer
        // messages — `action:'message'` + `data:{kind,...}` — so the
        // desktop's persistent fanout in src/lib/ws.ts dispatches it
        // through onMessage exactly like phone-here / desktop-ready.
        // Without `action:'message'` the fanout silently drops it.
        const push = await postToPeer(mgmtEndpoint, desktopEnv.connectionId, {
          action: 'message',
          from: 'server',
          sessionId,
          data: {
            kind: 'verdict',
            verdict,
            reason,
            annotations,
          },
        });
        if (push.ok) {
          console.log(`[pair] verdict-push: ok cid=${desktopEnv.connectionId}`);
        } else {
          console.warn(`[pair] verdict-push failed: ${push.reason}`);
        }
      }
      return jsonResp(200, { verdict, reason, annotations, nextDeviceTrust });
    }

    case 'GET /api/session/{id}/result': {
      // #10: authenticate. The verdict (and its annotations) used to be
      // readable by anyone who knew the sessionId. Require a valid bootstrap
      // token for THIS session — either role, since both the desktop and the
      // phone are legitimate session participants. The token is the same HMAC
      // wsToken minted at /session/start (desktop holds desktopToken; the
      // phone holds phoneToken from the QR hash). 5-min TTL matches the
      // session TTL, so it covers the whole polling window.
      const resultToken =
        event.queryStringParameters?.t ||
        (event.headers?.authorization || event.headers?.Authorization || '').replace(
          /^Bearer\s+/i,
          ''
        );
      const resultClaims = resultToken ? await verifyBootstrapToken(resultToken) : null;
      if (!resultClaims || resultClaims.sessionId !== sessionId) {
        return jsonResp(401, { error: 'result_unauthorized' });
      }
      const s = await loadSession(sessionId!);
      if (!s) return jsonResp(200, { verdict: 'failed', reason: 'expired_or_missing' });
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
      return jsonResp(200, {
        verdict: s.verdict,
        reason: s.verdictReason ?? null,
        annotations: (s as unknown as { annotations?: Record<string, unknown> }).annotations ?? {},
      });
    }

    // ── Embeddable widget: mint a signed verdict token (siteverify) ──────
    // The desktop (embed iframe) calls this after the paired verdict, then
    // postMessages the token to the host page. Auth is the same bootstrap
    // wsToken as /result — only a session participant can mint.
    case 'GET /api/session/{id}/verdict-token': {
      const vtToken =
        event.queryStringParameters?.t ||
        (event.headers?.authorization || event.headers?.Authorization || '').replace(
          /^Bearer\s+/i,
          ''
        );
      const vtClaims = vtToken ? await verifyBootstrapToken(vtToken) : null;
      if (!vtClaims || vtClaims.sessionId !== sessionId) {
        return jsonResp(401, { error: 'verdict_token_unauthorized' });
      }
      const s = await loadSession(sessionId!);
      if (!s) return jsonResp(404, { error: 'session_not_found' });
      if (s.verdict === 'pending') return jsonResp(409, { error: 'verdict_pending' });
      const secret = await getVerdictSecret();
      if (!secret) return jsonResp(503, { error: 'verdict_signing_unconfigured' });
      const token = signVerdict(secret, {
        cpi: s.cpi ?? null,
        sessionId: sessionId!,
        verdict: s.verdict,
        reason: s.verdictReason ?? null,
      });
      return jsonResp(200, { token });
    }

    // ── Server-to-server token verification (the host's backend calls this) ─
    case 'POST /api/verify': {
      const vToken = (body as { token?: unknown }).token;
      if (typeof vToken !== 'string') return jsonResp(400, { error: 'missing_token' });
      const secret = await getVerdictSecret();
      if (!secret) return jsonResp(503, { error: 'verdict_signing_unconfigured' });
      const result = verifyVerdictToken(secret, vToken);
      if (!result.ok) return jsonResp(200, { valid: false, reason: result.reason });
      // Optional tenant assertion: if the caller names its CPI, it must match.
      const wantCpi = (body as { cpi?: unknown }).cpi;
      if (typeof wantCpi === 'string' && result.claims.cpi !== wantCpi) {
        return jsonResp(200, { valid: false, reason: 'cpi_mismatch' });
      }
      return jsonResp(200, {
        valid: true,
        cpi: result.claims.cpi,
        sessionId: result.claims.sessionId,
        verdict: result.claims.verdict,
        reason: result.claims.reason,
        iat: result.claims.iat,
        exp: result.claims.exp,
      });
    }

    case 'POST /api/raffle/entry': {
      const sid = typeof body.sessionId === 'string' ? body.sessionId.toLowerCase() : undefined;
      const handle = normalizeHandle(body.handle);
      if (!sid || !SESSION_ID_RE.test(sid)) {
        return jsonResp(400, { error: 'invalid_session_id' });
      }
      if (!handle) {
        return jsonResp(400, {
          error: 'invalid_handle',
          allowed: '3-64 chars, [a-z0-9._@-]',
        });
      }
      const s = await loadSession(sid);
      // 410 (Gone) rather than 404 — CloudFront's errorResponses[404]
      // rewrites any 404 from /api/* to /index.html, which trashes the
      // JSON body the client expects. The pre-existing 404s on
      // desktop-attest / phone-attest have the same latent bug but are
      // never hit in practice (those flows always use a fresh sessionId
      // from /start). Raffle entry is the first endpoint where a stale
      // sessionId can realistically appear.
      if (!s) return jsonResp(410, { error: 'session_not_found' });
      if (s.verdict !== 'paired') {
        return jsonResp(409, { error: 'session_not_paired', verdict: s.verdict });
      }
      const sRaffle = s as unknown as { raffleHash?: string };
      if (sRaffle.raffleHash) {
        return jsonResp(409, {
          error: 'session_already_entered',
          code: hashToCode(sRaffle.raffleHash),
        });
      }
      const phonePub = s.phoneAttestation?.publicKey ?? '';
      const desktopPub = s.desktopAttestation?.publicKey ?? '';
      if (!phonePub || !desktopPub) {
        return jsonResp(409, { error: 'session_missing_attestations' });
      }
      const desktopIp = getViewerIp(event);
      const desktopUa = event.headers?.['user-agent'] ?? event.headers?.['User-Agent'] ?? '';
      const siteHost = desktopSiteHost(event);
      // Phone-side identifiers are observed during phone-attest and
      // persisted on the session row's annotations; pull them back out
      // for the rate-limit gate. Both are strings or absent.
      const a = (s as { annotations?: Record<string, unknown> }).annotations ?? {};
      const phoneUa = typeof a.phone_ua === 'string' ? a.phone_ua : '';
      const phoneIp = typeof a.phone_ip === 'string' ? a.phone_ip : '';
      const authIdentity = resolveRaffleAuthIdentity(a, s);

      // Rate-limit BEFORE consuming the session: a 429 should leave the
      // session usable so the user can re-submit after the hour rolls.
      // Five buckets — see RateLimitInputs for the per-axis rationale.
      const rl = await checkRaffleRateLimits({
        phonePub,
        desktopPub,
        desktopUa,
        desktopIp: String(desktopIp),
        phoneUa,
        phoneIp,
        authIdentity,
        siteHost,
      });
      if (!rl.ok) {
        return jsonResp(429, {
          error: 'rate_limited',
          bucket: rl.tripped,
          site: siteHost,
        });
      }

      // Hash the handle before any persistence. We never store the
      // submitted email anywhere — DDB only sees the hash + counter.
      const { hash, code } = handleHash(handle);

      // Atomically claim the session for this hash. Concurrent submits
      // for the same sessionId: loser gets 409 here.
      const enteredAt = Math.floor(Date.now() / 1000);
      if (isValkeySessionsEnabled()) {
        const claimed = await setRaffleHashValkey(sid, hash, enteredAt);
        if (!claimed) {
          return jsonResp(409, { error: 'session_already_entered' });
        }
      } else {
        try {
          await ddb.send(
            new UpdateCommand({
              TableName: TABLE,
              Key: { PK: `SESSION#${sid}`, SK: 'META' },
              UpdateExpression: 'SET raffleHash = :h, raffleEnteredAt = :t',
              ConditionExpression: 'attribute_exists(PK) AND attribute_not_exists(raffleHash)',
              ExpressionAttributeValues: {
                ':h': hash,
                ':t': enteredAt,
              },
            })
          );
        } catch (err: unknown) {
          const isConflict = (err as { name?: string })?.name === 'ConditionalCheckFailedException';
          if (isConflict) {
            return jsonResp(409, { error: 'session_already_entered' });
          }
          throw err;
        }
      }

      const updated = await ddb.send(
        new UpdateCommand({
          TableName: TABLE,
          Key: { PK: `HANDLE#${hash}`, SK: 'CT' },
          // `lbPk` and `code` aren't used by the increment itself — they
          // exist so LeaderboardIndex (GSI) can serve the top-N Query
          // without a Scan. `lbPk` is a constant partition key all
          // leaderboard rows share; `code` is the user-facing 6-char
          // handle code projected into the index so the read doesn't
          // have to recompute it from PK on every page view.
          UpdateExpression: 'ADD ct :one SET lastEntryAt = :t, lbPk = :lb, code = :code',
          ExpressionAttributeValues: {
            ':one': 1,
            ':t': Math.floor(Date.now() / 1000),
            ':lb': 'LB',
            ':code': code,
          },
          ReturnValues: 'ALL_NEW',
        })
      );
      const count = Number((updated.Attributes as { ct?: number } | undefined)?.ct ?? 1);
      return jsonResp(200, { ok: true, code, count });
    }

    case 'GET /api/raffle/status/{id}': {
      // Read-only "would entry succeed?" probe. Lets the desktop UI
      // hide the raffle form when the caller has already hit their
      // hourly cap, instead of letting them fill it in only to bonk
      // with a 429 at submit. Non-destructive — never increments any
      // bucket. Falls through to "ok" on any failure so the worst
      // case is the user sees the entry endpoint's real error once.
      //
      // Site override: browsers don't send `Origin` on same-origin
      // GETs, so falling back to desktopSiteHost(event) would compute
      // a different siteHash than POST /entry (which always gets
      // Origin) and look at a different DDB row. Client passes the
      // site as a query param to keep both ends aligned.
      const sidStatus = sessionId!;
      const sStatus = await loadSession(sidStatus);
      if (!sStatus) return jsonResp(410, { error: 'session_not_found' });
      if (sStatus.verdict !== 'paired') {
        return jsonResp(200, { status: 'not_paired', verdict: sStatus.verdict });
      }
      const enteredHash = (sStatus as unknown as { raffleHash?: string }).raffleHash;
      if (enteredHash) {
        return jsonResp(200, {
          status: 'already_entered',
          code: hashToCode(enteredHash),
        });
      }
      const phonePubStatus = sStatus.phoneAttestation?.publicKey ?? '';
      const desktopPubStatus = sStatus.desktopAttestation?.publicKey ?? '';
      if (!phonePubStatus || !desktopPubStatus) {
        return jsonResp(200, { status: 'ok' });
      }
      const ipStatus = getViewerIp(event);
      const uaStatus = event.headers?.['user-agent'] ?? event.headers?.['User-Agent'] ?? '';
      // Prefer the explicit ?site=<host> query param: same-origin GETs
      // don't carry the Origin header that desktopSiteHost falls back
      // to, so without this the peek would hash a different siteHash
      // than checkRaffleRateLimits sees at POST /entry time.
      const siteQuery = (event.queryStringParameters?.site ?? '').toLowerCase();
      const siteStatus = /^[a-z0-9.\-:]{1,253}$/.test(siteQuery)
        ? siteQuery
        : desktopSiteHost(event);
      try {
        // Pull phone-side identifiers and auth identity from the same
        // session annotations the entry path will read — peek and check
        // need to hash identical inputs.
        const aStatus = (sStatus as { annotations?: Record<string, unknown> }).annotations ?? {};
        const phoneUaStatus = typeof aStatus.phone_ua === 'string' ? aStatus.phone_ua : '';
        const phoneIpStatus = typeof aStatus.phone_ip === 'string' ? aStatus.phone_ip : '';
        const authIdStatus = resolveRaffleAuthIdentity(aStatus, sStatus);
        const peek = await peekRaffleRateLimits({
          phonePub: phonePubStatus,
          desktopPub: desktopPubStatus,
          desktopUa: uaStatus,
          desktopIp: String(ipStatus),
          phoneUa: phoneUaStatus,
          phoneIp: phoneIpStatus,
          authIdentity: authIdStatus,
          siteHost: siteStatus,
        });
        return jsonResp(200, {
          status: peek.tripped ? 'rate_limited' : 'ok',
          used: peek.used,
          cap: peek.cap,
          resetAt: peek.resetAt,
          site: siteStatus,
        });
      } catch {
        // Degrade open — if DDB is having a moment, just let the UI
        // show the form. The real entry endpoint will surface the
        // actual error.
        return jsonResp(200, { status: 'ok' });
      }
    }

    case 'GET /api/raffle/leaderboard': {
      // Single Query on LeaderboardIndex (GSI): partition lbPk="LB",
      // sort by ct DESC, take Limit=25. Server-side sorted, no Scan,
      // no client-side merge. Cost is O(top-N) regardless of total
      // entries on the table. The GSI projection includes `code` and
      // `lastEntryAt` so we have everything the response needs without
      // a follow-up GetItem per row.
      const r = await ddb.send(
        new QueryCommand({
          TableName: TABLE,
          IndexName: 'LeaderboardIndex',
          KeyConditionExpression: 'lbPk = :lb',
          ExpressionAttributeValues: { ':lb': 'LB' },
          ScanIndexForward: false,
          Limit: RAFFLE_LEADERBOARD_TOP,
        })
      );
      const out: { code: string; count: number; lastEntryAt: number }[] = (r.Items ?? []).map(
        (it) => {
          const row = it as { code?: string; ct?: number; lastEntryAt?: number };
          return {
            code: String(row.code ?? ''),
            count: Number(row.ct ?? 0),
            lastEntryAt: Number(row.lastEntryAt ?? 0),
          };
        }
      );
      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=10',
        },
        body: JSON.stringify({ leaderboard: out }),
      };
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
