import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';

const HOST = process.env.PAIR_HOST ?? 'https://captcha-dev-jw.argus.pw';
const WS_TIMEOUT_MS = 10_000;

interface SessionStart {
  sessionId: string;
  nonce: string;
  ws: { url: string | null; desktopToken: string; phoneToken: string };
}

interface Whoami {
  action: 'whoami';
  envelope: string;
  sessionId: string;
  role: 'desktop' | 'phone';
}

interface PeerMessage {
  action: 'message';
  from: 'desktop' | 'phone' | 'server';
  fromEnvelope?: string;
  sessionId: string;
  data: unknown;
}

const sockets = new Set<WebSocket>();

function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('live WebSocket open timeout')), WS_TIMEOUT_MS);
    socket.addEventListener(
      'open',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
    socket.addEventListener(
      'error',
      () => {
        clearTimeout(timer);
        reject(new Error('live WebSocket open failed'));
      },
      { once: true }
    );
  });
}

function waitForJson<T>(socket: WebSocket, predicate: (message: T) => boolean): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('live WebSocket message timeout')),
      WS_TIMEOUT_MS
    );
    const listener = (event: MessageEvent) => {
      const message = JSON.parse(String(event.data)) as T;
      if (!predicate(message)) return;
      clearTimeout(timer);
      socket.removeEventListener('message', listener);
      resolve(message);
    };
    socket.addEventListener('message', listener);
  });
}

async function startSession(): Promise<SessionStart> {
  const response = await fetch(`${HOST}/api/session/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ challengeId: randomUUID() }),
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<SessionStart>;
}

async function identify(
  wsUrl: string,
  token: string,
  role: Whoami['role']
): Promise<{ socket: WebSocket; identity: Whoami }> {
  const socket = new WebSocket(wsUrl);
  sockets.add(socket);
  await waitForOpen(socket);
  const identityPromise = waitForJson<Whoami>(socket, (message) => message.action === 'whoami');
  socket.send(JSON.stringify({ action: 'whoami', token, origin: HOST }));
  const identity = await identityPromise;
  expect(identity.role).toBe(role);
  return { socket, identity };
}

function sendPeer(socket: WebSocket, me: string, peer: string, data: unknown): void {
  socket.send(JSON.stringify({ action: 'message', me, peer, data }));
}

afterEach(() => {
  sockets.forEach((socket) => socket.close());
  sockets.clear();
});

describe('deployed phone handshake (e2e)', () => {
  it('server-stamps both QR-bound relay directions with authenticated identity', async () => {
    const session = await startSession();
    if (!session.ws.url) throw new Error('deployed session did not return a WebSocket URL');
    const [desktop, phone] = await Promise.all([
      identify(session.ws.url, session.ws.desktopToken, 'desktop'),
      identify(session.ws.url, session.ws.phoneToken, 'phone'),
    ]);
    expect(desktop.identity.sessionId).toBe(session.sessionId);
    expect(phone.identity.sessionId).toBe(session.sessionId);

    const phoneHerePromise = waitForJson<PeerMessage>(
      desktop.socket,
      (message) => message.action === 'message' && message.data !== null
    );
    sendPeer(phone.socket, phone.identity.envelope, desktop.identity.envelope, {
      kind: 'phone-here',
      challenge: true,
    });
    await expect(phoneHerePromise).resolves.toMatchObject({
      from: 'phone',
      fromEnvelope: phone.identity.envelope,
      sessionId: session.sessionId,
      data: { kind: 'phone-here', challenge: true },
    });

    const readyPromise = waitForJson<PeerMessage>(
      phone.socket,
      (message) => message.action === 'message' && message.data !== null
    );
    sendPeer(desktop.socket, desktop.identity.envelope, phone.identity.envelope, {
      kind: 'desktop-ready',
      nonce: session.nonce,
      expiresAt: Math.floor(Date.now() / 1000) + 60,
      desktopArgusSessionId: 'e2e-desktop-argus',
      desktopKeyId: 'e2e-desktop-key',
    });
    await expect(readyPromise).resolves.toMatchObject({
      from: 'desktop',
      fromEnvelope: desktop.identity.envelope,
      sessionId: session.sessionId,
      data: {
        kind: 'desktop-ready',
        nonce: session.nonce,
        desktopArgusSessionId: 'e2e-desktop-argus',
        desktopKeyId: 'e2e-desktop-key',
      },
    });
  });
});
