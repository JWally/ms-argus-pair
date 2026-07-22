import {
  createDesktopResultPoll,
  type DesktopResultPoll,
  type DesktopResultPollOptions,
} from './desktop-result-poll';
import {
  createDesktopVerdictGate,
  type DesktopVerdict,
  type DesktopVerdictGate,
} from './desktop-verdict-gate';
import type { SealedVerdictEnvelope } from './verdict-envelope';
import type { PeerMessage, WsConnection } from './ws';

const CONNECTED_POLL_DELAY_MS = 20_000;

type TimerHandle = ReturnType<typeof globalThis.setTimeout>;

export interface DesktopSessionRuntimeOptions {
  sessionId: string;
  desktopToken: string;
  expiresAt: number;
  connection: WsConnection;
  onPhoneConnected?: () => void;
}

export interface DesktopSessionRuntime {
  result: Promise<DesktopVerdict>;
  isCancelled(): boolean;
  queueDesktopReady(message: Record<string, unknown>): void;
  fail(error: unknown): void;
  stop(): void;
}

export interface DesktopSessionRuntimeDependencies {
  createVerdictGate(sessionId: string): DesktopVerdictGate;
  createResultPoll(options: DesktopResultPollOptions): DesktopResultPoll;
  nowMs(): number;
  setTimer(callback: () => void, delayMs: number): TimerHandle;
  clearTimer(timer: TimerHandle): void;
  warn(message: string): void;
}

const defaultDependencies: DesktopSessionRuntimeDependencies = {
  createVerdictGate: createDesktopVerdictGate,
  createResultPoll: createDesktopResultPoll,
  nowMs: Date.now,
  setTimer: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimer: (timer) => globalThis.clearTimeout(timer),
  warn: (message) => console.warn(message),
};

class StatefulDesktopSessionRuntime implements DesktopSessionRuntime {
  readonly result: Promise<DesktopVerdict>;

  private readonly gate: DesktopVerdictGate;
  private readonly poll: DesktopResultPoll;
  private cancelled = false;
  private isSocketConnected = true;
  private notifiedPhoneConnected = false;
  private phoneEnvelope: string | null = null;
  private bufferedReady: Record<string, unknown> | null = null;
  private fallbackTimer: TimerHandle | null = null;
  private expiryTimer: TimerHandle | null = null;

  constructor(
    private readonly options: DesktopSessionRuntimeOptions,
    private readonly dependencies: DesktopSessionRuntimeDependencies
  ) {
    this.gate = dependencies.createVerdictGate(options.sessionId);
    this.poll = dependencies.createResultPoll({
      sessionId: options.sessionId,
      desktopToken: options.desktopToken,
      gate: this.gate,
      isCancelled: () => this.cancelled,
    });
    this.result = this.gate.result;
    options.connection.onMessage(this.handleMessage);
    options.connection.onDisconnect(this.handleDisconnect);
    const expiryDelayMs = Math.max(0, options.expiresAt * 1000 - dependencies.nowMs());
    this.expiryTimer = dependencies.setTimer(this.expire, expiryDelayMs);
  }

  isCancelled = (): boolean => this.cancelled;

  queueDesktopReady = (message: Record<string, unknown>): void => {
    if (this.cancelled) return;
    this.bufferedReady = message;
    this.sendReadyIfPossible();
  };

  fail = (error: unknown): void => {
    if (!this.cancelled) this.gate.fail(error);
  };

  stop = (): void => {
    if (this.cancelled) return;
    this.cancelled = true;
    this.clearFallbackTimer();
    if (this.expiryTimer !== null) {
      this.dependencies.clearTimer(this.expiryTimer);
      this.expiryTimer = null;
    }
    this.options.connection.close();
  };

  private readonly handleDisconnect = (): void => {
    this.isSocketConnected = false;
    if (!this.notifiedPhoneConnected || this.cancelled) return;
    this.clearFallbackTimer();
    void this.poll.start(0);
  };

  private readonly handleMessage = (message: PeerMessage): void => {
    if (this.cancelled) return;
    const data = message.data as { kind?: string; challenge?: boolean } | null;
    if (!data || typeof data.kind !== 'string') return;
    switch (data.kind) {
      case 'phone-here':
        this.handlePhoneHere(message, data);
        break;
      case 'phone-done':
        if (message.from === 'phone') this.gate.releaseHeldVerdict();
        break;
      case 'verdict':
        this.handlePlainVerdict(message, data);
        break;
      case 'verdict-sealed':
        if (message.from === 'server') {
          void this.gate.receiveSealedVerdict(
            (data as { envelope: SealedVerdictEnvelope }).envelope
          );
        }
        break;
      case 'verdict-release':
        if (message.from === 'server') {
          void this.gate.receiveRevealKey((data as { revealKey: string }).revealKey);
        }
        break;
    }
  };

  private handlePhoneHere(message: PeerMessage, data: { challenge?: boolean }): void {
    if (message.from !== 'phone' || !message.fromEnvelope) return;
    this.phoneEnvelope = message.fromEnvelope;
    this.gate.notePhoneChallenge(data.challenge === true);
    if (!this.notifiedPhoneConnected) {
      this.notifiedPhoneConnected = true;
      this.options.onPhoneConnected?.();
      this.scheduleFallbackPoll();
    }
    this.sendReadyIfPossible();
  }

  private handlePlainVerdict(message: PeerMessage, data: Record<string, unknown>): void {
    if (message.from !== 'server') {
      this.dependencies.warn(`[pair] dropping verdict with from=${message.from} (not server)`);
      return;
    }
    this.gate.settle({
      verdict: data.verdict as string,
      reason: (data.reason as string | null) ?? null,
      annotations: data.annotations as Record<string, unknown> | undefined,
    });
  }

  private scheduleFallbackPoll(): void {
    if (!this.isSocketConnected) {
      void this.poll.start(0);
      return;
    }
    if (this.fallbackTimer !== null) return;
    this.fallbackTimer = this.dependencies.setTimer(() => {
      this.fallbackTimer = null;
      if (!this.cancelled) void this.poll.start(0);
    }, CONNECTED_POLL_DELAY_MS);
  }

  private sendReadyIfPossible(): void {
    if (!this.phoneEnvelope || !this.bufferedReady) return;
    this.options.connection.sendPeer(this.phoneEnvelope, this.bufferedReady);
    this.bufferedReady = null;
  }

  private clearFallbackTimer(): void {
    if (this.fallbackTimer === null) return;
    this.dependencies.clearTimer(this.fallbackTimer);
    this.fallbackTimer = null;
  }

  private readonly expire = (): void => {
    this.expiryTimer = null;
    if (this.cancelled) return;
    this.clearFallbackTimer();
    if (this.gate.hasHeldVerdict()) {
      this.gate.releaseHeldVerdict();
      return;
    }
    this.gate.fail(new Error('session expired'));
  };
}

export function createDesktopSessionRuntime(
  options: DesktopSessionRuntimeOptions,
  dependencies: DesktopSessionRuntimeDependencies = defaultDependencies
): DesktopSessionRuntime {
  return new StatefulDesktopSessionRuntime(options, dependencies);
}
