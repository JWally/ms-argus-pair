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
import { createHash, createPublicKey, createVerify, randomBytes, randomUUID } from 'crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

const TABLE = process.env.TABLE_NAME!;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean);

const SESSION_TTL_SECONDS = 300; // 5 minutes
const CLOCK_SKEW_SECONDS = 30;
const EXPECTED_PURPOSE = 'argus-pair-v1';
const MAX_BODY_BYTES = 16 * 1024;
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

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

async function loadSession(sessionId: string): Promise<SessionItem | null> {
  const res = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { PK: `SESSION#${sessionId}`, SK: 'META' } })
  );
  return (res.Item as SessionItem) ?? null;
}

export const handler = async (event: {
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
      return jsonResp(200, { ok: true });
    }

    case 'POST /api/session/{id}/phone-attest': {
      const argusSessionId = body.argusSessionId as string | undefined;
      const att = validateAttestInput(body);
      if (!argusSessionId || !att) {
        return jsonResp(400, { error: 'missing_argusSessionId_or_attestation' });
      }
      const s = await loadSession(sessionId!);
      if (!s) return jsonResp(404, { error: 'session_not_found' });
      if (!s.desktopAttestation) {
        return jsonResp(409, { error: 'desktop_not_attested_yet' });
      }
      if (s.phoneAttestation) return jsonResp(409, { error: 'already_attested' });
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
      const stored: StoredAttestation = {
        ...att,
        argusSessionId,
        receivedAt: Math.floor(Date.now() / 1000),
        envelopeDecoded: v.decoded,
      };
      // v0.1 verdict: both attestations signature-valid + same session/nonce
      // → paired. Future versions cross-reference Argus scan telemetry
      // (network, ASN, geo) before deciding, but for the demo this gates on
      // "real SDK ran on two devices, bound to the same session".
      const verdict: Verdict = 'paired';
      await ddb.send(
        new UpdateCommand({
          TableName: TABLE,
          Key: { PK: `SESSION#${sessionId}`, SK: 'META' },
          UpdateExpression: 'SET phoneAttestation = :p, verdict = :v, verdictReason = :r',
          ConditionExpression:
            'attribute_exists(PK) AND attribute_exists(desktopAttestation) AND attribute_not_exists(phoneAttestation)',
          ExpressionAttributeValues: {
            ':p': stored,
            ':v': verdict,
            ':r': 'both_attestations_verified',
          },
        })
      );
      return jsonResp(200, { verdict, reason: 'both_attestations_verified' });
    }

    case 'GET /api/session/{id}/result': {
      const s = await loadSession(sessionId!);
      if (!s) return jsonResp(200, { verdict: 'failed', reason: 'expired_or_missing' });
      return jsonResp(200, { verdict: s.verdict, reason: s.verdictReason ?? null });
    }

    default:
      // Catch-all returns 200 + error body so CloudFront's errorResponses[404]
      // (which rewrites to the SPA HTML) doesn't turn an unknown API path into
      // unparseable HTML. See the long road that led here in commit history.
      return jsonResp(200, { error: 'no_matching_route', routeKey });
  }
};
