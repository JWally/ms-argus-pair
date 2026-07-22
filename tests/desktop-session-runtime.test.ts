import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDesktopSessionRuntime,
  type DesktopSessionRuntimeDependencies,
} from '../src/lib/desktop-session-runtime';
import type { DesktopResultPoll } from '../src/lib/desktop-result-poll';
import type { DesktopVerdictGate } from '../src/lib/desktop-verdict-gate';
import type { PeerMessage, WsConnection } from '../src/lib/ws';

const NOW_MS = 1_000;
const SESSION_EXPIRES_AT = 301;
const DESKTOP_READY = {
  kind: 'desktop-ready',
  nonce: 'nonce-1',
  expiresAt: SESSION_EXPIRES_AT,
  desktopArgusSessionId: 'argus-desktop-1',
  desktopKeyId: 'desktop-key-1',
};

interface FakeConnection {
  connection: WsConnection;
  emit(message: Partial<PeerMessage>): void;
  disconnect(): void;
}

function fakeConnection(): FakeConnection {
  const messageHandlers: Array<(message: PeerMessage) => void> = [];
  const disconnectHandlers: Array<() => void> = [];
  const connection: WsConnection = {
    envelope: 'desktop-envelope',
    sessionId: 'session-1',
    role: 'desktop',
    sendPeer: vi.fn(),
    onMessage: (handler) => {
      messageHandlers.push(handler);
      return () => {};
    },
    onDisconnect: (handler) => {
      disconnectHandlers.push(handler);
      return () => {};
    },
    waitForMessage: vi.fn(),
    close: vi.fn(),
  };
  return {
    connection,
    emit: (message) => messageHandlers.forEach((handler) => handler(message as PeerMessage)),
    disconnect: () => disconnectHandlers.forEach((handler) => handler()),
  };
}

function fakeGate(overrides: Partial<DesktopVerdictGate> = {}): DesktopVerdictGate {
  return {
    result: new Promise(() => {}),
    settle: vi.fn(),
    fail: vi.fn(),
    notePhoneChallenge: vi.fn(),
    releaseHeldVerdict: vi.fn(),
    receiveSealedVerdict: vi.fn(async () => {}),
    receiveRevealKey: vi.fn(async () => {}),
    isSettled: vi.fn(() => false),
    hasHeldVerdict: vi.fn(() => false),
    ...overrides,
  };
}

function fakePoll(): DesktopResultPoll {
  return { start: vi.fn(async () => {}) };
}

function dependencies(
  gate: DesktopVerdictGate,
  poll: DesktopResultPoll
): DesktopSessionRuntimeDependencies {
  return {
    createVerdictGate: vi.fn(() => gate),
    createResultPoll: vi.fn(() => poll),
    nowMs: () => NOW_MS,
    setTimer: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimer: (timer) => globalThis.clearTimeout(timer),
    warn: vi.fn(),
  };
}

