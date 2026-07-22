import { describe, expect, it, vi } from 'vitest';
import {
  bootstrapDesktopSession,
  type DesktopSessionStartResponse,
} from '../src/lib/desktop-session-bootstrap';
import type { WsConnection } from '../src/lib/ws';

const SESSION: DesktopSessionStartResponse = {
  sessionId: 'session-1',
  nonce: 'nonce-1',
  expiresAt: 123_456,
  ws: {
    url: 'wss://pair.example/ws',
    desktopToken: 'desktop-token',
    phoneToken: 'phone-token',
  },
};

function fakeSocket(url: string) {
  return { url, close: vi.fn() } as unknown as WebSocket;
}

function fakeConnection(): WsConnection {
  return {
    envelope: 'desktop-envelope',
    sessionId: SESSION.sessionId,
    role: 'desktop',
    sendPeer: vi.fn(),
    onMessage: vi.fn(() => vi.fn()),
    onDisconnect: vi.fn(() => vi.fn()),
    waitForMessage: vi.fn(),
    close: vi.fn(),
  };
}

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    startSession: vi.fn().mockResolvedValue(SESSION),
    openSocket: vi.fn(),
    connect: vi.fn().mockResolvedValue(fakeConnection()),
    warn: vi.fn(),
    ...overrides,
  };
}

describe('bootstrapDesktopSession', () => {
  it('starts HTTP and the eager WebSocket concurrently, then reuses the matching socket', async () => {
    const eagerSocket = fakeSocket(`${SESSION.ws.url}?eager=1`);
    let finishHttp!: (session: DesktopSessionStartResponse) => void;
    let finishSocket!: (socket: WebSocket) => void;
    const deps = dependencies({
      startSession: vi.fn(
        () => new Promise<DesktopSessionStartResponse>((resolve) => (finishHttp = resolve))
      ),
      openSocket: vi.fn(() => new Promise<WebSocket>((resolve) => (finishSocket = resolve))),
    });

    const pending = bootstrapDesktopSession(
      {
        challengeId: 'challenge-1',
        cpi: 'cpi-1',
        hostPreflightRequired: true,
        hostOrigin: 'https://merchant.example',
        staticWsUrl: SESSION.ws.url,
        origin: 'https://pair.example',
      },
      deps
    );

    expect(deps.startSession).toHaveBeenCalledWith({
      challengeId: 'challenge-1',
      cpi: 'cpi-1',
      hostPreflightRequired: true,
      hostOrigin: 'https://merchant.example',
    });
    expect(deps.openSocket).toHaveBeenCalledWith(SESSION.ws.url);
    finishSocket(eagerSocket);
    finishHttp(SESSION);

    await expect(pending).resolves.toMatchObject({ session: SESSION });
    expect(deps.connect).toHaveBeenCalledWith({
      url: SESSION.ws.url,
      token: SESSION.ws.desktopToken,
      origin: 'https://pair.example',
      existingWs: eagerSocket,
    });
    expect(eagerSocket.close).not.toHaveBeenCalled();
  });

  it('uses the serial connection path when no static WebSocket URL is configured', async () => {
    const deps = dependencies();

    await bootstrapDesktopSession(
      { challengeId: 'challenge-1', origin: 'https://pair.example' },
      deps
    );

    expect(deps.startSession).toHaveBeenCalledWith({ challengeId: 'challenge-1' });
    expect(deps.openSocket).not.toHaveBeenCalled();
    expect(deps.connect).toHaveBeenCalledWith({
      url: SESSION.ws.url,
      token: SESSION.ws.desktopToken,
      origin: 'https://pair.example',
      existingWs: undefined,
    });
  });

  it('falls back to a fresh connection when the eager socket fails', async () => {
    const error = new Error('network down');
    const deps = dependencies({ openSocket: vi.fn().mockRejectedValue(error) });

    await bootstrapDesktopSession(
      {
        challengeId: 'challenge-1',
        staticWsUrl: SESSION.ws.url,
        origin: 'https://pair.example',
      },
      deps
    );

    expect(deps.warn).toHaveBeenCalledWith(
      '[argus-pair] eager ws open failed, falling back',
      error
    );
    expect(deps.connect).toHaveBeenCalledWith(expect.objectContaining({ existingWs: undefined }));
  });

  it('closes a socket opened against a stale URL and connects to the server URL', async () => {
    const staleSocket = fakeSocket('wss://stale.example/ws');
    const deps = dependencies({ openSocket: vi.fn().mockResolvedValue(staleSocket) });

    await bootstrapDesktopSession(
      {
        challengeId: 'challenge-1',
        staticWsUrl: 'wss://stale.example/ws',
        origin: 'https://pair.example',
      },
      deps
    );

    expect(staleSocket.close).toHaveBeenCalledOnce();
    expect(deps.connect).toHaveBeenCalledWith(expect.objectContaining({ existingWs: undefined }));
  });

  it('closes the eager socket and rejects malformed bootstrap material', async () => {
    const eagerSocket = fakeSocket(SESSION.ws.url);
    const deps = dependencies({
      startSession: vi.fn().mockResolvedValue({ ...SESSION, ws: { url: SESSION.ws.url } }),
      openSocket: vi.fn().mockResolvedValue(eagerSocket),
    });

    await expect(
      bootstrapDesktopSession(
        {
          challengeId: 'challenge-1',
          staticWsUrl: SESSION.ws.url,
          origin: 'https://pair.example',
        },
        deps
      )
    ).rejects.toThrow('session/start did not return WebSocket bootstrap material');
    expect(eagerSocket.close).toHaveBeenCalledOnce();
    expect(deps.connect).not.toHaveBeenCalled();
  });
});
