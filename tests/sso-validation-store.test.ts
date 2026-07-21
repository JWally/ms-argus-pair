import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it, vi } from 'vitest';
import { storeSsoValidation } from '../cdk/lib/pair-api/sso-validation-store.ts';

const validateProfile = {
  argusSessionId: 'argus-session-validate',
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

function dependencies() {
  const send = vi.fn().mockResolvedValue({});
  return {
    send,
    deps: { ddb: { send } as unknown as DynamoDBDocumentClient, tableName: 'pair-table' },
  };
}

describe('SSO validation DynamoDB adapter', () => {
  it('conditionally stores approval state for a successful verdict', async () => {
    const { send, deps } = dependencies();

    await storeSsoValidation(
      {
        sessionId: 'be958437-c025-4c39-8a9f-bb9c72f2fdf9',
        validateProfile,
        verdict: 'approved',
        verdictReason: 'approved',
        returnCodeConsumedAt: 1_900_000_000,
        proofAnnotations: { phone_webauthn_attested: true },
        approval: {
          approvedAt: 1_900_000_000,
          approvalTokenHash: 'hashed-approval',
          expiresAt: 1_900_000_600,
        },
      },
      deps
    );

    expect(send.mock.calls[0]?.[0].input).toEqual({
      TableName: 'pair-table',
      Key: { PK: 'SSO#be958437-c025-4c39-8a9f-bb9c72f2fdf9', SK: 'META' },
      UpdateExpression:
        'SET validateProfile = :v, verdict = :verdict, verdictReason = :reason, returnCodeConsumedAt = :now, proofAnnotations = :proof, approvedAt = :approvedAt, approvalTokenHash = :approvalTokenHash, expiresAt = :approvalExpiresAt',
      ConditionExpression: 'attribute_exists(PK) AND attribute_not_exists(returnCodeConsumedAt)',
      ExpressionAttributeValues: {
        ':v': validateProfile,
        ':verdict': 'approved',
        ':reason': 'approved',
        ':now': 1_900_000_000,
        ':proof': { phone_webauthn_attested: true },
        ':approvedAt': 1_900_000_000,
        ':approvalTokenHash': 'hashed-approval',
        ':approvalExpiresAt': 1_900_000_600,
      },
    });
  });

  it('stores a failed verdict without approval fields', async () => {
    const { send, deps } = dependencies();

    await storeSsoValidation(
      {
        sessionId: 'be958437-c025-4c39-8a9f-bb9c72f2fdf9',
        validateProfile,
        verdict: 'failed',
        verdictReason: 'device_changed',
        returnCodeConsumedAt: 1_900_000_000,
        proofAnnotations: { phone_webauthn_attested: true },
      },
      deps
    );

    const input = send.mock.calls[0]?.[0].input;
    expect(input.UpdateExpression).not.toContain('approvedAt');
    expect(input.ExpressionAttributeValues).toEqual({
      ':v': validateProfile,
      ':verdict': 'failed',
      ':reason': 'device_changed',
      ':now': 1_900_000_000,
      ':proof': { phone_webauthn_attested: true },
    });
  });
});
