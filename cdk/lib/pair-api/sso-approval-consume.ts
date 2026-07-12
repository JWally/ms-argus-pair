import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { hashApprovalToken } from './sso-approval';

interface ConsumeApprovalInput {
  sessionId: string;
  cpi: string;
  token: string;
  challengeId?: string;
}

export async function consumeSsoApproval(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  input: ConsumeApprovalInput,
  now = Date.now()
): Promise<boolean> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { PK: `SSO#${input.sessionId}`, SK: 'META' },
        UpdateExpression: 'SET approvalRedeemedAt = :now REMOVE approvalTokenHash',
        ConditionExpression:
          'attribute_exists(PK) AND verdict = :approved AND cpi = :cpi' +
          (input.challengeId ? ' AND merchantChallengeId = :challengeId' : '') +
          ' AND approvalTokenHash = :hash AND attribute_not_exists(approvalRedeemedAt)',
        ExpressionAttributeValues: {
          ':now': Math.floor(now / 1000),
          ':approved': 'approved',
          ':cpi': input.cpi,
          ...(input.challengeId ? { ':challengeId': input.challengeId } : {}),
          ':hash': hashApprovalToken(input.token),
        },
      })
    );
    return true;
  } catch (error: unknown) {
    if ((error as { name?: string })?.name === 'ConditionalCheckFailedException') return false;
    throw error;
  }
}
