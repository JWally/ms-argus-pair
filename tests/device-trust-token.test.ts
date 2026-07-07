import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@aws-sdk/client-secrets-manager', () => ({
  GetSecretValueCommand: class {
    constructor(public readonly input: unknown) {}
  },
  SecretsManagerClient: class {
    async send() {
      return { SecretString: 'test-device-trust-secret' };
    }
  },
}));

async function trustModule() {
  vi.resetModules();
  vi.stubEnv('DEVICE_TRUST_SECRET_ARN', 'arn:test');
  return import('../cdk/lib/pair-api/attestation/trust.ts');
}

describe('device trust token', () => {
  beforeEach(() => {
    vi.stubEnv('DEVICE_TRUST_SECRET_ARN', '');
  });

  it('redeems across IP changes while surfacing ipChanged telemetry', async () => {
    const { mintDeviceTrust, verifyDeviceTrust } = await trustModule();
    const token = await mintDeviceTrust('phone-public-key', 'phone-key-id', '203.0.113.10');

    expect(token).toBeTruthy();
    await expect(verifyDeviceTrust(token!, '198.51.100.20', 'phone-public-key')).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        ipChanged: true,
      })
    );
  });

  it('still rejects a token for a different phone public key', async () => {
    const { mintDeviceTrust, verifyDeviceTrust } = await trustModule();
    const token = await mintDeviceTrust('phone-public-key', 'phone-key-id', '203.0.113.10');

    await expect(verifyDeviceTrust(token!, '203.0.113.10', 'other-public-key')).resolves.toEqual({
      ok: false,
      reason: 'pubkey_mismatch',
    });
  });
});
