import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareAndStoreStartedSession } from '../cdk/lib/pair-api/session-start-store.ts';

const previousValkeyFlag = process.env.USE_VALKEY_SESSIONS;
afterEach(() => {
  if (previousValkeyFlag === undefined) delete process.env.USE_VALKEY_SESSIONS;
  else process.env.USE_VALKEY_SESSIONS = previousValkeyFlag;
});

const baseSession = {
  id: '4f4cf495-a98b-4b76-9099-8ad59dc85ccb',
  nonce: 'pair_nonce_123456789',
  expiresAt: 1_900_000_000,
  challengeId: 'checkout_action_123456789',
  cpi: 'argus_cpi_live_Example12345.forceauth',
  proofRequired: true,
  freshProofRequired: true,
};

function ddbMock() {
  return { send: vi.fn().mockResolvedValue({}) };
}

describe('prepareAndStoreStartedSession', () => {
  it('stores a direct session without host evidence', async () => {
    delete process.env.USE_VALKEY_SESSIONS;
    const ddb = ddbMock();
    const result = await prepareAndStoreStartedSession(
      { ...baseSession, hostPreflightRequired: false, hostOrigin: undefined },
      { ddb: ddb as unknown as DynamoDBDocumentClient, tableName: 'pair-table' }
    );

    expect(result).toEqual({ ok: true });
    expect(ddb.send).toHaveBeenCalledOnce();
    expect(ddb.send.mock.calls[0]?.[0].input.Item).not.toHaveProperty('hostAttestation');
  });

  it('stores the host requirement without awaiting host evidence', async () => {
    delete process.env.USE_VALKEY_SESSIONS;
    const ddb = ddbMock();

    const result = await prepareAndStoreStartedSession(
      {
        ...baseSession,
        hostPreflightRequired: true,
        hostOrigin: 'https://merchant.example',
      },
      { ddb: ddb as unknown as DynamoDBDocumentClient, tableName: 'pair-table' }
    );

    expect(result).toEqual({ ok: true });
    expect(ddb.send.mock.calls[0]?.[0].input.Item).toMatchObject({
      challengeId: baseSession.challengeId,
      hostPreflightRequired: true,
      hostOrigin: 'https://merchant.example',
    });
    expect(ddb.send.mock.calls[0]?.[0].input.Item).not.toHaveProperty('hostAttestation');
  });

  it('fails before persistence when required host evidence has no CPI binding', async () => {
    delete process.env.USE_VALKEY_SESSIONS;
    const ddb = ddbMock();
    const result = await prepareAndStoreStartedSession(
      {
        ...baseSession,
        cpi: null,
        hostPreflightRequired: true,
        hostOrigin: 'https://merchant.example',
      },
      { ddb: ddb as unknown as DynamoDBDocumentClient, tableName: 'pair-table' }
    );

    expect(result).toEqual({
      ok: false,
      status: 400,
      body: { error: 'host_preflight_requires_cpi' },
    });
    expect(ddb.send).not.toHaveBeenCalled();
  });

  it('rejects an invalid required merchant origin before persistence', async () => {
    delete process.env.USE_VALKEY_SESSIONS;
    const ddb = ddbMock();
    const result = await prepareAndStoreStartedSession(
      { ...baseSession, hostPreflightRequired: true, hostOrigin: 'https://merchant.example/path' },
      { ddb: ddb as unknown as DynamoDBDocumentClient, tableName: 'pair-table' }
    );

    expect(result).toEqual({
      ok: false,
      status: 400,
      body: { error: 'host_preflight_origin_invalid' },
    });
    expect(ddb.send).not.toHaveBeenCalled();
  });
});
