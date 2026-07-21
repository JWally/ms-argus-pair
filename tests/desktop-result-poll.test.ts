/**
 * Desktop result-poll fallback contract.
 *
 * The authenticated WebSocket push remains primary. Polling begins only after
 * the phone appears or the desktop socket disconnects, accepts server-owned
 * verdict material, and must stop on cancellation or terminal HTTP responses.
 */
import { describe, expect, it, vi } from 'vitest';
import { createDesktopResultPoll } from '../src/lib/desktop-result-poll.ts';
import type { DesktopVerdict, DesktopVerdictGate } from '../src/lib/desktop-verdict-gate.ts';

type PollGate = Pick<
  DesktopVerdictGate,
  'isSettled' | 'hasHeldVerdict' | 'settle' | 'receiveSealedVerdict' | 'receiveRevealKey'
>;

function response(status: number, body: unknown = {}): Pick<Response, 'status' | 'json'> {
  return { status, json: async () => body };
}

function gate(): PollGate {
  return {
    isSettled: vi.fn(() => false),
    hasHeldVerdict: vi.fn(() => false),
    settle: vi.fn(),
    receiveSealedVerdict: vi.fn(async () => {}),
    receiveRevealKey: vi.fn(async () => {}),
  };
}

function pollOptions(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'session-1',
    desktopToken: 'desk+/token',
    gate: gate(),
    isCancelled: () => false,
    fetchResult: vi.fn(async () => response(401)),
    wait: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('desktop result poll', () => {
  it('authenticates the fallback request and settles a plaintext rolling-deploy verdict', async () => {
    const verdict: DesktopVerdict = { verdict: 'paired', reason: null, annotations: {} };
    const resultGate = gate();
    const fetchResult = vi.fn(async () => response(200, verdict));
    const poll = createDesktopResultPoll(pollOptions({ gate: resultGate, fetchResult }));

    await poll.start(0);

    const encodedDesktopToken = encodeURIComponent('desk+/token');
    expect(fetchResult).toHaveBeenCalledWith(
      `/api/session/session-1/result?t=${encodedDesktopToken}`,
      { headers: { accept: 'application/json' } }
    );
    expect(resultGate.settle).toHaveBeenCalledWith(verdict);
  });

  it('backs a pending response off and stops on a terminal HTTP status', async () => {
    const waits: number[] = [];
    const fetchResult = vi
      .fn()
      .mockResolvedValueOnce(response(204))
      .mockResolvedValueOnce(response(401));
    const poll = createDesktopResultPoll(
      pollOptions({
        fetchResult,
        wait: async (delayMs: number) => {
          waits.push(delayMs);
        },
      })
    );

    await poll.start(100);

    expect(waits).toEqual([100, 2_000]);
    expect(fetchResult).toHaveBeenCalledTimes(2);
  });

  it('retries a transient network failure', async () => {
    const waits: number[] = [];
    const verdict = { verdict: 'failed', reason: 'projection_missing' };
    const resultGate = gate();
    const fetchResult = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(response(200, verdict));
    const poll = createDesktopResultPoll(
      pollOptions({
        gate: resultGate,
        fetchResult,
        wait: async (delayMs: number) => {
          waits.push(delayMs);
        },
      })
    );

    await poll.start(0);

    expect(waits).toEqual([0, 2_000]);
    expect(resultGate.settle).toHaveBeenCalledWith(verdict);
  });
});

describe('desktop sealed result polling', () => {
  it('polls tightly after sealed ciphertext while waiting for release', async () => {
    const waits: number[] = [];
    const resultGate = gate();
    const envelope = { iv: 'iv', ciphertext: 'ciphertext' };
    const fetchResult = vi
      .fn()
      .mockResolvedValueOnce(response(200, { status: 'sealed', envelope }))
      .mockResolvedValueOnce(response(204))
      .mockResolvedValueOnce(response(403));
    const poll = createDesktopResultPoll(
      pollOptions({
        gate: resultGate,
        fetchResult,
        wait: async (delayMs: number) => {
          waits.push(delayMs);
        },
      })
    );

    await poll.start(0);

    expect(resultGate.receiveSealedVerdict).toHaveBeenCalledWith(envelope);
    expect(waits).toEqual([0, 500, 2_000]);
  });

  it('forwards an inline reveal key and stops when the gate settles', async () => {
    let settled = false;
    const resultGate = gate();
    vi.mocked(resultGate.isSettled).mockImplementation(() => settled);
    vi.mocked(resultGate.receiveRevealKey).mockImplementation(async () => {
      settled = true;
    });
    const fetchResult = vi.fn(async () =>
      response(200, {
        status: 'sealed',
        envelope: { iv: 'iv', ciphertext: 'ciphertext' },
        revealKey: 'release-key',
      })
    );
    const poll = createDesktopResultPoll(pollOptions({ gate: resultGate, fetchResult }));

    await poll.start(0);

    expect(resultGate.receiveRevealKey).toHaveBeenCalledWith('release-key');
    expect(fetchResult).toHaveBeenCalledOnce();
  });

  it('does not fetch after cancellation and starts at most once', async () => {
    let cancelled = false;
    const fetchResult = vi.fn(async () => response(401));
    const poll = createDesktopResultPoll(
      pollOptions({
        fetchResult,
        isCancelled: () => cancelled,
        wait: async () => {
          cancelled = true;
        },
      })
    );

    const first = poll.start(0);
    const second = poll.start(20_000);
    await Promise.all([first, second]);

    expect(second).toBe(first);
    expect(fetchResult).not.toHaveBeenCalled();
  });
});
