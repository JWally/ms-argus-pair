import {
  classifyScan,
  isProjectionFresh,
  projectionAgeSeconds,
  type ClassifiedScan,
  type MerchantProjection,
} from './projection-verdict';
import { fetchProjection } from './projection-client';
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
    evidence.host_automation = input.hostProjection.automation ?? 0;
    evidence.host_device_tampering = input.hostProjection.device_tampering ?? 0;
    evidence.host_network_tampering = input.hostProjection.network_tampering ?? 0;
  }
  if (input.iframeProjection) {
    evidence.iframe_automation = input.iframeProjection.automation ?? 0;
    evidence.iframe_device_tampering = input.iframeProjection.device_tampering ?? 0;
    evidence.iframe_network_tampering = input.iframeProjection.network_tampering ?? 0;
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
  const [hostProjection, iframeProjection] = await Promise.all([
    input.hostArgusSessionId ? fetchProjection(input.hostArgusSessionId) : Promise.resolve(null),
    fetchProjection(input.iframeArgusSessionId),
  ]);
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
  const annotations = { ...observations, ...policy.annotations };
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
