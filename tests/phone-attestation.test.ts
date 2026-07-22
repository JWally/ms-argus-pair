import { describe, expect, it, vi } from 'vitest';
import { HttpError } from '../src/lib/json-http';
import {
  runPhoneAttestation,
  type PhoneAttestationDependencies,
  type PhoneAttestationResponse,
} from '../src/lib/phone-attestation';
import type { PhoneScanResult, PhoneSessionInfo } from '../src/lib/phone-session-runtime';
import type { WsConnection } from '../src/lib/ws';

const SCAN: PhoneScanResult = {
  sessionId: null,
  argusSessionId: 'argus-phone-1',
  durationMs: 12,
  attestation: {
    envelope: 'attestation-envelope',
    signature: 'signature',
    publicKey: 'public-key',
    keyId: 'phone-key-1',
  },
};

function phoneInfo(overrides: Partial<PhoneSessionInfo> = {}): PhoneSessionInfo {
  return {
    nonce: 'nonce-1',
    proofRequired: true,
    freshProofRequired: false,
    expiresAt: 300,
    desktopArgusSessionId: 'argus-desktop-1',
    desktopKeyId: 'desktop-key-1',
    desktopEnvelope: 'desktop-envelope',
    phoneToken: 'phone-token',
    conn: { sessionId: 'session-1' } as WsConnection,
    getVerdictRevealKey: vi.fn(async () => 'reveal-key'),
    getScanPromise: vi.fn(async () => SCAN),
    ...overrides,
  };
}

function dependencies(
  overrides: Partial<PhoneAttestationDependencies> = {}
): PhoneAttestationDependencies {
  return {
    loadTrustToken: vi.fn(async () => null),
    saveTrustToken: vi.fn(async () => {}),
    clearTrustToken: vi.fn(async () => {}),
    authenticatePasskey: vi.fn(async () => ({ id: 'authenticated-credential' })),
    createPasskey: vi.fn(async () => ({ id: 'created-credential' })),
    rememberPasskeyCredential: vi.fn(),
    postAttestation: vi.fn(async () => ({ verdict: 'paired', reason: null })),
    openPhoneState: vi.fn(async () => ({
      kind: 'phone-state',
      verdict: 'paired',
      nextDeviceTrust: 'sealed-next-trust',
    })),
    ...overrides,
  };
}

describe('trusted phone attestation', () => {
  it('redeems existing device trust without opening a passkey ceremony', async () => {
    const deps = dependencies({
      loadTrustToken: vi.fn(async () => 'device-trust'),
      postAttestation: vi.fn(async () => ({
        verdict: 'paired',
        reason: null,
        nextDeviceTrust: 'rotated-trust',
      })),
    });
    const onStatus = vi.fn();

    await expect(
      runPhoneAttestation({ sessionId: 'session-1', info: phoneInfo(), events: { onStatus } }, deps)
    ).resolves.toMatchObject({ verdict: 'paired' });

    expect(deps.postAttestation).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        deviceTrustToken: 'device-trust',
        desktopEnvelope: 'desktop-envelope',
      })
    );
    expect(deps.saveTrustToken).toHaveBeenCalledWith('rotated-trust');
    expect(deps.authenticatePasskey).not.toHaveBeenCalled();
    expect(deps.createPasskey).not.toHaveBeenCalled();
    expect(onStatus).toHaveBeenCalledWith('welcome back — verifying');
  });

  it('fails trust-only mode before scanning when no token exists', async () => {
    const deps = dependencies();
    const info = phoneInfo();

    await expect(
      runPhoneAttestation({ sessionId: 'session-1', info, options: { trustOnly: true } }, deps)
    ).rejects.toThrow('device_trust_unavailable');

    expect(info.getScanPromise).not.toHaveBeenCalled();
    expect(deps.postAttestation).not.toHaveBeenCalled();
  });

  it('clears rejected trust and falls through to fresh proof', async () => {
    const rejected = new HttpError(401, '{}', { error: 'device_trust_rejected' });
    const deps = dependencies({
      loadTrustToken: vi.fn(async () => 'expired-trust'),
      postAttestation: vi
        .fn<
          (sessionId: string, body: Record<string, unknown>) => Promise<PhoneAttestationResponse>
        >()
        .mockRejectedValueOnce(rejected)
        .mockResolvedValueOnce({ verdict: 'paired', reason: null }),
    });
    const onStatus = vi.fn();
    const onError = vi.fn();

    await expect(
      runPhoneAttestation(
        { sessionId: 'session-1', info: phoneInfo(), events: { onStatus, onError } },
        deps
      )
    ).resolves.toMatchObject({ verdict: 'paired' });

    expect(deps.clearTrustToken).toHaveBeenCalledOnce();
    expect(deps.createPasskey).toHaveBeenCalledWith('nonce-1');
    expect(deps.postAttestation).toHaveBeenCalledTimes(2);
    expect(deps.rememberPasskeyCredential).toHaveBeenCalledWith('created-credential');
    expect(onStatus).toHaveBeenCalledWith('trust expired — re-verifying');
    expect(onError).toHaveBeenCalledWith(rejected);
  });

  it('bypasses cached trust when fresh proof is required', async () => {
    const deps = dependencies({ loadTrustToken: vi.fn(async () => 'cached-trust') });

    await runPhoneAttestation(
      { sessionId: 'session-1', info: phoneInfo({ freshProofRequired: true }) },
      deps
    );

    expect(deps.loadTrustToken).not.toHaveBeenCalled();
    expect(deps.createPasskey).toHaveBeenCalledWith('nonce-1');
    expect(deps.postAttestation).toHaveBeenCalledOnce();
    expect(deps.postAttestation).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ deviceTrustToken: expect.anything() })
    );
  });

  it('rethrows rejected trust without opening fresh proof in trust-only mode', async () => {
    const rejected = new HttpError(401, '{}', { error: 'device_trust_rejected' });
    const deps = dependencies({
      loadTrustToken: vi.fn(async () => 'rejected-trust'),
      postAttestation: vi.fn(async () => {
        throw rejected;
      }),
    });

    await expect(
      runPhoneAttestation(
        { sessionId: 'session-1', info: phoneInfo(), options: { trustOnly: true } },
        deps
      )
    ).rejects.toBe(rejected);
    expect(deps.clearTrustToken).toHaveBeenCalledOnce();
    expect(deps.createPasskey).not.toHaveBeenCalled();
  });
});

