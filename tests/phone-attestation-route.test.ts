/**
 * Phone-attestation route integration contract.
 *
 * Cryptographic preparation, storage, projections, and verdict delivery are
 * fake adapters here. The real route must orchestrate them in fail-closed
 * order without giving a competing scanner another device's success.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createPhoneAttestationHandler,
  type PhoneAttestationRouteDependencies,
} from '../cdk/lib/pair-api/phone-attestation-route';
import { classifyScan } from '../cdk/lib/pair-api/projection-verdict';
import type { PreparedPhoneAttestation } from '../cdk/lib/pair-api/phone-attestation-request';
import { merchantProjection } from './fixtures/merchant-projection';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const REQUESTER_IP = '203.0.113.20';
const NOW = 1_750_000_000;

const DESKTOP_PROJECTION = merchantProjection({ session_id: 'argus-desktop-1' });
const PHONE_PROJECTION = merchantProjection({
  session_id: 'argus-phone-1',
  identification: {
    browserDetails: {
      browserName: 'Chrome',
      browserVersion: '150',
      device: 'mobile',
      os: 'iOS',
      userAgent: 'Mozilla/5.0 (iPhone) Mobile',
    },
  },
});

function prepared(overrides: Partial<PreparedPhoneAttestation> = {}): PreparedPhoneAttestation {
  return {
    ok: true,
    session: {
      nonce: 'pair-nonce',
      proofRequired: true,
      desktopAttestation: {
        argusSessionId: 'argus-desktop-1',
        envelope: 'desktop-envelope',
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
    },
    argusSessionId: 'argus-phone-1',
    attestation: {
      envelope: 'phone-envelope',
      signature: 'phone-signature',
      publicKey: 'phone-public-key',
      keyId: 'phone-key-id',
    },
    stored: {
      argusSessionId: 'argus-phone-1',
      envelope: 'phone-envelope',
      signature: 'phone-signature',
      publicKey: 'phone-public-key',
      keyId: 'phone-key-id',
      receivedAt: NOW,
      envelopeDecoded: {
        v: 1,
        purpose: 'argus-pair-v1',
        payload: {},
        iat: NOW - 1,
        exp: NOW + 60,
        keyId: 'phone-key-id',
      },
    },
    desktopEnv: {
      v: 1,
      connectionId: 'desktop-connection',
      sessionId: SESSION_ID,
      role: 'desktop',
      ip: '203.0.113.10',
      origin: 'https://captcha.example',
      iat: NOW - 1,
    },
    webauthnInput: { id: 'credential-1' },
    oauthInput: undefined,
    deviceTrustToken: undefined,
    ...overrides,
  };
}

function dependencies(
  overrides: Partial<PhoneAttestationRouteDependencies> = {}
): PhoneAttestationRouteDependencies {
  return {
    prepare: vi.fn().mockResolvedValue(prepared()),
    verifyDeviceTrust: vi.fn(),
    verifyProof: vi.fn().mockResolvedValue({
      phone_webauthn_attested: true,
      phone_webauthn_format: 'none',
    }),
    collectHostEvidence: vi.fn().mockResolvedValue({
      iframeProjection: DESKTOP_PROJECTION,
      iframeScan: classifyScan(DESKTOP_PROJECTION, 'desktop'),
      annotations: { host_preflight_bound: false },
    }),
    fetchPhoneProjection: vi.fn().mockResolvedValue(PHONE_PROJECTION),
    mintDeviceTrust: vi.fn().mockResolvedValue('next-device-trust'),
    commit: vi.fn().mockResolvedValue({ outcome: 'committed' }),
    deliverVerdict: vi.fn().mockResolvedValue({
      verdict: 'complete',
      reason: null,
      annotations: {},
      phoneState: 'sealed-phone-state',
    }),
    nowEpochSeconds: () => NOW,
    proofRequiredByDefault: false,
    logInfo: vi.fn(),
    logWarn: vi.fn(),
    ...overrides,
  };
}

function bodyOf(response: { body: string }) {
  return JSON.parse(response.body) as Record<string, unknown>;
}

describe('phone-attestation route gates', () => {
  it('forwards request-preparation failures before proof or projection work', async () => {
    const deps = dependencies({
      prepare: vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        body: { error: 'desktop_binding_unauthenticated' },
      }),
    });

    const response = await createPhoneAttestationHandler(deps)({}, SESSION_ID, REQUESTER_IP);
    expect(response.statusCode).toBe(400);
    expect(bodyOf(response)).toEqual({ error: 'desktop_binding_unauthenticated' });
    expect(deps.verifyProof).not.toHaveBeenCalled();
    expect(deps.commit).not.toHaveBeenCalled();
  });

  it('rejects invalid cached device trust before launching downstream work', async () => {
    const trustPrepared = prepared({ deviceTrustToken: 'stale-token' });
    const deps = dependencies({
      prepare: vi.fn().mockResolvedValue(trustPrepared),
      verifyDeviceTrust: vi.fn().mockResolvedValue({ ok: false, reason: 'expired' }),
    });

    const response = await createPhoneAttestationHandler(deps)({}, SESSION_ID, REQUESTER_IP);
    expect(response.statusCode).toBe(401);
    expect(bodyOf(response)).toEqual({ error: 'device_trust_invalid', reason: 'expired' });
    expect(deps.verifyProof).not.toHaveBeenCalled();
    expect(deps.fetchPhoneProjection).not.toHaveBeenCalled();
  });
});

describe('phone-attestation verdict orchestration', () => {
  it('scores fresh proof and projections, commits, and seals the result', async () => {
    const deps = dependencies();
    const response = await createPhoneAttestationHandler(deps)({}, SESSION_ID, REQUESTER_IP);

    expect(deps.verifyProof).toHaveBeenCalledWith({
      webauthn: { id: 'credential-1' },
      oauth: undefined,
      expectedNonce: 'pair-nonce',
      argusPubkey: 'phone-public-key',
      trustRedeemed: false,
    });
    expect(deps.collectHostEvidence).toHaveBeenCalledWith({
      hostArgusSessionId: null,
      iframeArgusSessionId: 'argus-desktop-1',
      pairSessionId: SESSION_ID,
    });
    expect(deps.mintDeviceTrust).toHaveBeenCalledWith(
      'phone-public-key',
      'phone-key-id',
      REQUESTER_IP
    );
    expect(deps.commit).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: SESSION_ID,
        verdict: 'paired',
        reason: 'paired_desktop_and_phone',
        annotations: expect.objectContaining({ proof_of_life: true }),
      })
    );
    expect(deps.deliverVerdict).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: SESSION_ID,
        verdict: 'paired',
        nextDeviceTrust: 'next-device-trust',
        decidedAt: NOW,
        now: NOW,
      })
    );
    expect(response.statusCode).toBe(200);
    expect(bodyOf(response)).toMatchObject({
      verdict: 'complete',
      phoneState: 'sealed-phone-state',
    });
  });

  it('redeems device trust without minting a replacement and records IP drift', async () => {
    const trustPrepared = prepared({ deviceTrustToken: 'valid-token' });
    const deps = dependencies({
      prepare: vi.fn().mockResolvedValue(trustPrepared),
      verifyDeviceTrust: vi.fn().mockResolvedValue({ ok: true, ipChanged: true }),
    });

    await createPhoneAttestationHandler(deps)({}, SESSION_ID, REQUESTER_IP);

    expect(deps.verifyDeviceTrust).toHaveBeenCalledWith(
      'valid-token',
      REQUESTER_IP,
      'phone-public-key'
    );
    expect(deps.verifyProof).toHaveBeenCalledWith(expect.objectContaining({ trustRedeemed: true }));
    expect(deps.mintDeviceTrust).not.toHaveBeenCalled();
    expect(deps.commit).toHaveBeenCalledWith(
      expect.objectContaining({
        annotations: expect.objectContaining({
          phone_device_trust_redeemed: true,
          phone_device_trust_ip_changed: true,
        }),
      })
    );
  });

  it('does not mint device trust for a failed integrity verdict', async () => {
    const proxyPhone = merchantProjection({
      ...PHONE_PROJECTION,
      tags: ['proxy'],
    });
    const deps = dependencies({ fetchPhoneProjection: vi.fn().mockResolvedValue(proxyPhone) });

    await createPhoneAttestationHandler(deps)({}, SESSION_ID, REQUESTER_IP);

    expect(deps.mintDeviceTrust).not.toHaveBeenCalled();
    expect(deps.commit).toHaveBeenCalledWith(
      expect.objectContaining({ verdict: 'failed', reason: 'phone_on_proxy' })
    );
  });
});

describe('phone-attestation commit outcomes', () => {
  it.each([
    [
      'same_device_retry',
      200,
      { verdict: 'complete', reason: null, annotations: {}, concurrent_loser: true },
    ],
    [
      'other_device',
      409,
      {
        error: 'session_paired_with_other_device',
        reason: 'This QR code is already paired with a different device.',
      },
    ],
    ['write_conflict', 409, { error: 'write_conflict' }],
  ] as const)('maps %s without disclosing a new verdict', async (outcome, status, expectedBody) => {
    const deps = dependencies({ commit: vi.fn().mockResolvedValue({ outcome }) });

    const response = await createPhoneAttestationHandler(deps)({}, SESSION_ID, REQUESTER_IP);
    expect(response.statusCode).toBe(status);
    expect(bodyOf(response)).toEqual(expectedBody);
    expect(deps.deliverVerdict).not.toHaveBeenCalled();
  });
});
