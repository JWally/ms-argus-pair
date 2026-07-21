import {
  classifyScan,
  isProjectionFresh,
  projectionAgeSeconds,
  type ClassifiedScan,
} from './projection-verdict';
import type { MerchantProjection } from './merchant-projection';
import { fetchProjection, projectionValue } from './projection-client';
import { applyBraveSharedWorkerPolicy } from './brave-shared-worker-policy';

export interface HostPreflightEvidenceInput {
  bound: boolean;
  hostProjection: MerchantProjection | null;
  hostScan: ClassifiedScan | null;
  iframeProjection: MerchantProjection | null;
  iframeScan: ClassifiedScan | null;
}

function sameLabel(a: string | null, b: string | null): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

/**
 * Build observational annotations only. Keeping this function verdict-free is
 * deliberate: a clean merchant realm may corroborate the iframe, but it must
 * never erase a hard integrity failure measured inside the isolated embed.
 */
export function buildHostPreflightEvidence(
  input: HostPreflightEvidenceInput
): Record<string, unknown> {
  if (!input.bound) return { host_preflight_bound: false };

  const evidence: Record<string, unknown> = {
    host_preflight_bound: true,
    host_projection_present: !!input.hostProjection,
    host_projection_fresh: isProjectionFresh(input.hostProjection),
    host_projection_age_sec: projectionAgeSeconds(input.hostProjection),
  };
  if (input.hostProjection) {
    evidence.host_automation = input.hostProjection.automation;
    evidence.host_device_tampering = input.hostProjection.device_tampering;
    evidence.host_network_tampering = input.hostProjection.network_tampering;
  }
  if (input.iframeProjection) {
    evidence.iframe_automation = input.iframeProjection.automation;
    evidence.iframe_device_tampering = input.iframeProjection.device_tampering;
    evidence.iframe_network_tampering = input.iframeProjection.network_tampering;
  }
  if (input.hostScan) evidence.host_score = input.hostScan.individualScore;
  if (input.iframeScan) evidence.iframe_score = input.iframeScan.individualScore;
  if (input.hostScan && input.iframeScan) {
    evidence.host_iframe_ip_match =
      !!input.hostScan.ip && input.hostScan.ip === input.iframeScan.ip;
    evidence.host_iframe_browser_match = sameLabel(
      input.hostScan.browserName,
      input.iframeScan.browserName
    );
    evidence.host_iframe_os_match = sameLabel(input.hostScan.os, input.iframeScan.os);
  }
  return evidence;
}

export async function collectHostPreflightEvidence(input: {
  hostArgusSessionId: string | null;
  iframeArgusSessionId: string;
  pairSessionId: string;
}): Promise<{
  iframeProjection: MerchantProjection | null;
  iframeScan: ClassifiedScan | null;
  annotations: Record<string, unknown>;
}> {
  const [hostProjectionResult, iframeProjectionResult] = await Promise.all([
    input.hostArgusSessionId ? fetchProjection(input.hostArgusSessionId) : Promise.resolve(null),
    fetchProjection(input.iframeArgusSessionId),
  ]);
  const hostProjection = hostProjectionResult ? projectionValue(hostProjectionResult) : null;
  const iframeProjection = projectionValue(iframeProjectionResult);
  const hostScan = classifyScan(hostProjection, 'host');
  const rawIframeScan = classifyScan(iframeProjection, 'desktop');
  const observations = buildHostPreflightEvidence({
    bound: !!input.hostArgusSessionId,
    hostProjection,
    hostScan,
    iframeProjection,
    iframeScan: rawIframeScan,
  });
  const policy = applyBraveSharedWorkerPolicy({
    hostProjection,
    hostScan,
    iframeProjection,
    iframeScan: rawIframeScan,
  });
  const annotations: Record<string, unknown> = {
    ...observations,
    host_projection_failure:
      hostProjectionResult && !hostProjectionResult.ok ? hostProjectionResult.reason : null,
    iframe_projection_failure: !iframeProjectionResult.ok ? iframeProjectionResult.reason : null,
    ...policy.annotations,
  };
  if (input.hostArgusSessionId) {
    console.info(
      `[pair] host-preflight pairSession=${input.pairSessionId} ` +
        `hostSid=${input.hostArgusSessionId} iframeSid=${input.iframeArgusSessionId} ` +
        `hostScore=${hostScan?.individualScore ?? 'missing'} ` +
        `iframeScore=${rawIframeScan?.individualScore ?? 'missing'} ` +
        `effectiveIframeScore=${policy.effectiveIframeScan?.individualScore ?? 'missing'} ` +
        `ipMatch=${String(annotations.host_iframe_ip_match ?? 'unknown')}`
    );
  }
  return {
    iframeProjection,
    iframeScan: policy.effectiveIframeScan,
    annotations,
  };
}
