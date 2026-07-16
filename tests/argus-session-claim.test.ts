import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it, vi } from 'vitest';
import {
  ARGUS_SESSION_CLAIM_TTL_SECONDS,
  claimArgusSessionIdDdb,
} from '../cdk/lib/pair-api/argus-session-claim.ts';

const input = {
  argusSessionId: 'argus-session-id',
  pairSessionId: 'pair-session-id',
  role: 'phone' as const,
};

function ddbMock(...responses: unknown[]) {
  return {
    send: vi.fn().mockImplementation(() => Promise.resolve(responses.shift() ?? {})),
  };
}

describe('claimArgusSessionIdDdb', () => {
  it('stores a new single-use claim with the full replay horizon', async () => {
    const ddb = ddbMock({});

    await expect(
      claimArgusSessionIdDdb(input, {
        ddb: ddb as unknown as DynamoDBDocumentClient,
        tableName: 'pair-table',
        nowEpochSeconds: 1_800_000_000,
      })
    ).resolves.toEqual({ ok: true });

    expect(ddb.send.mock.calls[0]?.[0].input).toMatchObject({
      TableName: 'pair-table',
      Item: {
        PK: 'ARGUSSID#argus-session-id',
        SK: 'CLAIM',
        claimedBy: 'pair-session-id',
        role: 'phone',
        claimedAt: 1_800_000_000,
        expiresAt: 1_800_000_000 + ARGUS_SESSION_CLAIM_TTL_SECONDS,
      },
      ConditionExpression: 'attribute_not_exists(PK)',
    });
  });

  it('accepts an idempotent retry from the same pair session and role', async () => {
    const conflict = Object.assign(new Error('conflict'), {
      name: 'ConditionalCheckFailedException',
    });
    const ddb = ddbMock(Promise.reject(conflict), {
      Item: { claimedBy: 'pair-session-id', role: 'phone' },
    });

    await expect(
      claimArgusSessionIdDdb(input, {
        ddb: ddb as unknown as DynamoDBDocumentClient,
        tableName: 'pair-table',
        nowEpochSeconds: 1_800_000_000,
      })
    ).resolves.toEqual({ ok: true });
  });

  it('rejects reuse by another pair session or role', async () => {
    const conflict = Object.assign(new Error('conflict'), {
      name: 'ConditionalCheckFailedException',
    });
    const ddb = ddbMock(Promise.reject(conflict), {
      Item: { claimedBy: 'another-pair-session', role: 'phone' },
    });

    await expect(
      claimArgusSessionIdDdb(input, {
        ddb: ddb as unknown as DynamoDBDocumentClient,
        tableName: 'pair-table',
        nowEpochSeconds: 1_800_000_000,
      })
    ).resolves.toEqual({ ok: false, reason: 'already_claimed' });
  });

  it('does not hide non-conflict storage errors', async () => {
    const ddb = ddbMock(Promise.reject(new Error('ddb unavailable')));

    await expect(
      claimArgusSessionIdDdb(input, {
        ddb: ddb as unknown as DynamoDBDocumentClient,
        tableName: 'pair-table',
        nowEpochSeconds: 1_800_000_000,
      })
    ).rejects.toThrow('ddb unavailable');
  });
});
