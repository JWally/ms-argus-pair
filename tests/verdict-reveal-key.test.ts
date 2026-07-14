import { describe, expect, it } from 'vitest';
import { deriveVerdictRevealKeyFromRoot } from '../cdk/lib/ws-handler';

describe('verdict reveal key derivation', () => {
  it('is deterministic, 256-bit, and bound to one Pair session', () => {
    const root = Buffer.alloc(64, 7);
    const first = deriveVerdictRevealKeyFromRoot(root, 'session-a');
    const retry = deriveVerdictRevealKeyFromRoot(root, 'session-a');
    const otherSession = deriveVerdictRevealKeyFromRoot(root, 'session-b');

    expect(first).toHaveLength(32);
    expect(first).toEqual(retry);
    expect(first).not.toEqual(otherSession);
  });
});
