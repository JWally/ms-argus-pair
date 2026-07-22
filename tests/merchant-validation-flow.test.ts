import { describe, expect, it, vi } from 'vitest';
import { HttpError } from '../src/lib/json-http';
import {
  createMerchantValidationService,
  readMerchantValidationMaterial,
  type MerchantValidationDependencies,
  type MerchantValidationMaterial,
} from '../src/lib/merchant-validation-flow';
import type { SsoValidateResult } from '../src/lib/sso-client';

const material: MerchantValidationMaterial = {
  sessionId: 'sso-session',
  returnCode: 'return-code',
  cpi: 'merchant-cpi.stepup',
  nonce: 'nonce',
};

const approvedResult: SsoValidateResult = {
  verdict: 'approved',
  reason: 'approved',
  reasons: [],
  merchantSessionId: 'merchant-session',
  cpi: 'merchant-cpi.stepup',
};

function harness() {
  const validateReturn = vi.fn(async () => approvedResult);
  const loadTrustToken = vi.fn(async () => null as string | null);
  const clearTrustToken = vi.fn(async () => undefined);
  const hasPasskeyHint = vi.fn(() => false);
  const clearPasskeyHint = vi.fn();
  const runGoogleProof = vi.fn(async () => ({ provider: 'google' as const, token: 'token' }));
  const dependencies: MerchantValidationDependencies = {
    validateReturn,
    loadTrustToken,
    clearTrustToken,
    hasPasskeyHint,
    clearPasskeyHint,
    runGoogleProof,
  };
  return {
    service: createMerchantValidationService(dependencies),
    validateReturn,
    loadTrustToken,
    clearTrustToken,
    hasPasskeyHint,
    clearPasskeyHint,
    runGoogleProof,
  };
}

describe('merchant validation return material', () => {
  it('reads the exact session, return code, CPI, and session-bound nonce', () => {
    const params = new URLSearchParams({
      session: 'sso-session',
      code: 'return-code',
      cpi: 'merchant-cpi.stepup',
    });

    expect(readMerchantValidationMaterial(params, () => 'nonce')).toEqual({
      ok: true,
      material,
    });
  });

  it.each(['session', 'code', 'cpi'])('fails closed when %s is missing', (missing) => {
    const params = new URLSearchParams({
      session: 'sso-session',
      code: 'return-code',
      cpi: 'merchant-cpi.stepup',
    });
    params.delete(missing);

    expect(readMerchantValidationMaterial(params, () => 'nonce')).toEqual({
      ok: false,
      error: 'Missing return material',
    });
  });

  it('fails closed when the session-bound nonce is missing', () => {
    const params = new URLSearchParams({
      session: 'sso-session',
      code: 'return-code',
      cpi: 'merchant-cpi.stepup',
    });

    expect(readMerchantValidationMaterial(params, () => null)).toEqual({
      ok: false,
      error: 'Missing session state',
    });
  });
});

