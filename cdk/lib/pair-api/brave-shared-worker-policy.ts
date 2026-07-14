import {
  INDIVIDUAL_SCORE_LIMIT,
  isProjectionFresh,
  type ClassifiedScan,
  type MerchantProjection,
} from './projection-verdict';

export interface BraveSharedWorkerPolicyInput {
  hostProjection: MerchantProjection | null;
  hostScan: ClassifiedScan | null;
  iframeProjection: MerchantProjection | null;
  iframeScan: ClassifiedScan | null;
}

export interface BraveSharedWorkerPolicyResult {
  effectiveIframeScan: ClassifiedScan | null;
  annotations: Record<string, unknown>;
}

function hasSafeScores(iframeProjection: MerchantProjection): boolean {
  const iframeEvidence = iframeProjection.worker_scope_evidence;
  if (!iframeEvidence) return false;
  return (
    (iframeProjection.device_tampering ?? 0) >= INDIVIDUAL_SCORE_LIMIT &&
    (iframeProjection.automation ?? 0) < INDIVIDUAL_SCORE_LIMIT &&
    (iframeProjection.network_tampering ?? 0) < INDIVIDUAL_SCORE_LIMIT &&
    iframeEvidence.device_tampering_without_worker < INDIVIDUAL_SCORE_LIMIT
  );
}

function qualifies(input: BraveSharedWorkerPolicyInput): boolean {
  const { iframeProjection, iframeScan } = input;
  const evidence = iframeProjection?.worker_scope_evidence;
  if (!iframeProjection || !iframeScan || !evidence) return false;
  return (
    isProjectionFresh(iframeProjection) &&
    evidence.brave_detected &&
    evidence.shared_partition_candidate &&
    !!evidence.main_web_consensus_id &&
    hasSafeScores(iframeProjection)
  );
}

/**
 * Remove only Brave's demonstrated cross-origin SharedWorker partition artifact.
 * API evidence must positively identify Brave, restrict every divergence to the
 * allowlisted SharedWorker fields, and preserve a main/dedicated-worker consensus.
 * Raw API scores remain in annotations; every other Pair verdict rule is unchanged.
 */
export function applyBraveSharedWorkerPolicy(
  input: BraveSharedWorkerPolicyInput
): BraveSharedWorkerPolicyResult {
  if (!qualifies(input) || !input.iframeProjection || !input.iframeScan) {
    return {
      effectiveIframeScan: input.iframeScan,
      annotations: { brave_shared_worker_adjusted: false },
    };
  }

  const iframeEvidence = input.iframeProjection.worker_scope_evidence!;
  const effectiveScore = Math.max(
    input.iframeProjection.automation ?? 0,
    iframeEvidence.device_tampering_without_worker,
    input.iframeProjection.network_tampering ?? 0
  );
  return {
    effectiveIframeScan: {
      ...input.iframeScan,
      individualScore: effectiveScore,
      ok: effectiveScore < INDIVIDUAL_SCORE_LIMIT,
    },
    annotations: {
      brave_shared_worker_adjusted: true,
      brave_shared_worker_basis: 'inner_main_web_consensus',
      iframe_raw_score: input.iframeScan.individualScore,
      iframe_effective_score: effectiveScore,
    },
  };
}