describe('fresh phone proof', () => {
  it('submits integrity-only evidence without opening WebAuthn', async () => {
    const deps = dependencies();

    await runPhoneAttestation(
      { sessionId: 'session-1', info: phoneInfo(), options: { mode: 'integrity' } },
      deps
    );

    expect(deps.authenticatePasskey).not.toHaveBeenCalled();
    expect(deps.createPasskey).not.toHaveBeenCalled();
    expect(deps.postAttestation).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ webauthn: { error: 'mode_integrity_only' } })
    );
  });

  it('submits OAuth beside integrity evidence without opening WebAuthn', async () => {
    const deps = dependencies();
    const oauth = { provider: 'google' as const, token: 'oauth-token' };

    await runPhoneAttestation(
      { sessionId: 'session-1', info: phoneInfo(), options: { mode: 'oauth', oauthResult: oauth } },
      deps
    );

    expect(deps.authenticatePasskey).not.toHaveBeenCalled();
    expect(deps.createPasskey).not.toHaveBeenCalled();
    expect(deps.postAttestation).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ oauth })
    );
  });

  it('stops before submission when interactive proof fails', async () => {
    const deps = dependencies({
      authenticatePasskey: vi.fn(async () => ({ error: 'credential unavailable' })),
    });

    await expect(
      runPhoneAttestation(
        {
          sessionId: 'session-1',
          info: phoneInfo(),
          options: { mode: 'passkey-auth' },
        },
        deps
      )
    ).rejects.toThrow('credential unavailable');
    expect(deps.postAttestation).not.toHaveBeenCalled();
  });

  it('treats an already-attested retry as decision-blind completion', async () => {
    const deps = dependencies({
      postAttestation: vi.fn(async () => {
        throw new HttpError(409, '{}', { error: 'already_attested' });
      }),
    });

    await expect(
      runPhoneAttestation({ sessionId: 'session-1', info: phoneInfo() }, deps)
    ).resolves.toEqual({ verdict: 'complete', reason: null, annotations: {} });
  });

  it('fails closed on missing integrity evidence and non-retry submission errors', async () => {
    const missingScan = phoneInfo({
      getScanPromise: vi.fn(async () => ({ ...SCAN, attestation: null, attestError: 'missing' })),
    });
    await expect(
      runPhoneAttestation({ sessionId: 'session-1', info: missingScan }, dependencies())
    ).rejects.toThrow('argus attestation failed: missing');

    const unavailable = new HttpError(503, '{}', { error: 'unavailable' });
    await expect(
      runPhoneAttestation(
        { sessionId: 'session-1', info: phoneInfo() },
        dependencies({
          postAttestation: vi.fn(async () => {
            throw unavailable;
          }),
        })
      )
    ).rejects.toBe(unavailable);
  });
});

describe('sealed phone state', () => {
  it('persists trust and a new passkey only after authenticated finalization', async () => {
    const phoneState = { iv: 'iv', ciphertext: 'ciphertext' };
    const deps = dependencies({
      postAttestation: vi.fn(async () => ({
        verdict: 'complete',
        reason: null,
        phoneState,
      })),
    });
    const info = phoneInfo();

    const response = await runPhoneAttestation(
      { sessionId: 'session-1', info, options: { mode: 'passkey-create' } },
      deps
    );
    expect(deps.saveTrustToken).not.toHaveBeenCalled();
    expect(deps.rememberPasskeyCredential).not.toHaveBeenCalled();

    await expect(response.finalizeAfterDone?.()).resolves.toBe('paired');
    await expect(response.finalizeAfterDone?.()).resolves.toBe('paired');

    expect(info.getVerdictRevealKey).toHaveBeenCalledOnce();
    expect(deps.openPhoneState).toHaveBeenCalledOnce();
    expect(deps.saveTrustToken).toHaveBeenCalledWith('sealed-next-trust');
    expect(deps.rememberPasskeyCredential).toHaveBeenCalledWith('created-credential');
  });
});
