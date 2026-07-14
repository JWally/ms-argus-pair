import { describe, expect, it, vi } from 'vitest';
import { createVerdictTokenMintHandler } from '../cdk/lib/pair-api/verdict-token-mint-route';

const session = {
  cpi: 'argus_cpi_test',
  challengeId: 'checkout_1234567890abcdef',
  verdict: 'failed' as const,
  verdictReason: 'blocked',
  phoneAttestation: { receivedAt: 100 },
};

function handler(released: boolean) {
  return createVerdictTokenMintHandler({
    loadSession: vi.fn().mockResolvedValue(session),
    verifyParticipant: vi.fn().mockResolvedValue({ sessionId: 'session-a' }),
    isReleased: vi.fn().mockResolvedValue(released),
    getSecret: vi.fn().mockResolvedValue('secret'),
    now: () => 101,
  });
}

describe('verdict token mint reveal gate', () => {
  it('looks pending and withholds the signed token before Done', async () => {
    const response = await handler(false)({ queryStringParameters: { t: 'token' } }, 'session-a');
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body)).toEqual({ error: 'verdict_pending' });
  });

  it('mints the authentic failed verdict only after release', async () => {
    const response = await handler(true)({ queryStringParameters: { t: 'token' } }, 'session-a');
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toHaveProperty('token');
  });
});
