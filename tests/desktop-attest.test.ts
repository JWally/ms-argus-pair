import { createHash, createSign, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { AttestationInput } from '../cdk/lib/pair-api/attestation/envelope.ts';
import { prepareDesktopAttestation } from '../cdk/lib/pair-api/desktop-attest.ts';

const session = {
  pairSessionId: '4f4cf495-a98b-4b76-9099-8ad59dc85ccb',
  nonce: 'pair_nonce_123456789',
  challengeId: 'checkout_action_123456789',
  cpi: 'argus_cpi_live_Example12345.forceauth',
  hostPreflightRequired: true,
  hostOrigin: 'https://merchant.example',
};

function signedAttestation(
  payload: Record<string, unknown>,
  scanSessionId: string
): AttestationInput {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicKeyDer = publicKey.export({ format: 'der', type: 'spki' });
  const keyId = createHash('sha256').update(publicKeyDer).digest('hex').slice(0, 16);
  const now = Math.floor(Date.now() / 1000);
  const envelope = Buffer.from(
    JSON.stringify({
      v: 1,
      purpose: 'argus-pair-v1',
      payload,
      scanSessionId,
      iat: now - 1,
      exp: now + 60,
      keyId,
    })
  ).toString('base64url');
  const signer = createSign('SHA256');
  signer.update(envelope, 'utf8');
  const signature = signer.sign({ key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64');
  return { envelope, signature, publicKey: publicKeyDer.toString('base64'), keyId };
}

function desktopBody(includeHost = true) {
  const desktopScanId = 'argus-desktop-1';
  const hostScanId = 'argus-host-1';
  return {
    argusSessionId: desktopScanId,
    attestation: signedAttestation(
      { sessionId: session.pairSessionId, nonce: session.nonce, role: 'desktop' },
      desktopScanId
    ),
    ...(includeHost
      ? {
          hostPreflight: {
            argusSessionId: hostScanId,
            attestation: signedAttestation(
              {
                role: 'host',
                pairSessionId: session.pairSessionId,
                challengeId: session.challengeId,
                cpi: session.cpi,
                origin: session.hostOrigin,
                nonce: 'host_scan_nonce_123456789',
              },
              hostScanId
            ),
          },
        }
      : {}),
  };
}

describe('prepareDesktopAttestation', () => {
  it('prepares and claims both scans for an iframe session', async () => {
    const claim = vi.fn().mockResolvedValue({ ok: true as const });
    const result = await prepareDesktopAttestation(desktopBody(), session, claim);

    expect(result).toMatchObject({
      ok: true,
      stored: {
        argusSessionId: 'argus-desktop-1',
        hostAttestation: { argusSessionId: 'argus-host-1', origin: session.hostOrigin },
      },
    });
    expect(claim).toHaveBeenNthCalledWith(1, 'argus-host-1', session.pairSessionId, 'host');
    expect(claim).toHaveBeenNthCalledWith(2, 'argus-desktop-1', session.pairSessionId, 'desktop');
  });

  it('fails closed when a required host scan is omitted', async () => {
    const claim = vi.fn();
    const result = await prepareDesktopAttestation(desktopBody(false), session, claim);

    expect(result).toMatchObject({
      ok: false,
      status: 400,
      body: { error: 'host_preflight_invalid' },
    });
    expect(claim).not.toHaveBeenCalled();
  });

  it('keeps direct non-iframe sessions working without host evidence', async () => {
    const claim = vi.fn().mockResolvedValue({ ok: true as const });
    const result = await prepareDesktopAttestation(
      desktopBody(false),
      { ...session, hostPreflightRequired: false, hostOrigin: undefined },
      claim
    );

    expect(result).toMatchObject({
      ok: true,
      stored: { argusSessionId: 'argus-desktop-1' },
    });
    if (result.ok) expect(result.stored).not.toHaveProperty('hostAttestation');
    expect(claim).toHaveBeenCalledOnce();
  });
});
