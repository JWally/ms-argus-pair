import { parseMerchantChallenge } from './merchant-challenge';
import { parseScopedCpi } from './scoped-cpi';
import { verifyVerdictForContext } from './verdict-token';
import { jsonResp } from './shared/http';

type ApiResponse = ReturnType<typeof jsonResp>;

export function createVerdictVerificationHandler(deps: {
  getSecret: () => Promise<string | null>;
}): (body: Record<string, unknown>) => Promise<ApiResponse> {
  return async (body) => {
    const token = body.token;
    if (typeof token !== 'string') return jsonResp(400, { error: 'missing_token' });
    if (body.cpi === undefined) return jsonResp(400, { error: 'missing_cpi' });
    const expectedCpi = parseScopedCpi(body.cpi);
    if (!expectedCpi) return jsonResp(400, { error: 'invalid_cpi' });
    if (body.challengeId === undefined) {
      return jsonResp(400, { error: 'missing_challenge_id' });
    }
    const challengeId = parseMerchantChallenge(body.challengeId);
    if (!challengeId) return jsonResp(400, { error: 'invalid_challenge_id' });

    const secret = await deps.getSecret();
    if (!secret) return jsonResp(503, { error: 'verdict_signing_unconfigured' });
    const result = verifyVerdictForContext(secret, token, {
      cpi: expectedCpi.cpi,
      challengeId,
    });
    if (!result.ok) return jsonResp(200, { valid: false, reason: result.reason });
    return jsonResp(200, {
      valid: true,
      passed: result.claims.verdict === 'paired',
      cpi: result.claims.cpi,
      challengeId: result.claims.challengeId,
      sessionId: result.claims.sessionId,
      verdict: result.claims.verdict,
      reason: result.claims.reason,
      iat: result.claims.iat,
      exp: result.claims.exp,
    });
  };
}
