import { createHash, createSign, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { AttestationInput } from '../cdk/lib/pair-api/attestation/envelope.ts';
import { prepareHostPreflight } from '../cdk/lib/pair-api/host-preflight.ts';

const nowSeconds = () => Math.floor(Date.now() / 1000);

function signedAttestation(
  payload: Record<string, unknown>,
  scanSessionId = 'argus-host-1'
): AttestationInput {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicKeyDer = publicKey.export({ format: 'der', type: 'spki' });
  const keyId = createHash('sha256').update(publicKeyDer).digest('hex').slice(0, 16);
  const envelope = Buffer.from(
    JSON.stringify({
      v: 1,
      purpose: 'argus-pair-v1',
      payload,
      scanSessionId,
      iat: nowSeconds() - 1,
      exp: nowSeconds() + 60,
      keyId,
    })
  ).toString('base64url');
  const signer = createSign('SHA256');
  signer.update(envelope, 'utf8');
  const signature = signer.sign({ key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64');
  return { envelope, signature, publicKey: publicKeyDer.toString('base64'), keyId };
}

const expected = {
  pairSessionId: '4f4cf495-a98b-4b76-9099-8ad59dc85ccb',
  challengeId: 'checkout_action_123456789',
  cpi: 'argus_cpi_live_Example12345.forceauth',
  origin: 'https://merchant.example',
};

function input(overrides: Record<string, unknown> = {}) {
  const payload = {
    role: 'host',
    pairSessionId: expected.pairSessionId,
    challengeId: expected.challengeId,
    cpi: expected.cpi,
    origin: expected.origin,
    nonce: 'host_scan_nonce_123456789',
    ...overrides,
  };
  return { argusSessionId: 'argus-host-1', attestation: signedAttestation(payload) };
}

describe('prepareHostPreflight', () => {
  it('accepts and stores a signed host scan bound to the merchant action', async () => {
    const claim = vi.fn().mockResolvedValue({ ok: true as const });
    const result = await prepareHostPreflight(input(), expected, claim);

    expect(result).toMatchObject({
      ok: true,
      stored: {
        argusSessionId: 'argus-host-1',
        origin: expected.origin,
        envelopeDecoded: { payload: { role: 'host', challengeId: expected.challengeId } },
      },
    });
    expect(claim).toHaveBeenCalledWith('argus-host-1', expected.pairSessionId, 'host');
  });

  it.each([
    ['role', { role: 'desktop' }, 'host_preflight_role_mismatch'],
    [
      'pair session',
      { pairSessionId: 'f72a9a1e-a91e-4ca9-ac0b-b3648b3efde4' },
      'host_preflight_session_mismatch',
    ],
    ['challenge', { challengeId: 'different_action_123456' }, 'host_preflight_challenge_mismatch'],
    ['cpi', { cpi: 'argus_cpi_live_Different1234' }, 'host_preflight_cpi_mismatch'],
    ['origin', { origin: 'https://other.example' }, 'host_preflight_origin_mismatch'],
  ])('rejects a mismatched %s before claiming the scan', async (_name, overrides, error) => {
    const claim = vi.fn();
    const result = await prepareHostPreflight(input(overrides), expected, claim);

    expect(result).toMatchObject({ ok: false, status: 400, body: { error } });
    expect(claim).not.toHaveBeenCalled();
  });

  it('rejects an invalid signed nonce before claiming the scan', async () => {
    const claim = vi.fn();
    const result = await prepareHostPreflight(input({ nonce: 'short' }), expected, claim);

    expect(result).toMatchObject({
      ok: false,
      status: 400,
      body: { error: 'host_preflight_nonce_invalid' },
    });
    expect(claim).not.toHaveBeenCalled();
  });

  it('rejects substitution of an unsigned Argus scan id before claiming it', async () => {
    const claim = vi.fn();
    const substituted = input();
    substituted.attestation = signedAttestation(
      {
        role: 'host',
        pairSessionId: expected.pairSessionId,
        challengeId: expected.challengeId,
        cpi: expected.cpi,
        origin: expected.origin,
        nonce: 'host_scan_nonce_123456789',
      },
      'different-argus-scan'
    );

    const result = await prepareHostPreflight(substituted, expected, claim);

    expect(result).toMatchObject({
      ok: false,
      status: 400,
      body: { error: 'host_preflight_scan_mismatch' },
    });
    expect(claim).not.toHaveBeenCalled();
  });

  it('rejects replay when the Argus session id has already been claimed', async () => {
    const claim = vi.fn().mockResolvedValue({ ok: false as const, reason: 'already_claimed' });
    const result = await prepareHostPreflight(input(), expected, claim);

    expect(result).toEqual({
      ok: false,
      status: 409,
      body: { error: 'host_preflight_already_claimed', reason: 'already_claimed' },
    });
  });
});
