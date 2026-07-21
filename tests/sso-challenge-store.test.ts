import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it, vi } from 'vitest';
import { storeSsoChallenge } from '../cdk/lib/pair-api/sso-challenge-store.ts';

describe('SSO challenge DynamoDB adapter', () => {
  it('atomically stores a profile and hashed return-code state', async () => {
    const send = vi.fn().mockResolvedValue({});
    const challengeProfile = {
      argusSessionId: 'argus-session-challenge',
      keyId: 'key-1',
      ip: '203.0.113.7',
      asnName: 'Argus Mobile',
      country: 'US',
      city: 'Dallas',
      score: 0,
      isPhone: true,
      isProxy: false,
      isDatacenter: false,
      isVpn: false,
    };

    await storeSsoChallenge(
      {
        sessionId: 'be958437-c025-4c39-8a9f-bb9c72f2fdf9',
        challengeProfile,
        returnCodeHash: 'hashed-code',
        returnCodeExpiresAt: 1_900_000_090,
      },
      { ddb: { send } as unknown as DynamoDBDocumentClient, tableName: 'pair-table' }
    );

    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0].input).toEqual({
      TableName: 'pair-table',
      Key: { PK: 'SSO#be958437-c025-4c39-8a9f-bb9c72f2fdf9', SK: 'META' },
      UpdateExpression: 'SET challengeProfile = :c, returnCodeHash = :h, returnCodeExpiresAt = :e',
      ConditionExpression: 'attribute_exists(PK) AND attribute_not_exists(challengeProfile)',
      ExpressionAttributeValues: {
        ':c': challengeProfile,
        ':h': 'hashed-code',
        ':e': 1_900_000_090,
      },
    });
  });
});
