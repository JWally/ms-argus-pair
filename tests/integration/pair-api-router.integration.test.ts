import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPairApiRouter,
  type PairApiEvent,
  type PairApiRouterDependencies,
} from '../../cdk/lib/pair-api/router';
import { jsonResp } from '../../cdk/lib/pair-api/shared/http';

const SESSION_ID = '01234567-89ab-cdef-0123-456789abcdef';

function ok(route: string) {
  return jsonResp(200, { route });
}

function event(routeKey: string, overrides: Partial<PairApiEvent> = {}): PairApiEvent {
  return {
    routeKey,
    body: JSON.stringify({ marker: 'request-body' }),
    headers: { 'cloudfront-viewer-address': '203.0.113.9:443' },
    ...overrides,
  };
}

function dependencies(
  overrides: Partial<PairApiRouterDependencies> = {}
): PairApiRouterDependencies {
  return {
    allowOrigin: vi.fn(() => true),
    handleTelemetry: vi.fn(() => null),
    startPairSession: vi.fn(async () => ok('session-start')),
    startSsoSession: vi.fn(async () => ok('sso-start')),
    challengeSsoSession: vi.fn(async () => ok('sso-challenge')),
    validateSsoSession: vi.fn(async () => ok('sso-validate')),
    redeemSsoApproval: vi.fn(async () => ok('sso-approval-redeem')),
    exchangeSsoApproval: vi.fn(async () => ok('sso-approval-exchange')),
    loadSession: vi.fn(async () => null),
    attestDesktop: vi.fn(async () => ok('desktop-attest')),
    attestPhone: vi.fn(async () => ok('phone-attest')),
    getSessionResult: vi.fn(async () => ok('session-result')),
    mintPairToken: vi.fn(async () => ok('pair-token-mint')),
    redeemPairToken: vi.fn(async () => null),
    mintVerdictToken: vi.fn(async () => ok('verdict-token')),
    verifyVerdict: vi.fn(async () => ok('verify-verdict')),
    ...overrides,
  };
}

function body(response: { body: string }): unknown {
  return JSON.parse(response.body);
}

function selectedDependency(
  deps: PairApiRouterDependencies,
  dependencyName:
    | 'startSsoSession'
    | 'challengeSsoSession'
    | 'redeemSsoApproval'
    | 'exchangeSsoApproval'
    | 'attestDesktop'
    | 'getSessionResult'
    | 'mintPairToken'
    | 'mintVerdictToken'
    | 'verifyVerdict'
) {
  switch (dependencyName) {
    case 'startSsoSession':
      return deps.startSsoSession;
    case 'challengeSsoSession':
      return deps.challengeSsoSession;
    case 'redeemSsoApproval':
      return deps.redeemSsoApproval;
    case 'exchangeSsoApproval':
      return deps.exchangeSsoApproval;
    case 'attestDesktop':
      return deps.attestDesktop;
    case 'getSessionResult':
      return deps.getSessionResult;
    case 'mintPairToken':
      return deps.mintPairToken;
    case 'mintVerdictToken':
      return deps.mintVerdictToken;
    case 'verifyVerdict':
      return deps.verifyVerdict;
  }
}

