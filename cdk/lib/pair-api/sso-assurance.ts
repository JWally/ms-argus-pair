export interface SsoProofPolicy {
  proofRequired: boolean;
  freshProofRequired: boolean;
}

export interface SsoProofEvidence {
  proofSatisfied: boolean;
  usedDeviceTrust: boolean;
}

export type SsoProofDecision =
  | { ok: true }
  | { ok: false; reason: 'proof_of_life_required' | 'fresh_proof_required' };

/** Apply the server-snapshotted SSO assurance policy to the submitted proof. */
export function evaluateSsoProofPolicy(
  policy: SsoProofPolicy,
  evidence: SsoProofEvidence
): SsoProofDecision {
  if (policy.freshProofRequired && evidence.usedDeviceTrust) {
    return { ok: false, reason: 'fresh_proof_required' };
  }
  if (policy.proofRequired && !evidence.proofSatisfied) {
    return { ok: false, reason: 'proof_of_life_required' };
  }
  return { ok: true };
}