function startRuntime(
  fake: FakeConnection,
  gate = fakeGate(),
  poll = fakePoll(),
  onPhoneConnected = vi.fn()
) {
  const deps = dependencies(gate, poll);
  const runtime = createDesktopSessionRuntime(
    {
      sessionId: 'session-1',
      desktopToken: 'desktop-token',
      expiresAt: SESSION_EXPIRES_AT,
      connection: fake.connection,
      onPhoneConnected,
    },
    deps
  );
  return { runtime, gate, poll, deps, onPhoneConnected };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('desktop readiness routing', () => {
  it('waits for an authenticated phone envelope, then sends readiness exactly once', () => {
    vi.useFakeTimers();
    const fake = fakeConnection();
    const { runtime, gate, poll, onPhoneConnected } = startRuntime(fake);
    runtime.queueDesktopReady(DESKTOP_READY);
    fake.emit({ from: 'server', fromEnvelope: 'server-envelope', data: { kind: 'phone-here' } });
    fake.emit({ from: 'phone', data: { kind: 'phone-here' } });
    expect(fake.connection.sendPeer).not.toHaveBeenCalled();

    fake.emit({
      from: 'phone',
      fromEnvelope: 'phone-envelope',
      data: { kind: 'phone-here', challenge: true },
    });
    fake.emit({
      from: 'phone',
      fromEnvelope: 'phone-envelope',
      data: { kind: 'phone-here', challenge: true },
    });

    expect(fake.connection.sendPeer).toHaveBeenCalledExactlyOnceWith(
      'phone-envelope',
      DESKTOP_READY
    );
    expect(onPhoneConnected).toHaveBeenCalledOnce();
    expect(gate.notePhoneChallenge).toHaveBeenCalledWith(true);
    expect(poll.start).not.toHaveBeenCalled();
  });

  it('sends readiness when evidence finishes after the phone connects', () => {
    vi.useFakeTimers();
    const fake = fakeConnection();
    const { runtime } = startRuntime(fake);
    fake.emit({
      from: 'phone',
      fromEnvelope: 'phone-envelope',
      data: { kind: 'phone-here', challenge: false },
    });
    runtime.queueDesktopReady(DESKTOP_READY);
    expect(fake.connection.sendPeer).toHaveBeenCalledWith('phone-envelope', DESKTOP_READY);
  });
});

describe('desktop result fallback scheduling', () => {
  it('starts delayed polling only after the phone appears', async () => {
    vi.useFakeTimers();
    const fake = fakeConnection();
    const { poll } = startRuntime(fake);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(poll.start).not.toHaveBeenCalled();
    fake.emit({
      from: 'phone',
      fromEnvelope: 'phone-envelope',
      data: { kind: 'phone-here' },
    });
    await vi.advanceTimersByTimeAsync(19_999);
    expect(poll.start).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(poll.start).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('starts polling immediately when the socket is already disconnected', () => {
    vi.useFakeTimers();
    const fake = fakeConnection();
    const { poll } = startRuntime(fake);
    fake.disconnect();
    fake.emit({
      from: 'phone',
      fromEnvelope: 'phone-envelope',
      data: { kind: 'phone-here' },
    });
    expect(poll.start).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('accelerates a scheduled fallback when the socket disconnects', async () => {
    vi.useFakeTimers();
    const fake = fakeConnection();
    const { poll } = startRuntime(fake);
    fake.emit({
      from: 'phone',
      fromEnvelope: 'phone-envelope',
      data: { kind: 'phone-here' },
    });

    fake.disconnect();
    expect(poll.start).toHaveBeenCalledOnce();
    expect(poll.start).toHaveBeenCalledWith(0);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(poll.start).toHaveBeenCalledOnce();
  });
});

describe('desktop peer authentication', () => {
  it('accepts plaintext verdicts only from the server', () => {
    vi.useFakeTimers();
    const fake = fakeConnection();
    const { gate, deps } = startRuntime(fake);
    const verdict = { kind: 'verdict', verdict: 'paired', reason: null };

    fake.emit({ from: 'phone', data: verdict });
    expect(gate.settle).not.toHaveBeenCalled();
    expect(deps.warn).toHaveBeenCalledOnce();
    fake.emit({ from: 'server', data: verdict });

    expect(gate.settle).toHaveBeenCalledWith({
      verdict: 'paired',
      reason: null,
      annotations: undefined,
    });
  });

  it('accepts challenge completion only from the phone role', () => {
    vi.useFakeTimers();
    const fake = fakeConnection();
    const { gate } = startRuntime(fake);

    fake.emit({ from: 'server', data: { kind: 'phone-done' } });
    expect(gate.releaseHeldVerdict).not.toHaveBeenCalled();
    fake.emit({ from: 'phone', data: { kind: 'phone-done' } });

    expect(gate.releaseHeldVerdict).toHaveBeenCalledOnce();
  });

  it('forwards sealed verdict material only from the server', () => {
    vi.useFakeTimers();
    const fake = fakeConnection();
    const { gate } = startRuntime(fake);
    const envelope = { iv: 'iv', ciphertext: 'ciphertext' };

    fake.emit({ from: 'phone', data: { kind: 'verdict-sealed', envelope } });
    fake.emit({ from: 'phone', data: { kind: 'verdict-release', revealKey: 'key' } });
    expect(gate.receiveSealedVerdict).not.toHaveBeenCalled();
    expect(gate.receiveRevealKey).not.toHaveBeenCalled();
    fake.emit({ from: 'server', data: { kind: 'verdict-sealed', envelope } });
    fake.emit({ from: 'server', data: { kind: 'verdict-release', revealKey: 'key' } });

    expect(gate.receiveSealedVerdict).toHaveBeenCalledWith(envelope);
    expect(gate.receiveRevealKey).toHaveBeenCalledWith('key');
  });
});

describe('desktop runtime termination', () => {
  it('releases a held verdict instead of replacing it with session expiry', async () => {
    vi.useFakeTimers();
    const gate = fakeGate({ hasHeldVerdict: vi.fn(() => true) });
    const fake = fakeConnection();
    startRuntime(fake, gate);

    await vi.advanceTimersByTimeAsync(SESSION_EXPIRES_AT * 1000 - NOW_MS);

    expect(gate.releaseHeldVerdict).toHaveBeenCalledOnce();
    expect(gate.fail).not.toHaveBeenCalled();
  });

  it('fails an unresolved session at expiry', async () => {
    vi.useFakeTimers();
    const fake = fakeConnection();
    const { gate } = startRuntime(fake);

    await vi.advanceTimersByTimeAsync(SESSION_EXPIRES_AT * 1000 - NOW_MS);

    expect(gate.fail).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: 'session expired' })
    );
  });

  it('cancels timers, closes the socket, and ignores later messages', async () => {
    vi.useFakeTimers();
    const fake = fakeConnection();
    const { runtime, gate, poll, onPhoneConnected } = startRuntime(fake);
    runtime.stop();

    fake.emit({
      from: 'phone',
      fromEnvelope: 'phone-envelope',
      data: { kind: 'phone-here' },
    });
    await vi.runAllTimersAsync();

    expect(fake.connection.close).toHaveBeenCalledOnce();
    expect(onPhoneConnected).not.toHaveBeenCalled();
    expect(poll.start).not.toHaveBeenCalled();
    expect(gate.fail).not.toHaveBeenCalled();
  });
});
