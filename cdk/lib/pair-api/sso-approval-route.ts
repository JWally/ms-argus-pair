import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { jsonResp } from './shared/http';
import { parseScopedCpi } from './scoped-cpi';
import { checkApprovalRedemption, clearApprovalCookie, readApprovalCookie } from './sso-approval';
import { consumeSsoApproval } from './sso-approval-consume';

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

    const consumed = await consumeSsoApproval(
      deps.ddb,
      deps.tableName,
      { sessionId, cpi: expectedCpi.cpi, token: approvalToken },
      deps.now?.()
    );
    if (!consumed) {
      return jsonResp(409, { error: 'sso_approval_invalid_or_consumed' });
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
