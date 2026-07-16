import { GetCommand, PutCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

export const ARGUS_SESSION_CLAIM_TTL_SECONDS = 24 * 60 * 60;

export type ArgusSessionClaimRole = 'host' | 'desktop' | 'phone';

export interface ArgusSessionClaimInput {
  argusSessionId: string;
  pairSessionId: string;
  role: ArgusSessionClaimRole;
}

interface ArgusSessionClaimDependencies {
  ddb: DynamoDBDocumentClient;
  tableName: string;
  nowEpochSeconds?: number;
}

export type ArgusSessionClaimResult = { ok: true } | { ok: false; reason: 'already_claimed' };

export async function claimArgusSessionIdDdb(
  input: ArgusSessionClaimInput,
  dependencies: ArgusSessionClaimDependencies
): Promise<ArgusSessionClaimResult> {
  const now = dependencies.nowEpochSeconds ?? Math.floor(Date.now() / 1000);
  const key = { PK: `ARGUSSID#${input.argusSessionId}`, SK: 'CLAIM' };

  try {
    await dependencies.ddb.send(
      new PutCommand({
        TableName: dependencies.tableName,
        Item: {
          ...key,
          claimedBy: input.pairSessionId,
          role: input.role,
          claimedAt: now,
          expiresAt: now + ARGUS_SESSION_CLAIM_TTL_SECONDS,
        },
        ConditionExpression: 'attribute_not_exists(PK)',
      })
    );
    return { ok: true };
  } catch (error: unknown) {
    if ((error as { name?: string })?.name !== 'ConditionalCheckFailedException') throw error;
  }

  // A failed silent trust redemption retries the same scan with fresh proof.
  // Preserve that same-session retry while rejecting cross-session recycling.
  const existing = await dependencies.ddb.send(
    new GetCommand({ TableName: dependencies.tableName, Key: key })
  );
  if (existing.Item?.claimedBy === input.pairSessionId && existing.Item?.role === input.role) {
    return { ok: true };
  }
  return { ok: false, reason: 'already_claimed' };
}
