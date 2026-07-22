import { describe, expect, it, vi } from 'vitest';
import {
  startEmbedSession,
  type EmbedSessionCallbacks,
  type EmbedSessionDependencies,
} from '../src/lib/embed-session';
import type { DesktopSession, PairEvents } from '../src/lib/pair';

const png = (bytes: number[]) => new Uint8Array(bytes);

function fakeSession(overrides: Partial<DesktopSession> = {}): DesktopSession {
  return {
    sessionId: 'session-1',
    qr: { kind: 'png', data: png([1, 2, 3]), width: 320, mime: 'image/png' },
    expiresAt: 123_456,
    stop: vi.fn(),
    result: Promise.resolve({ verdict: 'paired', reason: null }),
    getVerdictToken: vi.fn(async () => 'signed-token'),
    ...overrides,
  };
}

function callbacks(): EmbedSessionCallbacks {
  return {
    onConnected: vi.fn(),
    onQrReady: vi.fn(),
    onQrFrame: vi.fn(),
    onCompletion: vi.fn(),
    notifyHost: vi.fn(),
  };
}

function dependencies(
  session: DesktopSession,
  overrides: Partial<EmbedSessionDependencies> = {}
): EmbedSessionDependencies {
  return {
    startSession: vi.fn(async () => session),
    createImageUrl: vi.fn((_frame, _mime) => 'blob:qr-1'),
    revokeImageUrl: vi.fn(),
    setFrameTimer: vi.fn(() => 17),
    clearFrameTimer: vi.fn(),
    isSessionTimeout: vi.fn(() => false),
    ...overrides,
  };
}

describe('embed session completion', () => {
  it('publishes connected, ready, and bound result messages for a successful session', async () => {
    const session = fakeSession();
    const events = callbacks();
    const deps = dependencies(session, {
      startSession: vi.fn(async (pairEvents: PairEvents) => {
        pairEvents.onPhoneConnected?.();
        return session;
      }),
    });

    const run = startEmbedSession(
      { cpi: 'argus_cpi_live_AbCdEf012345.stepup', challengeId: 'challenge_12345678' },
      events,
      deps
    );
    await run.finished;

    expect(deps.startSession).toHaveBeenCalledOnce();
    expect(vi.mocked(deps.startSession).mock.calls.at(0)?.[1]).toEqual({
      cpi: 'argus_cpi_live_AbCdEf012345.stepup',
      challengeId: 'challenge_12345678',
    });
    expect(events.onConnected).toHaveBeenCalledOnce();
    expect(events.onQrReady).toHaveBeenCalledWith('blob:qr-1');
    expect(events.notifyHost).toHaveBeenNthCalledWith(1, { event: 'connected' });
    expect(events.notifyHost).toHaveBeenNthCalledWith(2, {
      event: 'ready',
      sessionId: 'session-1',
    });
    expect(events.notifyHost).toHaveBeenNthCalledWith(3, {
      event: 'result',
      sessionId: 'session-1',
      verdict: 'paired',
      reason: null,
      token: 'signed-token',
    });
    expect(events.onCompletion).toHaveBeenCalledWith('paired');
  });

  it('maps a failed verdict to the failed terminal state', async () => {
    const session = fakeSession({
      result: Promise.resolve({ verdict: 'failed', reason: 'continuity_failed' }),
    });
    const events = callbacks();

    await startEmbedSession({ challengeId: 'challenge_12345678' }, events, dependencies(session))
      .finished;

    expect(events.onCompletion).toHaveBeenCalledWith('failed');
    expect(events.notifyHost).toHaveBeenLastCalledWith(
      expect.objectContaining({ event: 'result', verdict: 'failed', reason: 'continuity_failed' })
    );
  });

  it('fails closed before session start when the merchant challenge is missing', async () => {
    const session = fakeSession();
    const events = callbacks();
    const deps = dependencies(session);

    await startEmbedSession({}, events, deps).finished;

    expect(deps.startSession).not.toHaveBeenCalled();
    expect(events.onCompletion).toHaveBeenCalledWith('failed');
    expect(events.notifyHost).toHaveBeenCalledWith({
      event: 'error',
      message: 'Error: Missing or invalid merchant challenge',
    });
  });

  it('distinguishes routine session timeout from other failures', async () => {
    const timeout = new Error('session expired');
    const session = fakeSession();
    const events = callbacks();
    const deps = dependencies(session, {
      startSession: vi.fn(async () => {
        throw timeout;
      }),
      isSessionTimeout: vi.fn((cause) => cause === timeout),
    });

    await startEmbedSession({ challengeId: 'challenge_12345678' }, events, deps).finished;

    expect(deps.isSessionTimeout).toHaveBeenCalledWith(timeout);
    expect(events.onCompletion).toHaveBeenCalledWith('timeout');
    expect(events.notifyHost).toHaveBeenCalledWith({
      event: 'error',
      message: 'Error: session expired',
    });
  });
});

