/**
 * Session result route contract.
 *
 * The desktop poll is only a transport fallback. This server boundary must
 * authenticate the participant before reading state and must never disclose a
 * plaintext verdict while the phone-controlled reveal gate is still closed.
 */
import { describe, expect, it, vi } from 'vitest';
import { createSessionResultHandler } from '../cdk/lib/pair-api/session-result-route';

const EVENT = { queryStringParameters: { t: 'desktop-token' } };
const SESSION_ID = 'session-1';

function completedSession() {
  return {
    verdict: 'failed' as const,
    verdictReason: 'projection_lookup_failed',
    annotations: { phone_projection_present: false },
    phoneAttestation: { receivedAt: 123 },
  };
}

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    authenticateParticipant: vi.fn().mockResolvedValue(true),
    loadSession: vi.fn().mockResolvedValue(completedSession()),
    sealResult: vi.fn().mockResolvedValue({ status: 'sealed', envelope: { ciphertext: 'x' } }),
    nowEpochSeconds: () => 456,
    ...overrides,
  };
}

describe('session result route authorization and pending state', () => {
  it('rejects an unauthenticated participant before loading session state', async () => {
    const deps = dependencies({ authenticateParticipant: vi.fn().mockResolvedValue(false) });
    const response = await createSessionResultHandler(deps)(EVENT, SESSION_ID);

    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body)).toEqual({ error: 'result_unauthorized' });
    expect(deps.loadSession).not.toHaveBeenCalled();
    expect(deps.sealResult).not.toHaveBeenCalled();
  });

  it('returns gone when the authenticated session has expired', async () => {
    const deps = dependencies({ loadSession: vi.fn().mockResolvedValue(null) });
    const response = await createSessionResultHandler(deps)(EVENT, SESSION_ID);

    expect(response.statusCode).toBe(410);
    expect(JSON.parse(response.body)).toEqual({ error: 'session_expired' });
    expect(deps.sealResult).not.toHaveBeenCalled();
  });

  it('returns an empty no-store response while the verdict is pending', async () => {
    const deps = dependencies({
      loadSession: vi.fn().mockResolvedValue({ verdict: 'pending' }),
    });
    const response = await createSessionResultHandler(deps)(EVENT, SESSION_ID);

    expect(response).toEqual({
      statusCode: 204,
      headers: { 'Cache-Control': 'no-store' },
      body: '',
    });
    expect(deps.sealResult).not.toHaveBeenCalled();
  });
});

describe('session result route sealed response', () => {
  it('seals the stored verdict and server-owned decision context', async () => {
    const deps = dependencies();
    const response = await createSessionResultHandler(deps)(EVENT, SESSION_ID);

    expect(deps.authenticateParticipant).toHaveBeenCalledWith(EVENT, SESSION_ID);
    expect(deps.sealResult).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      verdict: 'failed',
      reason: 'projection_lookup_failed',
      annotations: { phone_projection_present: false },
      nextDeviceTrust: null,
      decidedAt: 123,
      now: 456,
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      status: 'sealed',
      envelope: { ciphertext: 'x' },
    });
  });

  it('uses explicit defaults for legacy completed session rows', async () => {
    const deps = dependencies({ loadSession: vi.fn().mockResolvedValue({ verdict: 'paired' }) });
    await createSessionResultHandler(deps)(EVENT, SESSION_ID);

    expect(deps.sealResult).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      verdict: 'paired',
      reason: null,
      annotations: {},
      nextDeviceTrust: null,
      decidedAt: 456,
      now: 456,
    });
  });
});
