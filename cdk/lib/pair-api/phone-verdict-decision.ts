import type { MerchantProjection } from './merchant-projection';
import {
  computeVerdict,
  isProjectionFresh,
  projectionAgeSeconds,
  PROJECTION_FRESHNESS_WINDOW_SECONDS,
  type ClassifiedScan,
} from './projection-verdict';
import { isProofOfLifeSatisfied, type ProofOfLifeAnnotations } from './proof-of-life';

export interface PhoneVerdictDecisionInput {
  proofRequired: boolean;
  proofAnnotations: ProofOfLifeAnnotations;
  desktopProjection: MerchantProjection | null;
  phoneProjection: MerchantProjection | null;
  desktopScan: ClassifiedScan | null;
  phoneScan: ClassifiedScan | null;
  hostAnnotations: Record<string, unknown>;
}

export interface PhoneVerdictDecision {
  verdict: 'paired' | 'failed';
  reason: string;
  annotations: Record<string, unknown>;
  proofOfLife: boolean;
}

/** Decide the pair result from already-verified proof and projection inputs. */
export function decidePhoneVerdict(input: PhoneVerdictDecisionInput): PhoneVerdictDecision {
  const proofOfLife = isProofOfLifeSatisfied(input.proofAnnotations);
  let verdict: PhoneVerdictDecision['verdict'];
  let reason: string;
  let annotations: Record<string, unknown>;

  if (input.proofRequired && !proofOfLife) {
    verdict = 'failed';
    reason = 'no_proof_of_life';
    annotations = {
      desktop_projection_present: !!input.desktopProjection,
      phone_projection_present: !!input.phoneProjection,
      ...input.proofAnnotations,
    };
  } else if (!input.desktopScan || !input.phoneScan) {
    // Missing projections must fail closed. Otherwise callers could choose
    // nonexistent scan IDs and bypass the integrity score policy entirely.
    verdict = 'failed';
    reason = 'projection_lookup_failed';
    annotations = {
      score_lookup_skipped: true,
      desktop_projection_present: !!input.desktopProjection,
      phone_projection_present: !!input.phoneProjection,
      ...input.proofAnnotations,
    };
  } else if (
    !isProjectionFresh(input.desktopProjection) ||
    !isProjectionFresh(input.phoneProjection)
  ) {
    // Freshness is a secondary defense behind the single-use scan ledger.
    verdict = 'failed';
    reason = 'projection_stale';
    annotations = {
      desktop_projection_age_sec: projectionAgeSeconds(input.desktopProjection),
      phone_projection_age_sec: projectionAgeSeconds(input.phoneProjection),
      freshness_window_sec: PROJECTION_FRESHNESS_WINDOW_SECONDS,
      ...input.proofAnnotations,
    };
  } else {
    const computed = computeVerdict(input.desktopScan, input.phoneScan);
    verdict = computed.verdict;
    reason = computed.reason;
    annotations = {
      ...computed.annotations,
      ...input.proofAnnotations,
      proof_of_life: proofOfLife,
    };
  }

  return {
    verdict,
    reason,
    proofOfLife,
    annotations: { ...annotations, ...input.hostAnnotations },
  };
}