describe('embed QR resource lifecycle', () => {
  it('animates poisoned QR frames and releases every browser resource on stop', async () => {
    let frameTick: (() => void) | undefined;
    const session = fakeSession({
      qr: {
        kind: 'png-frames',
        frames: [png([1]), png([2]), png([3])],
        frameMs: 180,
        mime: 'image/png',
      },
      result: new Promise(() => {}),
    });
    const events = callbacks();
    const deps = dependencies(session, {
      createImageUrl: vi
        .fn()
        .mockReturnValueOnce('blob:qr-1')
        .mockReturnValueOnce('blob:qr-2')
        .mockReturnValueOnce('blob:qr-3'),
      setFrameTimer: vi.fn((callback) => {
        frameTick = callback;
        return 23;
      }),
    });

    const run = startEmbedSession({ challengeId: 'challenge_12345678' }, events, deps);
    await vi.waitFor(() => expect(events.onQrReady).toHaveBeenCalledWith('blob:qr-1'));
    frameTick?.();
    frameTick?.();

    expect(events.onQrFrame).toHaveBeenNthCalledWith(1, 'blob:qr-2');
    expect(events.onQrFrame).toHaveBeenNthCalledWith(2, 'blob:qr-3');
    run.stop();

    expect(deps.clearFrameTimer).toHaveBeenCalledWith(23);
    expect(deps.revokeImageUrl).toHaveBeenCalledTimes(3);
    expect(deps.revokeImageUrl).toHaveBeenNthCalledWith(1, 'blob:qr-1');
    expect(deps.revokeImageUrl).toHaveBeenNthCalledWith(2, 'blob:qr-2');
    expect(deps.revokeImageUrl).toHaveBeenNthCalledWith(3, 'blob:qr-3');
    expect(session.stop).toHaveBeenCalledOnce();
  });

  it('stops a late session without publishing after the embed unmounts', async () => {
    let resolveSession!: (session: DesktopSession) => void;
    const session = fakeSession();
    const events = callbacks();
    const deps = dependencies(session, {
      startSession: vi.fn(
        () => new Promise<DesktopSession>((resolve) => (resolveSession = resolve))
      ),
    });

    const run = startEmbedSession({ challengeId: 'challenge_12345678' }, events, deps);
    run.stop();
    resolveSession(session);
    await run.finished;

    expect(session.stop).toHaveBeenCalledOnce();
    expect(events.onQrReady).not.toHaveBeenCalled();
    expect(events.notifyHost).not.toHaveBeenCalled();
  });

  it('forwards active transport errors but ignores them after stop', async () => {
    let pairEvents: PairEvents | undefined;
    const session = fakeSession({ result: new Promise(() => {}) });
    const events = callbacks();
    const deps = dependencies(session, {
      startSession: vi.fn(async (capturedEvents: PairEvents) => {
        pairEvents = capturedEvents;
        return session;
      }),
    });

    const run = startEmbedSession({ challengeId: 'challenge_12345678' }, events, deps);
    await vi.waitFor(() => expect(events.onQrReady).toHaveBeenCalled());
    pairEvents?.onError?.('socket degraded');
    run.stop();
    pairEvents?.onError?.('late error');

    expect(events.notifyHost).toHaveBeenCalledWith({
      event: 'error',
      message: 'socket degraded',
    });
    expect(events.notifyHost).not.toHaveBeenCalledWith({
      event: 'error',
      message: 'late error',
    });
  });
});
