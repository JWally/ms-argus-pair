/**
 * Signed-envelope verification for desktop / phone attestations.
 *
 * Envelope shape (base64url-encoded JSON):
 *   { v:1, purpose, payload, iat, exp, keyId }
 *
 * Verification steps:
 *   1. base64url-decode the envelope, parse JSON
 *   2. structural checks: v === 1, purpose matches, iat/exp within skew
 *   3. keyId derived from publicKey (sha256(SPKI)[0..16] hex) matches both
 *      the envelope's claimed keyId and the top-level attestation.keyId
 *   4. ECDSA-P256-SHA256 verify(signature, raw envelope bytes, publicKey)
 *
 * Lives here (not shared/) because the entire pair-api attestation flow
 * — desktop-attest, phone-attest, verdict computation — depends on this
 * shape. Other slices (raffle, debug) don't.
 */

import { createHash, createPublicKey, createVerify } from 'crypto';

const CLOCK_SKEW_SECONDS = 30;
const EXPECTED_PURPOSE = 'argus-pair-v1';

/** Raw envelope payload as received in the request body. */
export interface AttestationInput {
  envelope: string;
  signature: string;
  publicKey: string;
  keyId: string;
}

/** The structured contents of a base64url-decoded envelope. */
export interface EnvelopeDecoded {
  v: number;
  purpose: string;
  payload: Record<string, unknown>;
  iat: number;
  exp: number;
  keyId: string;
  /** Exact Argus integrity row created by the run that signed this envelope. */
  scanSessionId?: string;
}

export interface VerifyResult {
  ok: boolean;
  reason?: string;
  decoded?: EnvelopeDecoded;
}

export type PairAttestationRole = 'desktop' | 'phone';

export type PairAttestationPayloadResult =
  | { ok: true; decoded: EnvelopeDecoded }
  | { ok: false; status: number; body: unknown };

export type SsoAttestationResult =
  | { ok: true; attestation: AttestationInput }
  | { ok: false; status: number; body: unknown };

export type PairAttestationBodyResult =
  | { ok: true; argusSessionId: string; attestation: AttestationInput }
  | {
      ok: false;
      status: 400;
      body: { error: 'missing_argusSessionId_or_attestation' };
    };

/**
 * Base64url → Buffer. Pads as needed; assumes valid base64url
 * alphabet, throws otherwise (caller wraps in try/catch).
 */
export function b64urlToBuf(s: string): Buffer {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

/**
 * ECDSA-P-256 signature: IEEE-P1363 → DER.
 *
 * WebCrypto signs in P1363 (r||s, 64 bytes); Node's crypto.verify wants
 * DER unless dsaEncoding: 'ieee-p1363' is set. That option needed Node
 * 16+ and was buggy on some platforms, so we convert explicitly.
 */
export function p1363ToDer(sig: Buffer): Buffer {
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

/**
 * Strip leading zero bytes from an ECDSA r/s component, preserving the
 * DER positive-integer convention (prepend 0x00 if the high bit is set).
 */
function trimLeadZero(b: Buffer): Buffer {
  let i = 0;
  while (i < b.length - 1 && b.readUInt8(i) === 0) i++;
  if (b.readUInt8(i) & 0x80) return Buffer.concat([Buffer.from([0]), b.subarray(i)]);
  return b.subarray(i);
}

/** Verify an attestation envelope. See module comment for the steps. */
export function verifyAttestation(a: AttestationInput): VerifyResult {
  // 1. Decode envelope.
  let json: string;
  try {
    json = b64urlToBuf(a.envelope).toString('utf8');
  } catch {
    return { ok: false, reason: 'envelope_not_base64url' };
  }
  let decoded: EnvelopeDecoded;
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

  // 2. keyId is sha256(SPKI)[0..16] hex; check it matches both the
  //    envelope's claimed keyId and the top-level attestation.keyId.
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

/**
 * Pluck and shape-check the `attestation` field of a request body.
 * Returns null if any required string is missing/wrong type; callers
 * then 400 the request.
 */
export function validateAttestInput(body: Record<string, unknown>): AttestationInput | null {
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

export function validatePairAttestationBody(
  body: Record<string, unknown>
): PairAttestationBodyResult {
  const attestation = validateAttestInput(body);
  const argusSessionId = body.argusSessionId as string | undefined;
  if (!argusSessionId || !attestation) {
    return {
      ok: false,
      status: 400,
      body: { error: 'missing_argusSessionId_or_attestation' },
    };
  }
  return { ok: true, argusSessionId, attestation };
}

function invalidAttestationResult(reason: string | undefined) {
  return {
    ok: false as const,
    status: 400,
    body: { error: 'attestation_invalid', reason },
  };
}

export function verifyPairAttestationPayload(
  attestation: AttestationInput,
  expected: {
    role: PairAttestationRole;
    sessionId: string;
    nonce: string;
    argusSessionId: string;
  }
): PairAttestationPayloadResult {
  const verified = verifyAttestation(attestation);
  if (!verified.ok || !verified.decoded) {
    return invalidAttestationResult(verified.reason);
  }
  if (verified.decoded.scanSessionId !== expected.argusSessionId) {
    return { ok: false, status: 400, body: { error: 'attestation_scan_mismatch' } };
  }
  const payload = verified.decoded.payload as {
    sessionId?: string;
    nonce?: string;
    role?: string;
  };
  if (payload.sessionId !== expected.sessionId) {
    return { ok: false, status: 400, body: { error: 'payload_session_mismatch' } };
  }
  if (payload.nonce !== expected.nonce) {
    return { ok: false, status: 400, body: { error: 'payload_nonce_mismatch' } };
  }
  if (payload.role !== expected.role) {
    return { ok: false, status: 400, body: { error: 'payload_role_mismatch' } };
  }
  return { ok: true, decoded: verified.decoded };
}

export function validateSsoAttestation(
  body: Record<string, unknown>,
  expected: { role: string; sessionId?: string; nonce?: string; returnCode?: string; cpi: string }
): SsoAttestationResult {
  const pairBody = validatePairAttestationBody(body);
  if (!pairBody.ok) return pairBody;
  const verified = verifyAttestation(pairBody.attestation);
  if (!verified.ok || !verified.decoded) {
    return invalidAttestationResult(verified.reason);
  }
  if (verified.decoded.scanSessionId !== pairBody.argusSessionId) {
    return { ok: false, status: 400, body: { error: 'attestation_scan_mismatch' } };
  }
  const payload = verified.decoded.payload as {
    role?: string;
    ssoSessionId?: string;
    nonce?: string;
    returnCode?: string;
    cpi?: string;
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
  if (payload.cpi !== expected.cpi) {
    return { ok: false, status: 400, body: { error: 'payload_cpi_mismatch' } };
  }
  return { ok: true, attestation: pairBody.attestation };
}
