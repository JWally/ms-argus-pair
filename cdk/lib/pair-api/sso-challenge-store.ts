import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { StoredSsoChallenge } from './sso-challenge';

export async function storeSsoChallenge(
  challenge: StoredSsoChallenge,
  deps: { ddb: DynamoDBDocumentClient; tableName: string }
): Promise<void> {
  await deps.ddb.send(
    new UpdateCommand({
      TableName: deps.tableName,
      Key: { PK: `SSO#${challenge.sessionId}`, SK: 'META' },
      UpdateExpression: 'SET challengeProfile = :c, returnCodeHash = :h, returnCodeExpiresAt = :e',
      ConditionExpression: 'attribute_exists(PK) AND attribute_not_exists(challengeProfile)',
      ExpressionAttributeValues: {
        ':c': challenge.challengeProfile,
        ':h': challenge.returnCodeHash,
        ':e': challenge.returnCodeExpiresAt,
      },
    })
  );
}
