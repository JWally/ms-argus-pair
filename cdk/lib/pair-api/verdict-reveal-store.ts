import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

export interface VerdictRevealState {
  challenge: boolean;
  phoneDone: boolean;
}

export const VERDICT_REVEAL_CAP_SECONDS = 90;

function key(sessionId: string) {
  return { PK: `REVEAL#${sessionId}`, SK: 'STATE' };
}

function normalize(item: Record<string, unknown> | undefined): VerdictRevealState | null {
  if (!item) return null;
  return {
    challenge: item.challenge === true,
    phoneDone: item.phoneDone === true,
  };
}

export async function markPhoneChallenge(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  sessionId: string,
  challenge: boolean,
  expiresAt: number
): Promise<VerdictRevealState> {
  const result = await ddb.send(
    new UpdateCommand({
      TableName: tableName,
      Key: key(sessionId),
      UpdateExpression:
        'SET challenge = :challenge, phoneDone = if_not_exists(phoneDone, :notDone), expiresAt = :expiresAt',
      ExpressionAttributeValues: {
        ':challenge': challenge,
        ':notDone': false,
        ':expiresAt': expiresAt,
      },
      ReturnValues: 'ALL_NEW',
    })
  );
  return normalize(result.Attributes) ?? { challenge, phoneDone: false };
}

export async function markPhoneDone(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  sessionId: string,
  expiresAt: number
): Promise<VerdictRevealState> {
  const result = await ddb.send(
    new UpdateCommand({
      TableName: tableName,
      Key: key(sessionId),
      UpdateExpression:
        'SET phoneDone = :done, challenge = if_not_exists(challenge, :challenge), expiresAt = :expiresAt',
      ExpressionAttributeValues: {
        ':done': true,
        ':challenge': true,
        ':expiresAt': expiresAt,
      },
      ReturnValues: 'ALL_NEW',
    })
  );
  return normalize(result.Attributes) ?? { challenge: true, phoneDone: true };
}

export async function loadVerdictRevealState(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  sessionId: string
): Promise<VerdictRevealState | null> {
  const result = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: key(sessionId),
      ConsistentRead: true,
    })
  );
  return normalize(result.Item);
}

export function shouldReleaseVerdict(
  state: VerdictRevealState | null,
  decidedAt: number,
  now: number
): boolean {
  if (!state?.challenge || state.phoneDone) return true;
  return now >= decidedAt + VERDICT_REVEAL_CAP_SECONDS;
}
