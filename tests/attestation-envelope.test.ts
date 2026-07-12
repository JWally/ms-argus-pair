import { createHash, createSign, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  validatePairAttestationBody,
  validateSsoAttestation,
  verifyPairAttestationPayload,
  type AttestationInput,
} from '../cdk/lib/pair-api/attestation/envelope.ts';

const nowSeconds = () => Math.floor(Date.now() / 1000);

function signedAttestation(payload: Record<string, unknown>): AttestationInput {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicKeyDer = publicKey.export({ format: 'der', type: 'spki' });
  const keyId = createHash('sha256').update(publicKeyDer).digest('hex').slice(0, 16);
  const envelope = Buffer.from(
    JSON.stringify({
      v: 1,
      purpose: 'argus-pair-v1',
      payload,
      iat: nowSeconds() - 1,
      exp: nowSeconds() + 60,
      keyId,
    })
  ).toString('base64url');
  const signer = createSign('SHA256');
  signer.update(envelope, 'utf8');
  const signature = signer.sign({ key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64');
  return {
    envelope,
    signature,
    publicKey: publicKeyDer.toString('base64'),
    keyId,
  };
}

describe('validatePairAttestationBody', () => {
  it('returns a stable missing-attestation API error', () => {
    expect(validatePairAttestationBody({ argusSessionId: 'argus-1' })).toEqual({
      ok: false,
      status: 400,
      body: { error: 'missing_argusSessionId_or_attestation' },
    });
  });
});

describe('verifyPairAttestationPayload', () => {
  it('accepts a valid signed pair payload', () => {
    const result = verifyPairAttestationPayload(
      signedAttestation({ sessionId: 'session-1', nonce: 'nonce-1', role: 'phone' }),
      { sessionId: 'session-1', nonce: 'nonce-1', role: 'phone' }
    );

    expect(result.ok).toBe(true);
  });

  it('maps session, nonce, and role mismatches to stable API errors', () => {
    const attestation = signedAttestation({
      sessionId: 'session-1',
      nonce: 'nonce-1',
      role: 'phone',
    });

    expect(
      verifyPairAttestationPayload(attestation, {
        sessionId: 'other-session',
        nonce: 'nonce-1',
        role: 'phone',
      })
    ).toMatchObject({ ok: false, status: 400, body: { error: 'payload_session_mismatch' } });
    expect(
      verifyPairAttestationPayload(attestation, {
        sessionId: 'session-1',
        nonce: 'other-nonce',
        role: 'phone',
      })
    ).toMatchObject({ ok: false, status: 400, body: { error: 'payload_nonce_mismatch' } });
    expect(
      verifyPairAttestationPayload(attestation, {
        sessionId: 'session-1',
        nonce: 'nonce-1',
        role: 'desktop',
      })
    ).toMatchObject({ ok: false, status: 400, body: { error: 'payload_role_mismatch' } });
  });

  it('validates SSO attestation payload bindings', () => {
    const attestation = signedAttestation({
      ssoSessionId: 'sso-1',
      nonce: 'nonce-1',
      role: 'merchant-validate',
      returnCode: 'return-1',
      cpi: 'argus_cpi_live_Example12345.forceauth',
    });
    const body = { argusSessionId: 'argus-1', attestation };

    expect(
      validateSsoAttestation(body, {
        role: 'merchant-validate',
        sessionId: 'sso-1',
        nonce: 'nonce-1',
        returnCode: 'return-1',
        cpi: 'argus_cpi_live_Example12345.forceauth',
      })
    ).toMatchObject({ ok: true });
    expect(
      validateSsoAttestation(body, {
        role: 'merchant-validate',
        sessionId: 'sso-1',
        nonce: 'nonce-1',
        returnCode: 'wrong-return',
      })
    ).toMatchObject({ ok: false, status: 400, body: { error: 'payload_return_code_mismatch' } });
    expect(
      validateSsoAttestation(body, {
        role: 'merchant-validate',
        sessionId: 'sso-1',
        nonce: 'nonce-1',
        returnCode: 'return-1',
        cpi: 'argus_cpi_live_Example12345.stepup',
      })
    ).toMatchObject({ ok: false, status: 400, body: { error: 'payload_cpi_mismatch' } });
  });
});
