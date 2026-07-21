/**
 * Desktop verdict-gate unit contract.
 *
 * Attacker model: the phone may delay or omit its DONE message, but it cannot
 * choose the server verdict. Pair must withhold both passing and failing
 * verdicts while the drawing challenge is visible so result timing is not an
 * oracle, then release the already-server-owned verdict on DONE or the cap.
 */
import { describe, expect, it, vi } from 'vitest';
import { createDesktopVerdictGate, type DesktopVerdict } from '../src/lib/desktop-verdict-gate.ts';
import { encodeVerdictRevealKey, sealFixedVerdictEnvelope } from '../src/lib/verdict-envelope';

const revealKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const paired: DesktopVerdict = {
  verdict: 'paired',
  reason: null,
  annotations: { clean: true },
};

describe('desktop verdict gate', () => {
  it('settles immediately when the phone is not in a challenge', async () => {
    const gate = createDesktopVerdictGate('session-1');

    gate.settle(paired);

    await expect(gate.result).resolves.toEqual(paired);
    expect(gate.isSettled()).toBe(true);
  });

  it('holds the first server verdict until the phone finishes', async () => {
    const gate = createDesktopVerdictGate('session-1');
    gate.notePhoneChallenge(true);

    gate.settle(paired);
    gate.settle({ verdict: 'failed', reason: 'late', annotations: {} });

    expect(gate.hasHeldVerdict()).toBe(true);
    gate.releaseHeldVerdict();
    await expect(gate.result).resolves.toEqual(paired);
  });

  it('releases a held verdict when the safety cap expires', async () => {
    vi.useFakeTimers();
    try {
      const gate = createDesktopVerdictGate('session-1');
      gate.notePhoneChallenge(true);
      gate.settle(paired);

      await vi.advanceTimersByTimeAsync(90_000);

      await expect(gate.result).resolves.toEqual(paired);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['envelope-first', 'key-first'] as const)(
    'opens a sealed server verdict when both parts arrive: %s',
    async (order) => {
      const gate = createDesktopVerdictGate('session-1');
      const envelope = await sealFixedVerdictEnvelope(revealKey, 'session-1', {
        kind: 'desktop-verdict',
        ...paired,
      });

      if (order === 'envelope-first') {
        await gate.receiveSealedVerdict(envelope);
        await gate.receiveRevealKey(encodeVerdictRevealKey(revealKey));
      } else {
        await gate.receiveRevealKey(encodeVerdictRevealKey(revealKey));
        await gate.receiveSealedVerdict(envelope);
      }

      await expect(gate.result).resolves.toEqual(paired);
    }
  );

  it('rejects the result when sealed verdict opening fails', async () => {
    const gate = createDesktopVerdictGate('session-1');
    const envelope = await sealFixedVerdictEnvelope(revealKey, 'another-session', {
      kind: 'desktop-verdict',
      ...paired,
    });

    await gate.receiveSealedVerdict(envelope);
    await gate.receiveRevealKey(encodeVerdictRevealKey(revealKey));

    await expect(gate.result).rejects.toBeInstanceOf(Error);
    expect(gate.isSettled()).toBe(true);
  });
});
