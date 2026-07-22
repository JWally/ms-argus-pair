import { describe, expect, it, vi } from 'vitest';
import {
  awaitPhoneSessionReady,
  parsePhoneSessionHash,
  signalPhoneChallengeDone,
  type PhoneScanResult,
  type PhoneSessionRuntimeDependencies,
} from '../src/lib/phone-session-runtime';
import type { PeerMessage, WsConnection } from '../src/lib/ws';

const HASH =
  '#wsUrl=wss://pair.example.test&' + 'e=desktop-envelope&pt=phone-token&n=nonce-1&pr=1&fr=0';

const SCAN: PhoneScanResult = {
  sessionId: null,
  argusSessionId: 'argus-phone-1',
  durationMs: 12,
  attestation: {
    envelope: 'attestation-envelope',
    signature: 'signature',
    publicKey: 'public-key',
    keyId: 'phone-key-1',
  },
};

const READY = {
  kind: 'desktop-ready',
  nonce: 'nonce-1',
  expiresAt: 300,
  desktopArgusSessionId: 'argus-desktop-1',
  desktopKeyId: 'desktop-key-1',
};

interface FakeConnection {
  connection: WsConnection;
  emit(message: Partial<PeerMessage>): void;
}

function noOp(): void {}

function fakeConnection(): FakeConnection {
  const handlers = new Set<(message: PeerMessage) => void>();
  const waiters = new Set<{
    predicate: (message: PeerMessage) => boolean;
    resolve: (message: PeerMessage) => void;
  }>();
  const connection: WsConnection = {
    envelope: 'phone-envelope',
    sessionId: 'session-1',
    role: 'phone',
    sendPeer: vi.fn(),
    onMessage: (handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    onDisconnect: vi.fn().mockReturnValue(noOp),
    waitForMessage: vi.fn(
      (predicate) =>
        new Promise((resolve) => {
          waiters.add({ predicate, resolve });
        })
    ),
    close: vi.fn(),
  };
  return {
    connection,
    emit(message) {
      const complete = message as PeerMessage;
      handlers.forEach((handler) => handler(complete));
      for (const waiter of waiters) {
        if (waiter.predicate(complete)) {
          waiters.delete(waiter);
          waiter.resolve(complete);
        }
      }
    },
  };
}

function dependencies(fake: FakeConnection, order: string[] = []): PhoneSessionRuntimeDependencies {
  return {
    readHash: () => HASH,
    getOrigin: () => 'https://captcha.example.test',
    startScan: vi.fn(async () => {
      order.push('scan');
      return SCAN;
    }),
    connect: vi.fn(async () => {
      order.push('connect');
      return fake.connection;
    }),
  };
}

async function waitForAnnouncement(connection: WsConnection): Promise<void> {
  await vi.waitFor(() => expect(connection.sendPeer).toHaveBeenCalledOnce());
}

describe('phone session hash parsing', () => {
  it('parses authenticated routing material and proof policy', () => {
    expect(parsePhoneSessionHash(HASH)).toEqual({
      wsUrl: 'wss://pair.example.test',
      desktopEnvelope: 'desktop-envelope',
      phoneToken: 'phone-token',
      nonce: 'nonce-1',
      proofRequired: true,
      freshProofRequired: false,
    });
  });

  it('defaults old links to strict proof and rejects incomplete links', () => {
    expect(
      parsePhoneSessionHash('#wsUrl=wss://pair.example.test&e=desktop&pt=phone&n=nonce')
        .proofRequired
    ).toBe(true);
    expect(() => parsePhoneSessionHash('#wsUrl=wss://pair.example.test')).toThrow(
      'pair URL is missing WebSocket routing material'
    );
  });
});

describe('phone readiness handshake', () => {
  it('starts the scan before connecting and returns authenticated desktop readiness', async () => {
    const order: string[] = [];
    const fake = fakeConnection();
    const deps = dependencies(fake, order);
    const onScanStart = vi.fn();
    const onScanDone = vi.fn();
    const pending = awaitPhoneSessionReady(
      'session-1',
      undefined,
      { challenge: true, onScanStart, onScanDone },
      deps
    );
    await waitForAnnouncement(fake.connection);

    expect(order).toEqual(['scan', 'connect']);
    expect(onScanStart).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(onScanDone).toHaveBeenCalledWith(SCAN));
    expect(fake.connection.sendPeer).toHaveBeenCalledWith('desktop-envelope', {
      kind: 'phone-here',
      challenge: true,
    });

    fake.emit({
      action: 'message',
      from: 'desktop',
      fromEnvelope: 'desktop-envelope',
      sessionId: 'session-1',
      data: READY,
    });

    await expect(pending).resolves.toMatchObject({
      nonce: 'nonce-1',
      desktopArgusSessionId: 'argus-desktop-1',
      desktopKeyId: 'desktop-key-1',
      desktopEnvelope: 'desktop-envelope',
      phoneToken: 'phone-token',
      conn: fake.connection,
    });
  });

  it('ignores readiness from the wrong role, envelope, session, or payload shape', async () => {
    const fake = fakeConnection();
    const pending = awaitPhoneSessionReady('session-1', undefined, {}, dependencies(fake));
    await waitForAnnouncement(fake.connection);
    let settled = false;
    void pending.then(() => (settled = true));

    for (const message of [
      { from: 'server', fromEnvelope: 'desktop-envelope', sessionId: 'session-1', data: READY },
      { from: 'desktop', fromEnvelope: 'wrong-envelope', sessionId: 'session-1', data: READY },
      { from: 'desktop', fromEnvelope: 'desktop-envelope', sessionId: 'other', data: READY },
      {
        from: 'desktop',
        fromEnvelope: 'desktop-envelope',
        sessionId: 'session-1',
        data: { kind: 'desktop-ready', nonce: 'nonce-1' },
      },
    ]) {
      fake.emit({ action: 'message', ...message } as PeerMessage);
      await Promise.resolve();
      expect(settled).toBe(false);
    }

    fake.emit({
      action: 'message',
      from: 'desktop',
      fromEnvelope: 'desktop-envelope',
      sessionId: 'session-1',
      data: READY,
    });
    await expect(pending).resolves.toMatchObject({ desktopKeyId: 'desktop-key-1' });
  });

  it('rejects immediately on abort and closes an established connection', async () => {
    const before = new AbortController();
    before.abort();
    const unused = fakeConnection();
    const unusedDeps = dependencies(unused);
    await expect(
      awaitPhoneSessionReady('session-1', before.signal, {}, unusedDeps)
    ).rejects.toThrow('aborted');
    expect(unusedDeps.startScan).not.toHaveBeenCalled();

    const after = new AbortController();
    const fake = fakeConnection();
    const pending = awaitPhoneSessionReady('session-1', after.signal, {}, dependencies(fake));
    await waitForAnnouncement(fake.connection);
    after.abort();

    await expect(pending).rejects.toThrow('aborted');
    expect(fake.connection.close).toHaveBeenCalledOnce();
  });

  it('fails closed when whoami returns the wrong session identity or role', async () => {
    const wrongSession = fakeConnection();
    wrongSession.connection.sessionId = 'other-session';
    await expect(
      awaitPhoneSessionReady('session-1', undefined, {}, dependencies(wrongSession))
    ).rejects.toThrow('phone session identity mismatch');
    expect(wrongSession.connection.close).toHaveBeenCalledOnce();

    const wrongRole = fakeConnection();
    wrongRole.connection.role = 'desktop';
    await expect(
      awaitPhoneSessionReady('session-1', undefined, {}, dependencies(wrongRole))
    ).rejects.toThrow('phone session identity mismatch');
    expect(wrongRole.connection.close).toHaveBeenCalledOnce();
  });
});

