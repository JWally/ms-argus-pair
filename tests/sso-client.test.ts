import { describe, expect, it, vi } from 'vitest';
import {
  createSsoClient,
  type SsoClientDependencies,
  type SsoValidateResult,
} from '../src/lib/sso-client';
import { HttpError } from '../src/lib/json-http';

const attestedLeg = {
  argusSessionId: 'argus-session',
  attestation: {
    envelope: 'envelope',
    signature: 'signature',
    publicKey: 'public-key',
    keyId: 'key-id',
  },
};

const approvedResult: SsoValidateResult = {
  verdict: 'approved',
  reason: 'approved',
  reasons: [],
  merchantSessionId: 'merchant-session',
  cpi: 'merchant-cpi.stepup',
};

function requestBody(request: ReturnType<typeof vi.fn>, call = 0): Record<string, unknown> {
  const init = request.mock.calls.at(call)?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

function harness(response: unknown = approvedResult) {
  const runAttestedScan = vi.fn(async () => attestedLeg);
  const request = vi.fn(async () => response);
  const authenticatePasskey = vi.fn(async () => ({ id: 'authenticated-credential' }));
  const createPasskey = vi.fn(async () => ({ id: 'created-credential' }));
  const rememberPasskeyCredential = vi.fn();
  const saveTrustToken = vi.fn(async () => undefined);
  const dependencies: SsoClientDependencies = {
    defaultCpi: 'merchant-cpi.fastpass',
    runAttestedScan,
    request: request as SsoClientDependencies['request'],
    runStage: async (_stage, _event, _sessionId, operation) => operation(),
    authenticatePasskey,
    createPasskey,
    rememberPasskeyCredential,
    saveTrustToken,
  };
  return {
    client: createSsoClient(dependencies),
    runAttestedScan,
    request,
    authenticatePasskey,
    createPasskey,
    rememberPasskeyCredential,
    saveTrustToken,
  };
}

describe('SSO browser client', () => {
  it('starts a merchant-bound session with the exact scoped CPI in the signed leg', async () => {
    const startResponse = {
      sessionId: 'sso-session',
      nonce: 'nonce',
      expiresAt: 123,
      cpi: 'merchant-cpi.forceauth',
      proofRequired: true,
      freshProofRequired: true,
      challengeUrl: '/sso/challenge/sso-session',
      failureReturnUrl: 'https://merchant.example/failure',
    };
    const { client, runAttestedScan, request } = harness(startResponse);

    expect(client.defaultCpi()).toBe('merchant-cpi.stepup');
    await expect(
      client.startSession('merchant-session', 'merchant-cpi.forceauth', {
        challengeId: 'challenge-id',
        callbackUrl: 'https://merchant.example/callback',
      })
    ).resolves.toEqual(startResponse);

    expect(runAttestedScan).toHaveBeenCalledWith({
      cpi: 'merchant-cpi',
      payload: {
        role: 'merchant-start',
        merchantSessionId: 'merchant-session',
        cpi: 'merchant-cpi.forceauth',
      },
    });
    expect(request.mock.calls.at(0)?.[0]).toBe('/api/sso/start');
    expect(requestBody(request)).toEqual({
      merchantSessionId: 'merchant-session',
      cpi: 'merchant-cpi.forceauth',
      merchantChallengeId: 'challenge-id',
      merchantCallbackUrl: 'https://merchant.example/callback',
      ...attestedLeg,
    });
  });

  it('submits the Argus-hosted challenge through an encoded session route', async () => {
    const challengeResponse = {
      ok: true as const,
      returnCode: 'return-code',
      returnUrl: '/merchant/validate',
    };
    const { client, runAttestedScan, request } = harness(challengeResponse);

    await expect(
      client.submitChallenge('session/with/slash', 'nonce', 'merchant-cpi.stepup')
    ).resolves.toEqual(challengeResponse);

    expect(runAttestedScan).toHaveBeenCalledWith({
      cpi: 'merchant-cpi',
      payload: {
        role: 'argus-challenge',
        ssoSessionId: 'session/with/slash',
        nonce: 'nonce',
        cpi: 'merchant-cpi.stepup',
      },
    });
    const expectedRoute = `/api/sso/${encodeURIComponent('session/with/slash')}/challenge`;
    expect(request.mock.calls.at(0)?.[0]).toBe(expectedRoute);
    expect(requestBody(request)).toEqual(attestedLeg);
  });

  it('keeps fastpass validation integrity-only and persists returned trust', async () => {
    const { client, request, authenticatePasskey, createPasskey, saveTrustToken } = harness({
      ...approvedResult,
      nextDeviceTrust: 'next-trust',
    });

    await client.validateReturn({
      sessionId: 'sso-session',
      nonce: 'nonce',
      returnCode: 'return-code',
      cpi: 'merchant-cpi.fastpass',
      mode: 'integrity-only',
    });

    expect(authenticatePasskey).not.toHaveBeenCalled();
    expect(createPasskey).not.toHaveBeenCalled();
    expect(requestBody(request)).toEqual({ returnCode: 'return-code', ...attestedLeg });
    expect(saveTrustToken).toHaveBeenCalledWith('next-trust');
  });

  it('sends only the selected device-trust or OAuth proof', async () => {
    const deviceTrust = harness();
    await deviceTrust.client.validateReturn({
      sessionId: 'sso-session',
      nonce: 'nonce',
      returnCode: 'return-code',
      cpi: 'merchant-cpi.stepup',
      mode: 'device-trust',
      deviceTrustToken: 'trust-token',
    });
    expect(requestBody(deviceTrust.request)).toEqual({
      returnCode: 'return-code',
      ...attestedLeg,
      deviceTrustToken: 'trust-token',
    });

    const oauth = harness();
    await oauth.client.validateReturn({
      sessionId: 'sso-session',
      nonce: 'nonce',
      returnCode: 'return-code',
      cpi: 'merchant-cpi.forceauth',
      mode: 'oauth',
      oauthResult: { provider: 'google', token: 'google-token' },
    });
    expect(requestBody(oauth.request)).toEqual({
      returnCode: 'return-code',
      ...attestedLeg,
      oauth: { provider: 'google', token: 'google-token' },
    });
  });

  it('runs passkey creation concurrently and remembers it only after approval', async () => {
    let releaseLeg!: () => void;
    let releasePasskey!: () => void;
    const legReady = new Promise<typeof attestedLeg>((resolve) => {
      releaseLeg = () => resolve(attestedLeg);
    });
    const passkeyReady = new Promise<{ id: string }>((resolve) => {
      releasePasskey = () => resolve({ id: 'new-credential' });
    });
    const setup = harness();
    setup.runAttestedScan.mockReturnValueOnce(legReady);
    setup.createPasskey.mockReturnValueOnce(passkeyReady);

    const pending = setup.client.validateReturn({
      sessionId: 'sso-session',
      nonce: 'nonce',
      returnCode: 'return-code',
      cpi: 'merchant-cpi.stepup',
      mode: 'passkey-create',
    });
    expect(setup.runAttestedScan).toHaveBeenCalledOnce();
    expect(setup.createPasskey).toHaveBeenCalledWith('nonce');

    releasePasskey();
    releaseLeg();
    await pending;

    expect(requestBody(setup.request)).toEqual({
      returnCode: 'return-code',
      ...attestedLeg,
      webauthn: { id: 'new-credential' },
    });
    expect(setup.rememberPasskeyCredential).toHaveBeenCalledWith('new-credential');

    const defaultMode = harness();
    await defaultMode.client.validateReturn({
      sessionId: 'sso-session',
      nonce: 'nonce',
      returnCode: 'return-code',
      cpi: 'merchant-cpi.stepup',
    });
    expect(defaultMode.createPasskey).toHaveBeenCalledWith('nonce');
    expect(defaultMode.rememberPasskeyCredential).toHaveBeenCalledWith('created-credential');
  });

  it('turns a rejected passkey ceremony into proof evidence without hiding scan failure', async () => {
    const passkeyFailure = harness();
    passkeyFailure.authenticatePasskey.mockRejectedValueOnce(new Error('user cancelled'));
    await passkeyFailure.client.validateReturn({
      sessionId: 'sso-session',
      nonce: 'nonce',
      returnCode: 'return-code',
      cpi: 'merchant-cpi.stepup',
      mode: 'passkey-auth',
    });
    expect(requestBody(passkeyFailure.request)).toMatchObject({
      webauthn: { error: 'user cancelled' },
    });

    const scanFailure = harness();
    scanFailure.runAttestedScan.mockRejectedValueOnce(new Error('scan unavailable'));
    await expect(
      scanFailure.client.validateReturn({
        sessionId: 'sso-session',
        nonce: 'nonce',
        returnCode: 'return-code',
        cpi: 'merchant-cpi.stepup',
        mode: 'passkey-create',
      })
    ).rejects.toThrow('scan unavailable');
    expect(scanFailure.request).not.toHaveBeenCalled();
  });

  it('returns a structured failed verdict from the expected 403 response', async () => {
    const failedResult: SsoValidateResult = {
      verdict: 'failed',
      reason: 'credential_not_registered',
      reasons: ['credential_not_registered'],
      merchantSessionId: 'merchant-session',
      cpi: 'merchant-cpi.stepup',
    };
    const setup = harness();
    setup.request.mockRejectedValueOnce(
      new HttpError(403, JSON.stringify(failedResult), failedResult)
    );

    await expect(
      setup.client.validateReturn({
        sessionId: 'sso-session',
        nonce: 'nonce',
        returnCode: 'return-code',
        cpi: 'merchant-cpi.stepup',
        mode: 'passkey-auth',
      })
    ).resolves.toEqual(failedResult);
    expect(setup.rememberPasskeyCredential).not.toHaveBeenCalled();

    const unexpected = harness();
    const unauthorized = new HttpError(401, 'unauthorized', null);
    unexpected.request.mockRejectedValueOnce(unauthorized);
    await expect(
      unexpected.client.validateReturn({
        sessionId: 'sso-session',
        nonce: 'nonce',
        returnCode: 'return-code',
        cpi: 'merchant-cpi.stepup',
        mode: 'device-trust',
      })
    ).rejects.toBe(unauthorized);
  });

  it('redeems approval with the merchant expected CPI and same-origin credentials', async () => {
    const redeemed = {
      verdict: 'approved' as const,
      reason: 'approved' as const,
      cpi: 'merchant-cpi.stepup',
      scope: 'sso',
    };
    const { client, request } = harness(redeemed);

    await expect(client.redeemApproval('sso-session', 'merchant-cpi.stepup')).resolves.toEqual(
      redeemed
    );
    expect(request).toHaveBeenCalledWith('/api/sso/approval/redeem', {
      method: 'POST',
      credentials: 'same-origin',
      body: JSON.stringify({ sessionId: 'sso-session', cpi: 'merchant-cpi.stepup' }),
    });
  });
});
