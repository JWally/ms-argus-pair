/**
 * Phone-attestation request trust-boundary contract.
 *
 * A valid phone signature is insufficient on its own: the request must bind
 * to the server session, the desktop's authenticated WebSocket envelope, and
 * a previously unused Argus scan from a different device key.
 */
import { createHash, createSign, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  preparePhoneAttestation,
  type PhoneAttestationRequestDependencies,
  type PhoneAttestationSession,
} from '../cdk/lib/pair-api/phone-attestation-request';
import type { AttestationInput } from '../cdk/lib/pair-api/attestation/envelope';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const NONCE = 'pair-nonce';
const PHONE_ARGUS_SESSION_ID = 'argus-phone-1';
const DESKTOP_ARGUS_SESSION_ID = 'argus-desktop-1';
const NOW = 1_750_000_000;

function signedPhoneAttestation(): AttestationInput {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicKeyDer = publicKey.export({ format: 'der', type: 'spki' });
  const keyId = createHash('sha256').update(publicKeyDer).digest('hex').slice(0, 16);
  const envelope = Buffer.from(
    JSON.stringify({
      v: 1,
      purpose: 'argus-pair-v1',
      payload: { sessionId: SESSION_ID, nonce: NONCE, role: 'phone' },
      scanSessionId: PHONE_ARGUS_SESSION_ID,
      iat: Math.floor(Date.now() / 1000) - 1,
      exp: Math.floor(Date.now() / 1000) + 60,
      keyId,
    })
  ).toString('base64url');
  const signer = createSign('SHA256');
  signer.update(envelope, 'utf8');
  return {
    envelope,
    signature: signer.sign({ key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64'),
    publicKey: publicKeyDer.toString('base64'),
    keyId,
  };
}

const PHONE_ATTESTATION = signedPhoneAttestation();

function session(overrides: Partial<PhoneAttestationSession> = {}): PhoneAttestationSession {
  return {
    nonce: NONCE,
    proofRequired: true,
    desktopAttestation: {
      argusSessionId: DESKTOP_ARGUS_SESSION_ID,
      envelope: 'desktop-attestation-envelope',
      signature: 'desktop-signature',
      publicKey: 'desktop-public-key',
      keyId: 'desktop-key-id',
      receivedAt: NOW - 1,
      envelopeDecoded: {
        v: 1,
        purpose: 'argus-pair-v1',
        payload: {},
        iat: NOW - 2,
        exp: NOW + 60,
        keyId: 'desktop-key-id',
      },
    },
    ...overrides,
  };
}

function body(overrides: Record<string, unknown> = {}) {
  return {
    argusSessionId: PHONE_ARGUS_SESSION_ID,
    attestation: PHONE_ATTESTATION,
    desktopEnvelope: 'sealed-desktop-envelope',
    desktopArgusSessionId: DESKTOP_ARGUS_SESSION_ID,
    desktopKeyId: 'desktop-key-id',
    webauthn: { id: 'credential-1' },
    ...overrides,
  };
}

function dependencies(
  overrides: Partial<PhoneAttestationRequestDependencies> = {}
): PhoneAttestationRequestDependencies {
  return {
    loadSession: vi.fn().mockResolvedValue(session()),
    openDesktopEnvelope: vi.fn().mockResolvedValue({
      v: 1,
      connectionId: 'desktop-connection',
      sessionId: SESSION_ID,
      role: 'desktop',
      ip: '203.0.113.10',
      origin: 'https://captcha.example',
      iat: NOW - 1,
    }),
    claimPhoneArgusSession: vi.fn().mockResolvedValue({ ok: true }),
    nowEpochSeconds: () => NOW,
    ...overrides,
  };
}

describe('phone-attestation request state gates', () => {
  it('rejects a malformed body before reading session state', async () => {
    const deps = dependencies();
    const result = await preparePhoneAttestation({}, SESSION_ID, deps);

    expect(result).toEqual({
      ok: false,
      status: 400,
      body: { error: 'missing_argusSessionId_or_attestation' },
    });
    expect(deps.loadSession).not.toHaveBeenCalled();
  });

  it('rejects an expired session and a session whose desktop is not ready', async () => {
    const missing = dependencies({ loadSession: vi.fn().mockResolvedValue(null) });
    await expect(preparePhoneAttestation(body(), SESSION_ID, missing)).resolves.toMatchObject({
      ok: false,
      status: 404,
      body: { error: 'session_not_found' },
    });

    const notReady = dependencies({
      loadSession: vi.fn().mockResolvedValue(session({ desktopAttestation: undefined })),
    });
    await expect(preparePhoneAttestation(body(), SESSION_ID, notReady)).resolves.toMatchObject({
      ok: false,
      status: 409,
      body: { error: 'desktop_not_attested_yet' },
    });
  });

  it('requires a fresh ceremony before accepting cached device trust', async () => {
    const deps = dependencies({
      loadSession: vi.fn().mockResolvedValue(session({ freshProofRequired: true })),
    });

    await expect(
      preparePhoneAttestation(body({ deviceTrustToken: 'cached-trust' }), SESSION_ID, deps)
    ).resolves.toMatchObject({
      ok: false,
      status: 401,
      body: { error: 'fresh_proof_required', clearDeviceTrust: false },
    });
  });

  it.each([
    ['already_attested', PHONE_ATTESTATION.publicKey],
    ['session_paired_with_other_device', 'another-phone-public-key'],
  ])('distinguishes an occupied phone slot as %s', async (error, publicKey) => {
    const deps = dependencies({
      loadSession: vi.fn().mockResolvedValue(
        session({
          phoneAttestation: {
            ...PHONE_ATTESTATION,
            publicKey,
            argusSessionId: 'winning-argus-session',
            receivedAt: NOW - 1,
            envelopeDecoded: {
              v: 1,
              purpose: 'argus-pair-v1',
              payload: {},
              iat: NOW - 2,
              exp: NOW + 60,
              keyId: PHONE_ATTESTATION.keyId,
            },
          },
        })
      ),
    });

    const result = await preparePhoneAttestation(body(), SESSION_ID, deps);
    expect(result).toMatchObject({ ok: false, status: 409, body: { error } });
    expect(deps.claimPhoneArgusSession).not.toHaveBeenCalled();
  });
});

describe('phone-attestation authenticated desktop binding', () => {
  it('fails closed when the desktop WebSocket envelope cannot be authenticated', async () => {
    const deps = dependencies({ openDesktopEnvelope: vi.fn().mockResolvedValue(null) });

    await expect(preparePhoneAttestation(body(), SESSION_ID, deps)).resolves.toMatchObject({
      ok: false,
      status: 400,
      body: { error: 'desktop_binding_unauthenticated' },
    });
  });

  it.each([
    ['desktop_argus_session_mismatch', { desktopArgusSessionId: 'wrong-desktop-scan' }],
    ['desktop_keyId_mismatch', { desktopKeyId: 'wrong-desktop-key' }],
    ['same_device_both_sides', { desktopKeyId: PHONE_ATTESTATION.keyId }],
  ])('rejects %s', async (error, bodyOverride) => {
    const sessionOverride =
      error === 'same_device_both_sides'
        ? session({
            desktopAttestation: {
              ...session().desktopAttestation!,
              keyId: PHONE_ATTESTATION.keyId,
            },
          })
        : session();
    const deps = dependencies({ loadSession: vi.fn().mockResolvedValue(sessionOverride) });

    await expect(
      preparePhoneAttestation(body(bodyOverride), SESSION_ID, deps)
    ).resolves.toMatchObject({ ok: false, status: 400, body: { error } });
  });

  it('rejects reuse of a phone Argus scan before proof or projection work', async () => {
    const deps = dependencies({
      claimPhoneArgusSession: vi.fn().mockResolvedValue({ ok: false, reason: 'already_claimed' }),
    });

    await expect(preparePhoneAttestation(body(), SESSION_ID, deps)).resolves.toMatchObject({
      ok: false,
      status: 409,
      body: { error: 'argus_session_already_claimed', reason: 'already_claimed' },
    });
  });

  it('returns a fully bound stored attestation and proof inputs', async () => {
    const deps = dependencies();
    const result = await preparePhoneAttestation(
      body({ oauth: { provider: 'google', token: 'token' }, deviceTrustToken: 'trust' }),
      SESSION_ID,
      deps
    );

    expect(result).toMatchObject({
      ok: true,
      session: { nonce: NONCE, proofRequired: true },
      argusSessionId: PHONE_ARGUS_SESSION_ID,
      attestation: PHONE_ATTESTATION,
      stored: {
        ...PHONE_ATTESTATION,
        argusSessionId: PHONE_ARGUS_SESSION_ID,
        receivedAt: NOW,
      },
      desktopEnv: { sessionId: SESSION_ID, role: 'desktop' },
      webauthnInput: { id: 'credential-1' },
      oauthInput: { provider: 'google', token: 'token' },
      deviceTrustToken: 'trust',
    });
    expect(deps.claimPhoneArgusSession).toHaveBeenCalledWith(PHONE_ARGUS_SESSION_ID, SESSION_ID);
  });
});
