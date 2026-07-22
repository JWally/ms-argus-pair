import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it, vi } from 'vitest';
import type { StoredDesktopAttestation } from '../cdk/lib/pair-api/desktop-attest';
import type { StoredHostPreflight } from '../cdk/lib/pair-api/host-preflight';
import { createPairSessionRepository } from '../cdk/lib/pair-api/pair-session-repository';

const SESSION_ID = '4f4cf495-a98b-4b76-9099-8ad59dc85ccb';
const TABLE_NAME = 'pair-table';
type RepositoryDependencies = Parameters<typeof createPairSessionRepository>[0];

function hostAttestation(origin = 'https://merchant.example'): StoredHostPreflight {
  return {
    envelope: 'host-envelope',
    signature: 'host-signature',
    publicKey: 'host-public-key',
    keyId: 'host-key-id',
    argusSessionId: 'host-scan-id',
    receivedAt: 1_900_000_000,
    envelopeDecoded: {
      v: 1,
      purpose: 'argus-pair-v1',
      payload: {},
      iat: 1_900_000_000,
      exp: 1_900_000_300,
      keyId: 'host-key-id',
    },
    origin,
  };
}

function desktopAttestation(
  overrides: Partial<StoredDesktopAttestation> = {}
): StoredDesktopAttestation {
  return {
    envelope: 'desktop-envelope',
    signature: 'desktop-signature',
    publicKey: 'desktop-public-key',
    keyId: 'desktop-key-id',
    argusSessionId: 'desktop-scan-id',
    receivedAt: 1_900_000_000,
    envelopeDecoded: {
      v: 1,
      purpose: 'argus-pair-v1',
      payload: {},
      iat: 1_900_000_000,
      exp: 1_900_000_300,
      keyId: 'desktop-key-id',
    },
    ...overrides,
  };
}

function dependencies(overrides: Partial<RepositoryDependencies> = {}) {
  const send = vi.fn().mockResolvedValue({});
  const loadValkeySession = vi.fn().mockResolvedValue({ meta: null, desktop: null, phone: null });
  const storeDesktopValkey = vi.fn().mockResolvedValue(true);
  const useValkey = vi.fn().mockReturnValue(false);
  return {
    send,
    loadValkeySession,
    storeDesktopValkey,
    useValkey,
    repository: createPairSessionRepository({
      ddb: { send } as unknown as DynamoDBDocumentClient,
      tableName: TABLE_NAME,
      proofRequiredByDefault: true,
      useValkey,
      loadValkeySession,
      storeDesktopValkey,
      ...overrides,
    }),
  };
}

