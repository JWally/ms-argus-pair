import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { checkApprovalRedemption } from './sso-approval';
import { consumeSsoApproval } from './sso-approval-consume';
import { parseMerchantChallenge } from './merchant-challenge';
import { jsonResp } from './shared/http';
import { parseScopedCpi } from './scoped-cpi';

interface MerchantApprovalSession {
  verdict: 'pending' | 'approved' | 'failed';
  merchantSessionId: string;
  cpi?: string;
  merchantChallengeId?: string;
  merchantCallbackUrl?: string;
  approvalTokenHash?: string;
  approvalRedeemedAt?: number;
}

interface MerchantApprovalDeps {
  ddb: DynamoDBDocumentClient;
  tableName: string;
  loadSession: (sessionId: string) => Promise<MerchantApprovalSession | null>;
  now?: () => number;
}

export function createSsoMerchantApprovalHandler(deps: MerchantApprovalDeps) {
  return async (body: Record<string, unknown>) => {
    const sessionId =
      typeof body.sessionId === 'string' && body.sessionId.length <= 128 ? body.sessionId : '';
    const code = typeof body.code === 'string' && body.code.length <= 256 ? body.code : '';
    const challengeId = parseMerchantChallenge(body.challengeId);
    const expectedCpi = parseScopedCpi(body.cpi);
    if (!sessionId || !code || !challengeId || !expectedCpi) {
      return jsonResp(400, { error: 'sso_approval_binding_required' });
    }

    const session = await deps.loadSession(sessionId);
    if (!session) return jsonResp(410, { error: 'sso_session_not_found' });
    if (!session.merchantCallbackUrl || !session.merchantChallengeId) {
      return jsonResp(409, { error: 'sso_approval_not_merchant_bound' });
    }
    if (session.merchantChallengeId !== challengeId) {
      return jsonResp(409, { error: 'sso_approval_challenge_mismatch' });
    }
    const approvalCheck = checkApprovalRedemption(session, code, expectedCpi.cpi);
    if (approvalCheck !== 'approved') {
      return jsonResp(409, { error: `sso_approval_${approvalCheck}` });
    }

    const consumed = await consumeSsoApproval(
      deps.ddb,
      deps.tableName,
      { sessionId, cpi: expectedCpi.cpi, token: code, challengeId },
      deps.now?.()
    );
    if (!consumed) {
      return jsonResp(409, { error: 'sso_approval_invalid_or_consumed' });
    }

    return jsonResp(200, {
      valid: true,
      passed: true,
      verdict: 'approved',
      reason: 'approved',
      merchantSessionId: session.merchantSessionId,
      cpi: expectedCpi.cpi,
      scope: expectedCpi.scope,
      challengeId,
    });
  };
}
