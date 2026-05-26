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
import {
  createHash,
  createHmac,
  createPublicKey,
  createVerify,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { verifyRegistrationResponse } from '@simplewebauthn/server';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import middy from '@middy/core';
import type { MiddlewareObj } from '@middy/core';

const TABLE = process.env.TABLE_NAME!;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean);

const MERCHANT_API_URL = process.env.MERCHANT_API_URL || '';
const MERCHANT_API_CREDENTIAL = process.env.MERCHANT_API_CREDENTIAL || '';
const MERCHANT_CPI = process.env.MERCHANT_CPI || '';

const SESSION_TTL_SECONDS = 300; // 5 minutes
const CLOCK_SKEW_SECONDS = 30;
const EXPECTED_PURPOSE = 'argus-pair-v1';
const MAX_BODY_BYTES = 16 * 1024;
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Verdict thresholds (per spec). Individual = max(automation, device_tampering,
// network_tampering) for one side. Total = sum of the two sides' individual
// scores.
const INDIVIDUAL_SCORE_LIMIT = 30;
const TOTAL_SCORE_LIMIT = 50;

// WebAuthn RP identifier. Must match the rpId the phone passes to
// startRegistration on the client (window.location.hostname).
const WEBAUTHN_RP_ID = process.env.WEBAUTHN_RP_ID || 'captcha-dev-jw.argus.pw';
const WEBAUTHN_EXPECTED_ORIGIN = `https://${WEBAUTHN_RP_ID}`;

// Device-trust token. Once a phone passes WebAuthn we mint an HMAC-signed
// blob containing (pubkey, ip, exp). On the NEXT visit within the TTL,
// from the same IP, the phone presents the token instead of running the
// biometric ceremony again. Strict IP-pin: any drift forces fresh
// WebAuthn. The HMAC secret lives in Secrets Manager so it survives
// Lambda redeploys (otherwise every deploy would invalidate every token).
const DEVICE_TRUST_SECRET_ARN = process.env.DEVICE_TRUST_SECRET_ARN || '';
const DEVICE_TRUST_TTL_SECONDS = 12 * 3600;
const sm = new SecretsManagerClient({});
let cachedTrustSecret: string | null = null;
async function getTrustSecret(): Promise<string | null> {
  if (cachedTrustSecret) return cachedTrustSecret;
  if (!DEVICE_TRUST_SECRET_ARN) return null;
  try {
    const r = await sm.send(new GetSecretValueCommand({ SecretId: DEVICE_TRUST_SECRET_ARN }));
    cachedTrustSecret = r.SecretString || null;
    return cachedTrustSecret;
  } catch (e) {
    console.warn(`[pair] getTrustSecret failed: ${(e as Error).message}`);
    return null;
  }
}

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

async function claimArgusSessionId(
  argusSessionId: string,
  pairSessionId: string,
  role: 'desktop' | 'phone'
): Promise<{ ok: true } | { ok: false; reason: string }> {
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
    if (isConflict) return { ok: false, reason: 'already_claimed' };
    throw err;
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

function projectionAgeSeconds(p: MerchantProjection | null): number | null {
  if (!p || typeof p.created_at !== 'number') return null;
  return Math.round((Date.now() - p.created_at) / 1000);
}

function isProjectionFresh(p: MerchantProjection | null): boolean {
  const age = projectionAgeSeconds(p);
  if (age === null) return false;
  return age >= -PROJECTION_FRESHNESS_WINDOW_SECONDS && age <= PROJECTION_FRESHNESS_WINDOW_SECONDS;
}

type Verdict = 'pending' | 'paired' | 'failed';

interface AttestationInput {
  envelope: string;
  signature: string;
  publicKey: string;
  keyId: string;
}

interface StoredAttestation extends AttestationInput {
  argusSessionId: string;
  receivedAt: number;
  envelopeDecoded: {
    v: number;
    purpose: string;
    payload: Record<string, unknown>;
    iat: number;
    exp: number;
    keyId: string;
  };
}

interface SessionItem {
  PK: string;
  SK: string;
  nonce: string;
  expiresAt: number;
  desktopAttestation?: StoredAttestation;
  phoneAttestation?: StoredAttestation;
  verdict: Verdict;
  verdictReason?: string;
}

function jsonResp(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
    body: JSON.stringify(body),
  };
}

function originAllowed(event: { headers?: Record<string, string | undefined> }): boolean {
  if (ALLOWED_ORIGINS.length === 0) return true; // dev
  const o = event.headers?.origin || event.headers?.Origin;
  // Same-origin GET requests in some browsers (Chrome) omit the Origin
  // header entirely. Rejecting on missing Origin would block legitimate
  // polling from the SPA, and CloudFront would then rewrite the 403 to
  // the SPA HTML (errorResponses[403] needed for client-side routing) —
  // which the JSON parser blows up on. So: allow if Origin is absent
  // (browser couldn't have set it for a cross-origin call), reject only
  // when it's explicitly wrong. CORS preflight handles the rest.
  if (!o) return true;
  return ALLOWED_ORIGINS.includes(o);
}

function b64urlToBuf(s: string): Buffer {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function p1363ToDer(sig: Buffer): Buffer {
  // ECDSA-P-256 IEEE-P1363 → DER. WebCrypto signs in P1363 (r||s, 64 bytes);
  // Node's crypto.verify wants DER unless dsaEncoding: 'ieee-p1363' is set,
  // but the option name needed Node 16+ and was buggy on some platforms.
  // Convert explicitly to avoid surprises.
  if (sig.length !== 64) throw new Error('signature: expected 64 bytes for P-256');
  const r = sig.subarray(0, 32);
  const s = sig.subarray(32, 64);
  const rTrim = trimLeadZero(r);
  const sTrim = trimLeadZero(s);
  const rDer = Buffer.concat([Buffer.from([0x02, rTrim.length]), rTrim]);
  const sDer = Buffer.concat([Buffer.from([0x02, sTrim.length]), sTrim]);
  const seq = Buffer.concat([rDer, sDer]);
  return Buffer.concat([Buffer.from([0x30, seq.length]), seq]);
}

function trimLeadZero(b: Buffer): Buffer {
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++;
  // If high bit set, prepend 0x00 (DER positive-integer convention).
  if (b[i] & 0x80) return Buffer.concat([Buffer.from([0]), b.subarray(i)]);
  return b.subarray(i);
}

interface VerifyResult {
  ok: boolean;
  reason?: string;
  decoded?: StoredAttestation['envelopeDecoded'];
}

function verifyAttestation(a: AttestationInput): VerifyResult {
  // 1. Decode envelope.
  let json: string;
  try {
    json = b64urlToBuf(a.envelope).toString('utf8');
  } catch {
    return { ok: false, reason: 'envelope_not_base64url' };
  }
  let decoded: StoredAttestation['envelopeDecoded'];
  try {
    decoded = JSON.parse(json);
  } catch {
    return { ok: false, reason: 'envelope_not_json' };
  }
  if (decoded.v !== 1) return { ok: false, reason: 'envelope_version' };
  if (typeof decoded.purpose !== 'string' || decoded.purpose !== EXPECTED_PURPOSE) {
    return { ok: false, reason: 'envelope_purpose_mismatch' };
  }
  const now = Math.floor(Date.now() / 1000);
  if (now < decoded.iat - CLOCK_SKEW_SECONDS) {
    return { ok: false, reason: 'envelope_not_yet_valid' };
  }
  if (now > decoded.exp + CLOCK_SKEW_SECONDS) {
    return { ok: false, reason: 'envelope_expired' };
  }

  // 2. keyId is sha256(SPKI)[0..16] hex; check it matches both the envelope's
  //    claimed keyId and the top-level attestation.keyId.
  const pkBytes = Buffer.from(a.publicKey, 'base64');
  const derivedKeyId = createHash('sha256').update(pkBytes).digest('hex').slice(0, 16);
  if (derivedKeyId !== decoded.keyId || derivedKeyId !== a.keyId) {
    return { ok: false, reason: 'keyId_mismatch' };
  }

  // 3. Verify signature over the raw envelope bytes (the base64url string itself).
  let pubKey;
  try {
    pubKey = createPublicKey({ key: pkBytes, format: 'der', type: 'spki' });
  } catch {
    return { ok: false, reason: 'publicKey_not_spki' };
  }
  let sigBuf: Buffer;
  try {
    sigBuf = Buffer.from(a.signature, 'base64');
  } catch {
    return { ok: false, reason: 'signature_not_base64' };
  }
  let sigDer: Buffer;
  try {
    sigDer = p1363ToDer(sigBuf);
  } catch (e) {
    return { ok: false, reason: `signature_shape: ${(e as Error).message}` };
  }
  const verifier = createVerify('SHA256');
  verifier.update(a.envelope, 'utf8');
  const sigOk = verifier.verify(pubKey, sigDer);
  if (!sigOk) return { ok: false, reason: 'signature_verify_failed' };

  return { ok: true, decoded };
}

function parseBody(raw: string | undefined): Record<string, unknown> | null {
  if (!raw) return {};
  if (raw.length > MAX_BODY_BYTES) return null;
  try {
    const v = JSON.parse(raw);
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function validateAttestInput(body: Record<string, unknown>): AttestationInput | null {
  const att = body.attestation as Record<string, unknown> | undefined;
  if (!att) return null;
  if (
    typeof att.envelope !== 'string' ||
    typeof att.signature !== 'string' ||
    typeof att.publicKey !== 'string' ||
    typeof att.keyId !== 'string'
  )
    return null;
  return {
    envelope: att.envelope,
    signature: att.signature,
    publicKey: att.publicKey,
    keyId: att.keyId,
  };
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
    asnName,
    city,
    country,
    isMobileNetwork,
    isVpn,
  };
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
 *   Golden ticket: PAT on a side overrides score + DC checks for that side only.
 *   Soft rules: DC OK on desktop, NOT OK on phone (unless PAT).
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

  // PAT overrides individual score + DC checks for that side only.
  const desktopScoreOk = desktop.patAttested || desktop.individualScore < INDIVIDUAL_SCORE_LIMIT;
  const phoneScoreOk = phone.patAttested || phone.individualScore < INDIVIDUAL_SCORE_LIMIT;
  if (!desktopScoreOk) {
    return { verdict: 'failed', reason: 'desktop_score_high', annotations };
  }
  if (!phoneScoreOk) {
    return { verdict: 'failed', reason: 'phone_score_high', annotations };
  }

  const totalScore = desktop.individualScore + phone.individualScore;
  // PAT on both sides: skip total check (both already golden-ticketed).
  if (!(desktop.patAttested && phone.patAttested) && totalScore >= TOTAL_SCORE_LIMIT) {
    return { verdict: 'failed', reason: 'total_score_high', annotations };
  }

  // Phone-on-datacenter — not OK unless PAT covered.
  if (phone.isDatacenter && !phone.patAttested) {
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

// ── Device-trust token (silent re-auth after first WebAuthn) ──────────────

interface DeviceTrustPayload {
  v: 1;
  pubkey: string; // SPKI base64, matches the SDK device key
  keyId: string;
  ip: string; // strict — any drift forces re-WebAuthn
  iat: number;
  exp: number;
}

function b64urlEncodeBytes(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function mintDeviceTrust(pubkey: string, keyId: string, ip: string): Promise<string | null> {
  const secret = await getTrustSecret();
  if (!secret || !ip) return null;
  const iat = Math.floor(Date.now() / 1000);
  const payload: DeviceTrustPayload = {
    v: 1,
    pubkey,
    keyId,
    ip,
    iat,
    exp: iat + DEVICE_TRUST_TTL_SECONDS,
  };
  const body = b64urlEncodeBytes(Buffer.from(JSON.stringify(payload), 'utf8'));
  const mac = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

interface DeviceTrustVerifyResult {
  ok: boolean;
  reason?: string;
  payload?: DeviceTrustPayload;
}

async function verifyDeviceTrust(
  token: string,
  requesterIp: string,
  expectedPubKey: string
): Promise<DeviceTrustVerifyResult> {
  if (typeof token !== 'string' || !token.includes('.')) {
    return { ok: false, reason: 'malformed' };
  }
  const [body, mac] = token.split('.', 2);
  if (!body || !mac) return { ok: false, reason: 'malformed' };
  const secret = await getTrustSecret();
  if (!secret) return { ok: false, reason: 'no_secret' };
  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'hmac' };
  }
  let payload: DeviceTrustPayload;
  try {
    payload = JSON.parse(b64urlToBuf(body).toString('utf8')) as DeviceTrustPayload;
  } catch {
    return { ok: false, reason: 'not_json' };
  }
  if (payload.v !== 1) return { ok: false, reason: 'version' };
  const now = Math.floor(Date.now() / 1000);
  if (now > payload.exp) return { ok: false, reason: 'expired' };
  if (!requesterIp) return { ok: false, reason: 'no_requester_ip' };
  if (payload.ip !== requesterIp) return { ok: false, reason: 'ip_changed' };
  if (payload.pubkey !== expectedPubKey) return { ok: false, reason: 'pubkey_mismatch' };
  return { ok: true, payload };
}

/**
 * Real client IP. APIGW HTTP v2's requestContext.http.sourceIp is CloudFront's
 * edge — useless for device-trust binding. Read the real viewer IP from the
 * CloudFront-Viewer-Address header (set by the same-origin /api/* behavior
 * via the ALL_VIEWER_EXCEPT_HOST_HEADER origin request policy).
 */
function getViewerIp(event: {
  headers?: Record<string, string | undefined>;
  requestContext?: { http?: { sourceIp?: string }; identity?: { sourceIp?: string } };
}): string {
  const headers = event.headers || {};
  const raw = headers['cloudfront-viewer-address'] || headers['CloudFront-Viewer-Address'] || '';
  if (raw) {
    // IPv6: "[2001:db8::1]:12345"
    if (raw.startsWith('[')) {
      const close = raw.indexOf(']');
      if (close > 0) return raw.slice(1, close);
    }
    // IPv4: "1.2.3.4:54321"
    const lastColon = raw.lastIndexOf(':');
    if (lastColon > 0) return raw.slice(0, lastColon);
    return raw;
  }
  return event.requestContext?.http?.sourceIp ?? event.requestContext?.identity?.sourceIp ?? '';
}

// ── WebAuthn proof-of-life verification ────────────────────────────────────

interface WebAuthnAnnotations {
  phone_webauthn_attested: boolean;
  phone_webauthn_aaguid?: string;
  phone_webauthn_format?: string;
  phone_webauthn_credential_backed_up?: boolean;
  phone_webauthn_user_verified?: boolean;
  phone_webauthn_error?: string;
}

/**
 * Verify the phone's WebAuthn proof-of-life registration. Uses the
 * session nonce as expectedChallenge — the same nonce the phone signed
 * over in the Argus envelope, so a single binding ties together the
 * Argus scan, the device key, and the TEE attestation.
 *
 * Credentials are non-resident (residentKey:'discouraged' on the
 * client) and we don't persist the credentialId server-side, so the
 * credential is truly ephemeral — nothing to clean up.
 */
async function verifyWebAuthn(
  webauthn: unknown,
  expectedNonce: string
): Promise<WebAuthnAnnotations> {
  if (!webauthn || typeof webauthn !== 'object') {
    return { phone_webauthn_attested: false, phone_webauthn_error: 'missing' };
  }
  const w = webauthn as Record<string, unknown>;
  if (typeof w.error === 'string') {
    return { phone_webauthn_attested: false, phone_webauthn_error: w.error };
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
  const res = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { PK: `SESSION#${sessionId}`, SK: 'META' } })
  );
  return (res.Item as SessionItem) ?? null;
}

const lambdaHandler = async (event: {
  routeKey: string;
  pathParameters?: Record<string, string | undefined>;
  body?: string;
  headers?: Record<string, string | undefined>;
}) => {
  if (!originAllowed(event)) return jsonResp(403, { error: 'origin_not_allowed' });

  const routeKey = event.routeKey;
  const sessionId = event.pathParameters?.id?.toLowerCase();
  if (routeKey !== 'POST /api/session/start' && !SESSION_ID_RE.test(sessionId ?? '')) {
    return jsonResp(400, { error: 'invalid_session_id' });
  }
  const body = parseBody(event.body);
  if (body === null) return jsonResp(400, { error: 'invalid_body' });

  switch (routeKey) {
    case 'POST /api/session/start': {
      const id = randomUUID();
      const nonce = randomBytes(32).toString('base64url');
      const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
      const item: SessionItem = {
        PK: `SESSION#${id}`,
        SK: 'META',
        nonce,
        expiresAt,
        verdict: 'pending',
      };
      await ddb.send(
        new PutCommand({
          TableName: TABLE,
          Item: item,
          ConditionExpression: 'attribute_not_exists(PK)',
        })
      );
      return jsonResp(200, { sessionId: id, nonce, expiresAt });
    }

    case 'GET /api/session/{id}/info': {
      const s = await loadSession(sessionId!);
      if (!s) return jsonResp(200, { expired: true });
      return jsonResp(200, {
        nonce: s.nonce,
        expiresAt: s.expiresAt,
        desktopReady: !!s.desktopAttestation,
        verdict: s.verdict,
        // Phone needs these to bind its signed envelope to the specific
        // desktop scan it's pairing with. Both are server-anchored — the
        // phone signs over them but doesn't get to pick the values.
        desktopArgusSessionId: s.desktopAttestation?.argusSessionId,
        desktopKeyId: s.desktopAttestation?.keyId,
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
      await ddb.send(
        new UpdateCommand({
          TableName: TABLE,
          Key: { PK: `SESSION#${sessionId}`, SK: 'META' },
          UpdateExpression: 'SET desktopAttestation = :d',
          ConditionExpression: 'attribute_exists(PK) AND attribute_not_exists(desktopAttestation)',
          ExpressionAttributeValues: { ':d': stored },
        })
      );

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
      // Device-trust token. Alternative to a fresh WebAuthn ceremony —
      // proves "this device passed WebAuthn recently from this same IP".
      // Strict IP-pin; any verify failure returns 401 so the client can
      // clear the stale token and fall back to fresh WebAuthn.
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
        desktopArgusSessionId?: string;
        desktopKeyId?: string;
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
      // Phone bound itself to the host's argusSessionId — verify it matches what
      // the desktop actually submitted. Stops a third party from joining a
      // session they've snooped the QR for *and* swapping their own desktop scan in.
      if (payload.desktopArgusSessionId !== s.desktopAttestation.argusSessionId) {
        return jsonResp(400, { error: 'desktop_argus_session_mismatch' });
      }
      if (payload.desktopKeyId !== s.desktopAttestation.keyId) {
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
      const [desktopProj, phoneProj, webauthnResult] = await Promise.all([
        fetchProjection(s.desktopAttestation.argusSessionId),
        fetchProjection(argusSessionId),
        trustResult?.ok
          ? Promise.resolve<WebAuthnAnnotations>({
              phone_webauthn_attested: true,
              phone_webauthn_user_verified: true,
              phone_webauthn_format: 'device_trust_redeem',
            } as WebAuthnAnnotations)
          : verifyWebAuthn(webauthnInput, s.nonce),
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

      if (!proofOfLife) {
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
        annotations = { ...computed.annotations, ...webauthnResult };
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
              (existing as unknown as { annotations?: Record<string, unknown> }).annotations ?? {},
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
      return jsonResp(200, { verdict, reason, annotations, nextDeviceTrust });
    }

    case 'GET /api/session/{id}/result': {
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
