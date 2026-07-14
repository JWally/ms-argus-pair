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

function sameLabel(left: string | null, right: string | null): boolean {
  return !!left && !!right && left.toLowerCase() === right.toLowerCase();
}

function axesBelowLimit(projection: MerchantProjection): boolean {
  return (
    (projection.automation ?? 0) < INDIVIDUAL_SCORE_LIMIT &&
    (projection.device_tampering ?? 0) < INDIVIDUAL_SCORE_LIMIT &&
    (projection.network_tampering ?? 0) < INDIVIDUAL_SCORE_LIMIT
  );
}

function hasNetworkContinuity(hostScan: ClassifiedScan, iframeScan: ClassifiedScan): boolean {
  return (
    !!hostScan.ip &&
    hostScan.ip === iframeScan.ip &&
    !hostScan.isProxy &&
    !iframeScan.isProxy &&
    !hostScan.isDatacenter &&
    !iframeScan.isDatacenter &&
    !hostScan.isVpn &&
    !iframeScan.isVpn
  );
}

function hasWorkerEvidenceContinuity(
  hostProjection: MerchantProjection,
  iframeProjection: MerchantProjection
): boolean {
  const hostEvidence = hostProjection.worker_scope_evidence;
  const iframeEvidence = iframeProjection.worker_scope_evidence;
  if (!hostEvidence || !iframeEvidence) return false;
  return (
    hostEvidence.all_scopes_consistent &&
    iframeEvidence.shared_partition_candidate &&
    hostEvidence.brave_detected &&
    iframeEvidence.brave_detected &&
    !!hostEvidence.main_web_consensus_id &&
    hostEvidence.main_web_consensus_id === iframeEvidence.main_web_consensus_id
  );
}

function hasSafeScores(
  hostProjection: MerchantProjection,
  iframeProjection: MerchantProjection
): boolean {
  const iframeEvidence = iframeProjection.worker_scope_evidence;
  if (!iframeEvidence || !axesBelowLimit(hostProjection)) return false;
  return (
    (iframeProjection.device_tampering ?? 0) >= INDIVIDUAL_SCORE_LIMIT &&
    (iframeProjection.automation ?? 0) < INDIVIDUAL_SCORE_LIMIT &&
    (iframeProjection.network_tampering ?? 0) < INDIVIDUAL_SCORE_LIMIT &&
    iframeEvidence.device_tampering_without_worker < INDIVIDUAL_SCORE_LIMIT
  );
}

function hasBrowserContinuity(hostScan: ClassifiedScan, iframeScan: ClassifiedScan): boolean {
  return (
    hasNetworkContinuity(hostScan, iframeScan) &&
    sameLabel(hostScan.browserName, iframeScan.browserName) &&
    sameLabel(hostScan.os, iframeScan.os)
  );
}

function qualifies(input: BraveSharedWorkerPolicyInput): boolean {
  const { hostProjection, hostScan, iframeProjection, iframeScan } = input;
  if (!hostProjection || !hostScan || !iframeProjection || !iframeScan) return false;
  return (
    isProjectionFresh(hostProjection) &&
    isProjectionFresh(iframeProjection) &&
    hasWorkerEvidenceContinuity(hostProjection, iframeProjection) &&
    hasSafeScores(hostProjection, iframeProjection) &&
    hasBrowserContinuity(hostScan, iframeScan)
  );
}

/**
 * Remove only Brave's demonstrated cross-origin SharedWorker partition artifact.
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
      iframe_raw_score: input.iframeScan.individualScore,
      iframe_effective_score: effectiveScore,
    },
  };
}
