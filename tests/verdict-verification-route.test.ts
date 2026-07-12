import { describe, expect, it, vi } from 'vitest';
import { createVerdictVerificationHandler } from '../cdk/lib/pair-api/verdict-verification-route';
import { signVerdict } from '../cdk/lib/pair-api/verdict-token';

const SECRET = 'test-verdict-secret';
const CPI = 'argus_cpi_live_Example12345.forceauth';
const CHALLENGE_ID = 'checkout_1234567890abcdef';

const token = signVerdict(SECRET, {
  cpi: CPI,
  challengeId: CHALLENGE_ID,
  sessionId: 'session-1',
  verdict: 'paired',
  reason: null,
});

const handler = createVerdictVerificationHandler({
  getSecret: vi.fn().mockResolvedValue(SECRET),
});

describe('verdict verification route', () => {
  it('requires the merchant to assert CPI and challenge', async () => {
    expect(JSON.parse((await handler({ token })).body)).toEqual({ error: 'missing_cpi' });
    expect(JSON.parse((await handler({ token, cpi: CPI })).body)).toEqual({
      error: 'missing_challenge_id',
    });
  });

  it('rejects a token replayed for a different protected action', async () => {
    const response = await handler({
      token,
      cpi: CPI,
      challengeId: 'checkout_A9mK3pQ7vN2xR5tZ',
    });
    expect(JSON.parse(response.body)).toEqual({ valid: false, reason: 'challenge_mismatch' });
  });

  it('returns a passed verdict only for the exact merchant context', async () => {
    const response = await handler({ token, cpi: CPI, challengeId: CHALLENGE_ID });
    expect(JSON.parse(response.body)).toMatchObject({
      valid: true,
      passed: true,
      cpi: CPI,
      challengeId: CHALLENGE_ID,
      sessionId: 'session-1',
    });
  });
});