describe('phone server release and completion', () => {
  it('accepts a reveal key only from the server in the current session', async () => {
    const fake = fakeConnection();
    const pending = awaitPhoneSessionReady('session-1', undefined, {}, dependencies(fake));
    await waitForAnnouncement(fake.connection);
    fake.emit({
      action: 'message',
      from: 'desktop',
      fromEnvelope: 'desktop-envelope',
      sessionId: 'session-1',
      data: READY,
    });
    const info = await pending;
    const reveal = info.getVerdictRevealKey();

    fake.emit({
      action: 'message',
      from: 'phone',
      sessionId: 'session-1',
      data: { kind: 'verdict-release', revealKey: 'forged' },
    });
    fake.emit({
      action: 'message',
      from: 'server',
      sessionId: 'other-session',
      data: { kind: 'verdict-release', revealKey: 'wrong-session' },
    });
    fake.emit({
      action: 'message',
      from: 'server',
      sessionId: 'session-1',
      data: { kind: 'verdict-release', revealKey: 'release-key' },
    });

    await expect(reveal).resolves.toBe('release-key');
  });

  it('signals challenge completion best-effort', () => {
    const fake = fakeConnection();
    const info = {
      desktopEnvelope: 'desktop-envelope',
      conn: fake.connection,
    } as Parameters<typeof signalPhoneChallengeDone>[0];

    signalPhoneChallengeDone(info);
    expect(fake.connection.sendPeer).toHaveBeenCalledWith('desktop-envelope', {
      kind: 'phone-done',
    });

    vi.mocked(fake.connection.sendPeer).mockImplementation(() => {
      throw new Error('socket closed');
    });
    expect(() => signalPhoneChallengeDone(info)).not.toThrow();
  });
});