describe('Pair session repository', () => {
  it('returns null when the selected backend has no session', async () => {
    const ddb = dependencies();
    expect(await ddb.repository.loadSession(SESSION_ID)).toBeNull();
    expect(ddb.loadValkeySession).not.toHaveBeenCalled();

    const valkey = dependencies({ useValkey: () => true });
    expect(await valkey.repository.loadSession(SESSION_ID)).toBeNull();
    expect(valkey.send).not.toHaveBeenCalled();
  });

  it('normalizes split Valkey fields into the shared session shape', async () => {
    const host = hostAttestation();
    const desktop = desktopAttestation({ hostAttestation: host });
    const phone = desktopAttestation({ publicKey: 'phone-public-key' });
    const loadValkeySession = vi.fn().mockResolvedValue({
      meta: {
        nonce: 'pair-nonce',
        expiresAt: 1_900_000_300,
        challengeId: 'checkout-action',
        cpi: 'argus-cpi.forceauth',
        hostPreflightRequired: true,
        hostOrigin: 'https://merchant.example',
      },
      desktop,
      phone: {
        att: phone,
        verdict: 'paired',
        reason: 'clean_pair',
        annotations: { assurance: 'fresh' },
      },
    });
    const { repository } = dependencies({ useValkey: () => true, loadValkeySession });

    expect(await repository.loadSession(SESSION_ID)).toEqual({
      PK: `SESSION#${SESSION_ID}`,
      SK: 'META',
      nonce: 'pair-nonce',
      expiresAt: 1_900_000_300,
      challengeId: 'checkout-action',
      cpi: 'argus-cpi.forceauth',
      proofRequired: true,
      freshProofRequired: false,
      hostPreflightRequired: true,
      hostOrigin: 'https://merchant.example',
      hostAttestation: host,
      desktopAttestation: desktop,
      phoneAttestation: phone,
      verdict: 'paired',
      verdictReason: 'clean_pair',
      annotations: { assurance: 'fresh' },
    });
  });

  it('preserves explicit policy flags and legacy Valkey host evidence', async () => {
    const legacyHost = hostAttestation('https://legacy.example');
    const loadValkeySession = vi.fn().mockResolvedValue({
      meta: {
        nonce: 'pair-nonce',
        expiresAt: 1_900_000_300,
        challengeId: 'checkout-action',
        proofRequired: false,
        freshProofRequired: true,
        hostPreflightRequired: false,
        hostAttestation: legacyHost,
      },
      desktop: desktopAttestation(),
      phone: null,
    });
    const { repository } = dependencies({ useValkey: () => true, loadValkeySession });

    expect(await repository.loadSession(SESSION_ID)).toMatchObject({
      proofRequired: false,
      freshProofRequired: true,
      hostPreflightRequired: false,
      hostAttestation: legacyHost,
      verdict: 'pending',
    });
  });

  it('backfills top-level host evidence when reading a legacy DDB row', async () => {
    const host = hostAttestation();
    const item = {
      PK: `SESSION#${SESSION_ID}`,
      SK: 'META',
      nonce: 'pair-nonce',
      expiresAt: 1_900_000_300,
      verdict: 'pending' as const,
      desktopAttestation: desktopAttestation({ hostAttestation: host }),
    };
    const send = vi.fn().mockResolvedValue({ Item: item });
    const { repository } = dependencies({ ddb: { send } as unknown as DynamoDBDocumentClient });

    const loaded = await repository.loadSession(SESSION_ID);
    expect(loaded).toEqual({ ...item, hostAttestation: host });
    expect(item).not.toHaveProperty('hostAttestation');
    expect(send.mock.calls[0]?.[0].input).toEqual({
      TableName: TABLE_NAME,
      Key: { PK: `SESSION#${SESSION_ID}`, SK: 'META' },
    });
  });
});

describe('Pair session repository desktop writes', () => {
  it('delegates desktop writes to Valkey when enabled', async () => {
    const storeDesktopValkey = vi.fn().mockResolvedValue(false);
    const { repository, send } = dependencies({
      useValkey: () => true,
      storeDesktopValkey,
    });
    const stored = desktopAttestation();

    await expect(repository.storeDesktopAttestation(SESSION_ID, stored)).resolves.toBe(false);
    expect(storeDesktopValkey).toHaveBeenCalledWith(SESSION_ID, stored);
    expect(send).not.toHaveBeenCalled();
  });

  it('conditionally claims the DDB desktop slot', async () => {
    const { repository, send } = dependencies();
    const stored = desktopAttestation();

    await expect(repository.storeDesktopAttestation(SESSION_ID, stored)).resolves.toBe(true);
    expect(send.mock.calls[0]?.[0].input).toEqual({
      TableName: TABLE_NAME,
      Key: { PK: `SESSION#${SESSION_ID}`, SK: 'META' },
      UpdateExpression: 'SET desktopAttestation = :d',
      ConditionExpression: 'attribute_exists(PK) AND attribute_not_exists(desktopAttestation)',
      ExpressionAttributeValues: { ':d': stored },
    });
  });

  it('maps a lost DDB desktop race to the repository conflict contract', async () => {
    const conflict = Object.assign(new Error('lost race'), {
      name: 'ConditionalCheckFailedException',
    });
    const send = vi.fn().mockRejectedValue(conflict);
    const { repository } = dependencies({ ddb: { send } as unknown as DynamoDBDocumentClient });

    await expect(
      repository.storeDesktopAttestation(SESSION_ID, desktopAttestation())
    ).resolves.toBe(false);
  });

  it('does not hide unexpected DDB write failures', async () => {
    const failure = new Error('DDB unavailable');
    const send = vi.fn().mockRejectedValue(failure);
    const { repository } = dependencies({ ddb: { send } as unknown as DynamoDBDocumentClient });

    await expect(repository.storeDesktopAttestation(SESSION_ID, desktopAttestation())).rejects.toBe(
      failure
    );
  });
});
