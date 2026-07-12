import { describe, expect, it } from 'vitest';
import { evaluateSsoProofPolicy } from '../cdk/lib/pair-api/sso-assurance';

describe('SSO proof policy', () => {
  it('allows integrity-only sessions without proof', () => {
    expect(
      evaluateSsoProofPolicy(
        { proofRequired: false, freshProofRequired: false },
        { proofSatisfied: false, usedDeviceTrust: false }
      )
    ).toEqual({ ok: true });
  });

  it('allows step-up sessions with cached device trust', () => {
    expect(
      evaluateSsoProofPolicy(
        { proofRequired: true, freshProofRequired: false },
        { proofSatisfied: true, usedDeviceTrust: true }
      )
    ).toEqual({ ok: true });
  });

  it('requires proof for step-up sessions', () => {
    expect(
      evaluateSsoProofPolicy(
        { proofRequired: true, freshProofRequired: false },
        { proofSatisfied: false, usedDeviceTrust: false }
      )
    ).toEqual({ ok: false, reason: 'proof_of_life_required' });
  });

  it('rejects cached device trust when fresh auth is required', () => {
    expect(
      evaluateSsoProofPolicy(
        { proofRequired: true, freshProofRequired: true },
        { proofSatisfied: true, usedDeviceTrust: true }
      )
    ).toEqual({ ok: false, reason: 'fresh_proof_required' });
  });

  it('accepts fresh proof for forceauth sessions', () => {
    expect(
      evaluateSsoProofPolicy(
        { proofRequired: true, freshProofRequired: true },
        { proofSatisfied: true, usedDeviceTrust: false }
      )
    ).toEqual({ ok: true });
  });
});
