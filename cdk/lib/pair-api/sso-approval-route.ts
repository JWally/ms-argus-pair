import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { jsonResp } from './shared/http';
import { parseScopedCpi } from './scoped-cpi';
import {
  checkApprovalRedemption,
  clearApprovalCookie,
  hashApprovalToken,
  readApprovalCookie,
} from './sso-approval';

interface ApprovalSession {
  verdict: 'pending' | 'approved' | 'failed';
  cpi?: string;
  approvalTokenHash?: string;
  approvalRedeemedAt?: number;
}

interface ApprovalRouteDeps {
  ddb: DynamoDBDocumentClient;
  tableName: string;
  loadSession: (sessionId: string) => Promise<ApprovalSession | null>;
  now?: () => number;
}

export function createSsoApprovalRedemptionHandler(deps: ApprovalRouteDeps) {
  return async (body: Record<string, unknown>, cookies: string[] | undefined) => {
    const sessionId =
      typeof body.sessionId === 'string' && body.sessionId.length <= 128 ? body.sessionId : '';
    const rawCpi = body.cpi;
    if (rawCpi === undefined) return jsonResp(400, { error: 'missing_cpi' });
    const expectedCpi = parseScopedCpi(rawCpi);
    if (!expectedCpi) return jsonResp(400, { error: 'invalid_cpi' });
    const approvalToken = readApprovalCookie(cookies);
    if (!sessionId || !approvalToken) return jsonResp(401, { error: 'sso_approval_missing' });

    const approvalSession = await deps.loadSession(sessionId);
    if (!approvalSession) return jsonResp(410, { error: 'sso_session_not_found' });
    const approvalCheck = checkApprovalRedemption(approvalSession, approvalToken, expectedCpi.cpi);
    if (approvalCheck !== 'approved') {
      return jsonResp(409, { error: `sso_approval_${approvalCheck}` });
    }

    try {
      await deps.ddb.send(
        new UpdateCommand({
          TableName: deps.tableName,
          Key: { PK: `SSO#${sessionId}`, SK: 'META' },
          UpdateExpression: 'SET approvalRedeemedAt = :now REMOVE approvalTokenHash',
          ConditionExpression:
            'attribute_exists(PK) AND verdict = :approved AND cpi = :cpi AND approvalTokenHash = :hash AND attribute_not_exists(approvalRedeemedAt)',
          ExpressionAttributeValues: {
            ':now': Math.floor((deps.now?.() ?? Date.now()) / 1000),
            ':approved': 'approved',
            ':cpi': expectedCpi.cpi,
            ':hash': hashApprovalToken(approvalToken),
          },
        })
      );
    } catch (error: unknown) {
      if ((error as { name?: string })?.name === 'ConditionalCheckFailedException') {
        return jsonResp(409, { error: 'sso_approval_invalid_or_consumed' });
      }
      throw error;
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      cookies: [clearApprovalCookie()],
      body: JSON.stringify({
        verdict: 'approved',
        reason: 'approved',
        cpi: expectedCpi.cpi,
        scope: expectedCpi.scope,
      }),
    };
  };
}