describe('merchant initial validation policy', () => {
  it('runs fastpass with integrity only and never reads cached trust', async () => {
    const setup = harness();

    await expect(
      setup.service.validateInitial({ ...material, cpi: 'merchant-cpi.fastpass' })
    ).resolves.toEqual({ kind: 'validated', result: approvedResult, passkeySeen: false });
    expect(setup.validateReturn).toHaveBeenCalledWith({
      ...material,
      cpi: 'merchant-cpi.fastpass',
      mode: 'integrity-only',
    });
    expect(setup.loadTrustToken).not.toHaveBeenCalled();
  });

  it('requires fresh proof for forceauth without reading cached trust', async () => {
    const setup = harness();
    setup.hasPasskeyHint.mockReturnValue(true);

    await expect(
      setup.service.validateInitial({ ...material, cpi: 'merchant-cpi.forceauth' })
    ).resolves.toEqual({ kind: 'proof-required', passkeySeen: true });
    expect(setup.loadTrustToken).not.toHaveBeenCalled();
    expect(setup.validateReturn).not.toHaveBeenCalled();
  });

  it('requires proof for stepup without trust and validates when trust exists', async () => {
    const withoutTrust = harness();
    await expect(withoutTrust.service.validateInitial(material)).resolves.toEqual({
      kind: 'proof-required',
      passkeySeen: false,
    });
    expect(withoutTrust.validateReturn).not.toHaveBeenCalled();

    const withTrust = harness();
    withTrust.loadTrustToken.mockResolvedValue('trust-token');
    await expect(withTrust.service.validateInitial(material)).resolves.toMatchObject({
      kind: 'validated',
      result: approvedResult,
    });
    expect(withTrust.validateReturn).toHaveBeenCalledWith({
      ...material,
      mode: 'device-trust',
      deviceTrustToken: 'trust-token',
    });
  });

  it('clears rejected trust and returns to explicit proof', async () => {
    const setup = harness();
    setup.loadTrustToken.mockResolvedValue('stale-trust');
    setup.validateReturn.mockRejectedValue(new HttpError(401, 'unauthorized', null));
    setup.hasPasskeyHint.mockReturnValueOnce(false).mockReturnValueOnce(true);

    await expect(setup.service.validateInitial(material)).resolves.toEqual({
      kind: 'proof-required',
      passkeySeen: true,
    });
    expect(setup.clearTrustToken).toHaveBeenCalledOnce();
    expect(setup.hasPasskeyHint).toHaveBeenCalledTimes(2);
  });

  it('surfaces unexpected validation failures without clearing trusted state', async () => {
    const setup = harness();
    const failure = new Error('network unavailable');
    setup.loadTrustToken.mockResolvedValue('trust-token');
    setup.validateReturn.mockRejectedValue(failure);

    await expect(setup.service.validateInitial(material)).rejects.toBe(failure);
    expect(setup.clearTrustToken).not.toHaveBeenCalled();
  });
});

describe('merchant explicit proof validation', () => {
  it('submits a Google proof and keeps provider errors recoverable', async () => {
    const success = harness();
    await expect(success.service.validateProof(material, 'google', false)).resolves.toEqual({
      kind: 'validated',
      result: approvedResult,
      passkeySeen: false,
    });
    expect(success.validateReturn).toHaveBeenCalledWith({
      ...material,
      mode: 'oauth',
      oauthResult: { provider: 'google', token: 'token' },
    });

    const failure = harness();
    failure.runGoogleProof.mockResolvedValue({ provider: 'google', error: 'prompt_blocked' });
    await expect(failure.service.validateProof(material, 'google', false)).resolves.toEqual({
      kind: 'proof-error',
      error: 'prompt_blocked',
      passkeySeen: false,
    });
    expect(failure.validateReturn).not.toHaveBeenCalled();
  });

  it('clears a stale passkey hint when authentication is not registered', async () => {
    const setup = harness();
    setup.validateReturn.mockResolvedValue({
      ...approvedResult,
      verdict: 'failed',
      reason: 'credential_not_registered',
      reasons: ['credential_not_registered'],
    });

    await expect(
      setup.service.validateProof(material, 'passkey-auth', true)
    ).resolves.toMatchObject({
      kind: 'validated',
      passkeySeen: false,
    });
    expect(setup.clearPasskeyHint).toHaveBeenCalledOnce();
  });

  it('maps proof authorization failures to an explicit retry state', async () => {
    const setup = harness();
    setup.validateReturn.mockRejectedValue(new HttpError(401, 'unauthorized', null));

    await expect(setup.service.validateProof(material, 'passkey-create', false)).resolves.toEqual({
      kind: 'proof-error',
      error: 'Proof required',
      passkeySeen: false,
    });
  });

  it.each([
    [new Error('network unavailable'), 'network unavailable'],
    ['provider unavailable', 'provider unavailable'],
  ])('normalizes recoverable proof failure %#', async (failure, expectedError) => {
    const setup = harness();
    setup.validateReturn.mockRejectedValue(failure);

    await expect(setup.service.validateProof(material, 'passkey-create', true)).resolves.toEqual({
      kind: 'proof-error',
      error: expectedError,
      passkeySeen: true,
    });
  });
});
