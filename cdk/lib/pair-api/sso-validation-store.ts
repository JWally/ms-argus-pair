import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { StoredSsoValidation } from './sso-validation';

export async function storeSsoValidation(
  validation: StoredSsoValidation,
  deps: { ddb: DynamoDBDocumentClient; tableName: string }
): Promise<void> {
  const approvalExpression = validation.approval
    ? ', approvedAt = :approvedAt, approvalTokenHash = :approvalTokenHash, expiresAt = :approvalExpiresAt'
    : '';
  await deps.ddb.send(
    new UpdateCommand({
      TableName: deps.tableName,
      Key: { PK: `SSO#${validation.sessionId}`, SK: 'META' },
      UpdateExpression:
        'SET validateProfile = :v, verdict = :verdict, verdictReason = :reason, returnCodeConsumedAt = :now, proofAnnotations = :proof' +
        approvalExpression,
      ConditionExpression: 'attribute_exists(PK) AND attribute_not_exists(returnCodeConsumedAt)',
      ExpressionAttributeValues: {
        ':v': validation.validateProfile,
        ':verdict': validation.verdict,
        ':reason': validation.verdictReason,
        ':now': validation.returnCodeConsumedAt,
        ':proof': validation.proofAnnotations,
        ...(validation.approval
          ? {
              ':approvedAt': validation.approval.approvedAt,
              ':approvalTokenHash': validation.approval.approvalTokenHash,
              ':approvalExpiresAt': validation.approval.expiresAt,
            }
          : {}),
      },
    })
  );
}