describe('Pair API HTTP router', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('rejects a disallowed origin before parsing or dispatching the request', async () => {
    const deps = dependencies({ allowOrigin: vi.fn(() => false) });
    const route = createPairApiRouter(deps);

    const response = await route(event('POST /api/session/start', { body: '{not-json' }));

    expect(response.statusCode).toBe(403);
    expect(body(response)).toEqual({ error: 'origin_not_allowed' });
    expect(deps.startPairSession).not.toHaveBeenCalled();
  });

  it('rejects malformed session identifiers before endpoint dispatch', async () => {
    const deps = dependencies();
    const route = createPairApiRouter(deps);

    const response = await route(
      event('POST /api/session/{id}/phone-attest', {
        pathParameters: { id: '../../other-session' },
      })
    );

    expect(response.statusCode).toBe(400);
    expect(body(response)).toEqual({ error: 'invalid_session_id' });
    expect(deps.attestPhone).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON before telemetry or endpoint dispatch', async () => {
    const deps = dependencies();
    const route = createPairApiRouter(deps);

    const response = await route(event('POST /api/session/start', { body: '{not-json' }));

    expect(response.statusCode).toBe(400);
    expect(body(response)).toEqual({ error: 'invalid_body' });
    expect(deps.handleTelemetry).not.toHaveBeenCalled();
    expect(deps.startPairSession).not.toHaveBeenCalled();
  });

  it('short-circuits best-effort telemetry outside domain route dispatch', async () => {
    const telemetryResponse = jsonResp(204, { accepted: true });
    const deps = dependencies({
      handleTelemetry: vi.fn(() => telemetryResponse),
    });
    const route = createPairApiRouter(deps);
    const request = event('POST /api/phone-perf');

    await expect(route(request)).resolves.toBe(telemetryResponse);
    expect(deps.handleTelemetry).toHaveBeenCalledWith(
      'POST /api/phone-perf',
      { marker: 'request-body' },
      request
    );
    expect(deps.startPairSession).not.toHaveBeenCalled();
  });

  it('dispatches session start with the parsed body and trusted viewer IP', async () => {
    const deps = dependencies();
    const route = createPairApiRouter(deps);

    const response = await route(event('POST /api/session/start'));

    expect(body(response)).toEqual({ route: 'session-start' });
    expect(deps.startPairSession).toHaveBeenCalledWith({ marker: 'request-body' }, '203.0.113.9');
  });

  it('returns only the public session-info projection', async () => {
    const deps = dependencies({
      loadSession: vi.fn(async () => ({
        expiresAt: 123_456,
        desktopAttestation: { secret: 'desktop-binding' },
        verdict: 'pending',
        nonce: 'must-not-leak',
        desktopArgusSessionId: 'must-not-leak',
        desktopKeyId: 'must-not-leak',
        ws: { desktopToken: 'must-not-leak' },
      })),
    });
    const route = createPairApiRouter(deps);

    const response = await route(
      event('GET /api/session/{id}/info', {
        pathParameters: { id: SESSION_ID.toUpperCase() },
      })
    );

    expect(deps.loadSession).toHaveBeenCalledWith(SESSION_ID);
    expect(body(response)).toEqual({
      expiresAt: 123_456,
      desktopReady: true,
      verdict: 'pending',
    });
  });

  it('reports an expired public session without exposing storage details', async () => {
    const deps = dependencies();
    const route = createPairApiRouter(deps);

    const response = await route(
      event('GET /api/session/{id}/info', { pathParameters: { id: SESSION_ID } })
    );

    expect(response.statusCode).toBe(200);
    expect(body(response)).toEqual({ expired: true });
  });

  it('passes the viewer IP only to phone and SSO validation trust boundaries', async () => {
    const deps = dependencies();
    const route = createPairApiRouter(deps);
    const phoneRequest = event('POST /api/session/{id}/phone-attest', {
      pathParameters: { id: SESSION_ID },
    });
    const ssoRequest = event('POST /api/sso/{id}/validate', {
      pathParameters: { id: SESSION_ID },
    });

    await route(phoneRequest);
    await route(ssoRequest);

    expect(deps.attestPhone).toHaveBeenCalledWith(
      { marker: 'request-body' },
      SESSION_ID,
      '203.0.113.9'
    );
    expect(deps.validateSsoSession).toHaveBeenCalledWith(
      SESSION_ID,
      { marker: 'request-body' },
      '203.0.113.9'
    );
  });

  it.each([
    ['POST /api/sso/start', 'startSsoSession'],
    ['POST /api/sso/{id}/challenge', 'challengeSsoSession'],
    ['POST /api/sso/approval/redeem', 'redeemSsoApproval'],
    ['POST /api/sso/approval/exchange', 'exchangeSsoApproval'],
    ['POST /api/session/{id}/desktop-attest', 'attestDesktop'],
    ['GET /api/session/{id}/result', 'getSessionResult'],
    ['POST /api/session/{id}/pair-token', 'mintPairToken'],
    ['GET /api/session/{id}/verdict-token', 'mintVerdictToken'],
    ['POST /api/verify', 'verifyVerdict'],
  ] as const)('dispatches %s to %s', async (routeKey, dependencyName) => {
    const deps = dependencies();
    const route = createPairApiRouter(deps);
    const request = event(routeKey, {
      pathParameters: routeKey.includes('{id}') ? { id: SESSION_ID } : undefined,
      cookies: ['approval=cookie'],
    });

    await route(request);

    expect(selectedDependency(deps, dependencyName)).toHaveBeenCalledOnce();
  });

  it('validates and atomically redeems the short pairing token', async () => {
    const deps = dependencies({
      redeemPairToken: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ wsUrl: 'wss://pair.example/ws' }),
    });
    const route = createPairApiRouter(deps);

    const missing = await route(event('POST /api/pair-token/redeem', { body: JSON.stringify({}) }));
    const expired = await route(
      event('POST /api/pair-token/redeem', {
        body: JSON.stringify({ token: 'used-token' }),
      })
    );
    const redeemed = await route(
      event('POST /api/pair-token/redeem', {
        body: JSON.stringify({ token: 'fresh-token' }),
      })
    );

    expect(body(missing)).toEqual({ error: 'missing_token' });
    expect(expired.statusCode).toBe(410);
    expect(body(expired)).toEqual({ error: 'token_expired_or_used' });
    expect(body(redeemed)).toEqual({ wsUrl: 'wss://pair.example/ws' });
    expect(deps.redeemPairToken).toHaveBeenNthCalledWith(1, 'used-token');
    expect(deps.redeemPairToken).toHaveBeenNthCalledWith(2, 'fresh-token');
  });

  it('preserves the JSON catch-all response for an unmatched API route', async () => {
    const route = createPairApiRouter(dependencies());

    const response = await route(
      event('GET /api/unknown/{id}', { pathParameters: { id: SESSION_ID } })
    );

    expect(response.statusCode).toBe(200);
    expect(body(response)).toEqual({
      error: 'no_matching_route',
      routeKey: 'GET /api/unknown/{id}',
    });
  });
});
