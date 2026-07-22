import { describe, expect, it, vi } from 'vitest';
import {
  ALLOWED_ORIGIN,
  claims,
  createWsHarness,
  envelope,
  event,
  messageEvent,
  NOW,
  SESSION_ID,
} from '../fixtures/ws-router-harness';

describe('WebSocket application router', () => {
  it('accepts connect and releases the claimed role on disconnect', async () => {
    const { route, deps } = createWsHarness();

    await expect(
      route(
        event(null, { requestContext: { ...event(null).requestContext, routeKey: '$connect' } })
      )
    ).resolves.toEqual({ statusCode: 200 });
    await expect(
      route(
        event(null, {
          requestContext: {
            ...event(null).requestContext,
            routeKey: '$disconnect',
            connectionId: 'released-connection',
          },
        })
      )
    ).resolves.toEqual({ statusCode: 200 });

    expect(deps.releaseRoleConnection).toHaveBeenCalledWith('released-connection');
  });

  it('rejects malformed JSON and unknown actions without invoking adapters', async () => {
    const { route, deps } = createWsHarness();

    await expect(route(event('{not-json'))).resolves.toEqual({
      statusCode: 400,
      body: 'invalid_json',
    });
    await expect(route(event({ action: 'invented' }))).resolves.toEqual({
      statusCode: 400,
      body: 'unknown_action',
    });

    expect(deps.verifyBootstrapToken).not.toHaveBeenCalled();
    expect(deps.openEnvelope).not.toHaveBeenCalled();
  });

  it('server-stamps and returns an authenticated connection identity', async () => {
    const { route, deps, sent } = createWsHarness();

    await expect(
      route(
        event({
          action: 'whoami',
          token: 'desktop-token',
          publicKey: 'desktop-public-key',
          origin: ALLOWED_ORIGIN,
        })
      )
    ).resolves.toEqual({ statusCode: 200 });

    expect(deps.claimRoleConnection).toHaveBeenCalledWith(claims.desktop, 'desktop-connection');
    expect(deps.sealEnvelope).toHaveBeenCalledWith({
      v: 1,
      connectionId: 'desktop-connection',
      sessionId: SESSION_ID,
      role: 'desktop',
      ip: '198.51.100.9',
      origin: ALLOWED_ORIGIN,
      iat: NOW,
      publicKey: 'desktop-public-key',
    });
    expect(sent).toEqual([
      {
        connectionId: 'desktop-connection',
        data: {
          action: 'whoami',
          envelope: 'desktop-sealed',
          sessionId: SESSION_ID,
          role: 'desktop',
        },
      },
    ]);
  });

  it.each([
    ['missing token', { origin: ALLOWED_ORIGIN }, 'missing_token'],
    ['invalid token', { token: 'forged-token', origin: ALLOWED_ORIGIN }, 'invalid_token'],
    ['missing origin', { token: 'desktop-token' }, 'origin_not_allowed'],
    [
      'disallowed origin',
      { token: 'desktop-token', origin: 'https://attacker.example' },
      'origin_not_allowed',
    ],
  ])('rejects whoami with %s', async (_label, body, expectedError) => {
    const { route, deps, sent } = createWsHarness();

    await expect(route(event({ action: 'whoami', ...body }))).resolves.toEqual({
      statusCode: 400,
      body: expectedError,
    });

    expect(deps.claimRoleConnection).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it('rejects a copied token when its session role is already connected', async () => {
    const { route, deps, sent } = createWsHarness({
      claimRoleConnection: vi.fn(async () => false),
    });

    await expect(
      route(event({ action: 'whoami', token: 'phone-token', origin: ALLOWED_ORIGIN }))
    ).resolves.toEqual({ statusCode: 400, body: 'role_already_connected' });

    expect(deps.sealEnvelope).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it.each([
    [
      'the sender does not own its envelope',
      'other-connection',
      envelope('desktop'),
      envelope('phone'),
      'envelope_connection_mismatch',
    ],
    [
      'the peer belongs to another session',
      'desktop-connection',
      envelope('desktop'),
      envelope('phone', { sessionId: 'other-session' }),
      'cross_session',
    ],
    [
      'both peers claim the same role',
      'desktop-connection',
      envelope('desktop'),
      envelope('desktop', { connectionId: 'other-desktop' }),
      'same_role',
    ],
    [
      'either envelope is outside the replay window',
      'desktop-connection',
      envelope('desktop', { iat: NOW - 3_601 }),
      envelope('phone'),
      'envelope_expired',
    ],
  ])('rejects a relay when %s', async (_label, connectionId, me, peer, expectedError) => {
    const { route, openedEnvelopes, sent } = createWsHarness();
    openedEnvelopes.set('me', me);
    openedEnvelopes.set('peer', peer);

    await expect(route(messageEvent(connectionId, 'me', 'peer'))).resolves.toEqual({
      statusCode: 400,
      body: expectedError,
    });
    expect(sent).toEqual([]);
  });

  it('rejects missing or forged envelopes before applying relay policy', async () => {
    const { route, deps, openedEnvelopes } = createWsHarness();
    openedEnvelopes.set('me', envelope('desktop'));

    await expect(route(event({ action: 'message' }))).resolves.toEqual({
      statusCode: 400,
      body: 'missing_envelopes',
    });
    await expect(route(messageEvent('desktop-connection', 'me', 'forged'))).resolves.toEqual({
      statusCode: 400,
      body: 'invalid_envelope',
    });
    expect(deps.markPhoneChallenge).not.toHaveBeenCalled();
  });

  it('relays only server-stamped sender identity and the original sealed envelope', async () => {
    const { route, openedEnvelopes, sent } = createWsHarness();
    openedEnvelopes.set('desktop-envelope', envelope('desktop'));
    openedEnvelopes.set('phone-envelope', envelope('phone'));
    const data = { kind: 'desktop-ready', nonce: 'nonce-1' };

    await expect(
      route(messageEvent('desktop-connection', 'desktop-envelope', 'phone-envelope', data))
    ).resolves.toEqual({ statusCode: 200 });

    expect(sent).toEqual([
      {
        connectionId: 'phone-connection',
        data: {
          action: 'message',
          from: 'desktop',
          fromEnvelope: 'desktop-envelope',
          sessionId: SESSION_ID,
          data,
        },
      },
    ]);
  });

  it('persists a phone challenge before relaying phone-here', async () => {
    const { route, deps, openedEnvelopes } = createWsHarness();
    openedEnvelopes.set('phone-envelope', envelope('phone'));
    openedEnvelopes.set('desktop-envelope', envelope('desktop'));

    await route(
      messageEvent('phone-connection', 'phone-envelope', 'desktop-envelope', {
        kind: 'phone-here',
        challenge: true,
      })
    );

    expect(deps.markPhoneChallenge).toHaveBeenCalledWith(SESSION_ID, true, NOW + 360);
    expect(vi.mocked(deps.markPhoneChallenge).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(deps.sendToConnection).mock.invocationCallOrder[0]
    );
  });

  it('does not accept a verdict-release signal from the desktop role', async () => {
    const { route, deps, openedEnvelopes, sent } = createWsHarness();
    openedEnvelopes.set('desktop-envelope', envelope('desktop'));
    openedEnvelopes.set('phone-envelope', envelope('phone'));

    await route(
      messageEvent('desktop-connection', 'desktop-envelope', 'phone-envelope', {
        kind: 'phone-done',
      })
    );

    expect(deps.markPhoneDone).not.toHaveBeenCalled();
    expect(deps.getVerdictRevealKey).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
  });

  it('marks phone completion and releases the verdict to both authenticated peers', async () => {
    const { route, deps, openedEnvelopes, sent } = createWsHarness();
    openedEnvelopes.set('phone-envelope', envelope('phone'));
    openedEnvelopes.set('desktop-envelope', envelope('desktop'));

    await route(
      messageEvent('phone-connection', 'phone-envelope', 'desktop-envelope', {
        kind: 'phone-done',
      })
    );

    expect(deps.markPhoneDone).toHaveBeenCalledWith(SESSION_ID, NOW + 360);
    expect(deps.getVerdictRevealKey).toHaveBeenCalledWith(SESSION_ID);
    expect(sent).toHaveLength(3);
    expect(sent.slice(1)).toEqual([
      {
        connectionId: 'desktop-connection',
        data: {
          action: 'message',
          from: 'server',
          sessionId: SESSION_ID,
          data: { kind: 'verdict-release', revealKey: 'reveal-key' },
        },
      },
      {
        connectionId: 'phone-connection',
        data: {
          action: 'message',
          from: 'server',
          sessionId: SESSION_ID,
          data: { kind: 'verdict-release', revealKey: 'reveal-key' },
        },
      },
    ]);
  });
});
