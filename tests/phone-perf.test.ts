import { describe, expect, it, vi } from 'vitest';
import { createPhonePerfReporter } from '../src/lib/phone-perf.ts';

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe('phone performance reporter', () => {
  it('batches a normal pairing timeline into one request', () => {
    let nowMs = 1_000;
    const send = vi.fn();
    const reporter = createPhonePerfReporter({
      currentSessionId: 'session-1',
      now: () => nowMs,
      send,
    });

    reporter.record('bootstrap_start', { phase: 'challenge' });
    nowMs = 1_125;
    reporter.record('scan_start', { phase: 'challenge' });
    nowMs = 2_900;
    reporter.record('attest_done', { verdict: 'complete' });

    expect(reporter.flush('complete', { sessionId: 'session-1' })).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      version: 1,
      reason: 'complete',
      elapsedMs: 1_900,
      sessionId: 'session-1',
      events: [
        { event: 'bootstrap_start', elapsedMs: 0, phase: 'challenge' },
        { event: 'scan_start', elapsedMs: 125, phase: 'challenge' },
        { event: 'attest_done', elapsedMs: 1_900, verdict: 'complete' },
      ],
    });

    expect(reporter.flush('pagehide')).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('carries token redemption events across navigation into the final batch', () => {
    const storage = new MemoryStorage();
    let nowMs = 10_000;
    const firstSend = vi.fn();
    const tokenReporter = createPhonePerfReporter({
      currentSessionId: null,
      now: () => nowMs,
      send: firstSend,
      storage,
    });

    tokenReporter.record('token_redeem_start');
    nowMs = 10_180;
    tokenReporter.record('token_redeem_done');
    expect(tokenReporter.handoff('session-2')).toBe(true);
    expect(tokenReporter.flush('pagehide')).toBe(false);
    expect(firstSend).not.toHaveBeenCalled();

    nowMs = 10_250;
    const finalSend = vi.fn();
    const pairReporter = createPhonePerfReporter({
      currentSessionId: 'session-2',
      now: () => nowMs,
      send: finalSend,
      storage,
    });
    pairReporter.record('bootstrap_start');
    nowMs = 12_000;
    pairReporter.record('attest_done', { verdict: 'complete' });
    pairReporter.flush('complete', { sessionId: 'session-2' });

    expect(finalSend).toHaveBeenCalledTimes(1);
    expect(finalSend.mock.calls[0]?.[0]).toMatchObject({
      elapsedMs: 2_000,
      sessionId: 'session-2',
      events: [
        { event: 'token_redeem_start', elapsedMs: 0 },
        { event: 'token_redeem_done', elapsedMs: 180 },
        { event: 'bootstrap_start', elapsedMs: 250 },
        { event: 'attest_done', elapsedMs: 2_000, verdict: 'complete' },
      ],
    });
  });

  it('discards stale or session-mismatched handoffs', () => {
    const storage = new MemoryStorage();
    let nowMs = 1_000;
    const source = createPhonePerfReporter({
      currentSessionId: null,
      now: () => nowMs,
      send: vi.fn(),
      storage,
    });
    source.record('token_redeem_start');
    source.handoff('expected-session');

    nowMs += 5 * 60_000 + 1;
    const send = vi.fn();
    const destination = createPhonePerfReporter({
      currentSessionId: 'different-session',
      now: () => nowMs,
      send,
      storage,
    });
    destination.record('bootstrap_start');
    destination.flush('complete');

    expect(send.mock.calls[0]?.[0]).toMatchObject({
      elapsedMs: 0,
      events: [{ event: 'bootstrap_start', elapsedMs: 0 }],
    });
  });

  it('bounds the number of buffered events', () => {
    const send = vi.fn();
    const reporter = createPhonePerfReporter({
      currentSessionId: 'session-3',
      now: () => 1_000,
      send,
      maxEvents: 3,
    });

    reporter.record('one');
    reporter.record('two');
    reporter.record('three');
    reporter.record('four');
    reporter.flush('complete');

    expect(send.mock.calls[0]?.[0].events).toHaveLength(3);
  });
});
