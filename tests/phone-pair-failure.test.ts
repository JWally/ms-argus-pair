import { describe, expect, it } from 'vitest';
import { decidePhonePairFailure } from '../src/lib/phone-pair-failure';

describe('phone pair failure policy', () => {
  it('expires silent trust back to explicit proof choices', () => {
    expect(
      decidePhonePairFailure(new Error('stale token'), {
        proofMode: 'passkey',
        keepDrawingBoard: true,
      })
    ).toEqual({
      phase: 'ready',
      errorMessage: 'Trusted device expired. Choose a check.',
      resetTrust: true,
      clearStatus: true,
    });
  });

  it('returns interactive passkey failures to the proof menu', () => {
    expect(
      decidePhonePairFailure(new Error('cancelled'), {
        proofMode: 'passkey-create',
        keepDrawingBoard: false,
      })
    ).toEqual({
      phase: 'ready',
      errorMessage: 'cancelled',
      resetTrust: false,
      clearStatus: false,
    });
  });

  it('distinguishes a session claimed by another phone', () => {
    expect(
      decidePhonePairFailure('session_paired_with_other_device', {
        proofMode: 'integrity',
        keepDrawingBoard: false,
      }).phase
    ).toBe('taken');
  });
});
