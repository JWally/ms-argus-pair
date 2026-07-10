/**
 * Desktop verdict-reveal gate (startDesktopSession).
 *
 * When the phone announces it is showing the drawing challenge
 * (`phone-here {challenge:true}`), a server-pushed `paired` verdict must be
 * HELD — verification already happened — until the phone relays `phone-done`
 * (the user tapped DONE / dismissed the challenge). Failures and
 * non-challenge phones settle immediately, and the hold cap releases a
 * wedged gate. The WS layer and QR mint are mocked; the gate logic under
 * test is the real startDesktopSession closure.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startDesktopSession } from '../src/lib/pair';
import { connectAndWhoami } from '../src/lib/ws';
import type { PeerMessage, WsConnection } from '../src/lib/ws';

// vi.mock calls are hoisted above the imports by vitest.
vi.mock('../src/lib/ws', () => ({
  openWs: vi.fn(),
  connectAndWhoami: vi.fn(),
}));
vi.mock('../src/lib/desktop-qr', () => ({
  mintDesktopQr: vi.fn().mockResolvedValue({
    kind: 'png',
    data: new Uint8Array([1]),
    mime: 'image/png',
  }),
}));

interface FakeConn {
  conn: WsConnection;
  emit: (msg: Partial<PeerMessage>) => void;
}

const noopUnsubscribe = () => {};

function makeFakeConn(): FakeConn {
  const handlers: Array<(msg: PeerMessage) => void> = [];
  const conn: WsConnection = {
    envelope: 'desk-env',
    sessionId: 'sess-1',
    role: 'desktop',
    sendPeer: vi.fn(),
    onMessage: (h) => {
      handlers.push(h);
      return noopUnsubscribe;
    },
    onDisconnect: () => noopUnsubscribe,
    waitForMessage: () => new Promise(() => {}),
    close: vi.fn(),
  };
  return { conn, emit: (msg) => handlers.forEach((h) => h(msg as PeerMessage)) };
}

/** 'settled' if the promise resolves within 50ms, else 'pending'. */
function settledState(p: Promise<unknown>): Promise<string> {
  return Promise.race([
    p.then(
      () => 'settled',
      () => 'rejected'
    ),
    new Promise<string>((r) => setTimeout(() => r('pending'), 50)),
  ]);
}

const flush = () => new Promise((r) => setTimeout(r, 0));

async function startSession() {
  const session = await startDesktopSession();
  await flush();
  return session;
}

describe('desktop verdict-reveal gate', () => {
  let fake: FakeConn;

  beforeEach(() => {
    fake = makeFakeConn();
    vi.mocked(connectAndWhoami).mockResolvedValue(fake.conn);
    vi.stubGlobal('window', {
      // Dispatch at call time so vi.useFakeTimers() (installed mid-test)
      // intercepts timers created after it.
      setTimeout: (...args: Parameters<typeof globalThis.setTimeout>) =>
        globalThis.setTimeout(...args),
      clearTimeout: (...args: Parameters<typeof globalThis.clearTimeout>) =>
        globalThis.clearTimeout(...args),
      location: { origin: 'https://test.local', search: '' },
      // argus.run never resolves — keeps the background desktop-attest
      // path quiet; the verdict flow under test does not depend on it.
      argus: { run: () => new Promise(() => {}) },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/api/session/start')) {
          return new Response(
            JSON.stringify({
              sessionId: 'sess-1',
              nonce: 'nonce-1',
              expiresAt: Math.floor(Date.now() / 1000) + 300,
              ws: { url: 'wss://fake', desktopToken: 'dt', phoneToken: 'pt' },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('holds a paired verdict until phone-done when the phone is in the challenge', async () => {
    const session = await startSession();
    fake.emit({
      from: 'phone',
      fromEnvelope: 'ph-env',
      data: { kind: 'phone-here', challenge: true },
    });
    fake.emit({ from: 'server', data: { kind: 'verdict', verdict: 'paired', reason: null } });
    expect(await settledState(session.result)).toBe('pending');

    fake.emit({ from: 'phone', fromEnvelope: 'ph-env', data: { kind: 'phone-done' } });
    await expect(session.result).resolves.toMatchObject({ verdict: 'paired' });
  });

  it('reveals a paired verdict immediately when the phone did not announce a challenge', async () => {
    const session = await startSession();
    fake.emit({
      from: 'phone',
      fromEnvelope: 'ph-env',
      data: { kind: 'phone-here', challenge: false },
    });
    fake.emit({ from: 'server', data: { kind: 'verdict', verdict: 'paired', reason: null } });
    await expect(session.result).resolves.toMatchObject({ verdict: 'paired' });
  });

  it('reveals a failed verdict immediately even mid-challenge', async () => {
    const session = await startSession();
    fake.emit({
      from: 'phone',
      fromEnvelope: 'ph-env',
      data: { kind: 'phone-here', challenge: true },
    });
    fake.emit({ from: 'server', data: { kind: 'verdict', verdict: 'failed', reason: 'nope' } });
    await expect(session.result).resolves.toMatchObject({ verdict: 'failed' });
  });

  it('accepts phone-done arriving before the verdict (user finished first)', async () => {
    const session = await startSession();
    fake.emit({
      from: 'phone',
      fromEnvelope: 'ph-env',
      data: { kind: 'phone-here', challenge: true },
    });
    fake.emit({ from: 'phone', fromEnvelope: 'ph-env', data: { kind: 'phone-done' } });
    fake.emit({ from: 'server', data: { kind: 'verdict', verdict: 'paired', reason: null } });
    await expect(session.result).resolves.toMatchObject({ verdict: 'paired' });
  });

  it('ignores phone-done not stamped from the phone role', async () => {
    const session = await startSession();
    fake.emit({
      from: 'phone',
      fromEnvelope: 'ph-env',
      data: { kind: 'phone-here', challenge: true },
    });
    fake.emit({ from: 'server', data: { kind: 'verdict', verdict: 'paired', reason: null } });
    fake.emit({ from: 'server', data: { kind: 'phone-done' } });
    expect(await settledState(session.result)).toBe('pending');
  });

  it('releases a held verdict via the hold cap if phone-done never arrives', async () => {
    const session = await startSession();
    fake.emit({
      from: 'phone',
      fromEnvelope: 'ph-env',
      data: { kind: 'phone-here', challenge: true },
    });

    vi.useFakeTimers();
    try {
      fake.emit({ from: 'server', data: { kind: 'verdict', verdict: 'paired', reason: null } });
      await vi.advanceTimersByTimeAsync(90_000);
    } finally {
      vi.useRealTimers();
    }
    await expect(session.result).resolves.toMatchObject({ verdict: 'paired' });
  });
});
