export type MobileClass = 'phone' | 'tablet' | 'desktop' | 'unknown';

export interface WebRtcSummary {
  present: boolean;
  candidateTypes?: string[];
  udpSupported?: boolean;
  mdnsHostCandidate?: boolean;
}

export interface HostedRedirectObservation {
  argusSessionId: string;
  osFamily: string;
  osVersionMajor?: number;
  browserFamily: string;
  browserVersionMajor?: number;
  mobileClass: MobileClass;
  userAgentPlatform?: string;
  touchPoints?: number;
  screenBucket?: string;
  timezone?: string;
  localePrimary?: string;
  ip?: string;
  asn?: string;
  webRtc?: WebRtcSummary;
}

export interface HostedRedirectContinuityInput {
  merchant: HostedRedirectObservation;
  hosted: HostedRedirectObservation;
}

export interface HostedRedirectContinuityResult {
  ok: boolean;
  reasons: string[];
  warnings: string[];
}

const SUPPORTED_PHONE_OS = new Set(['ios', 'android']);

function norm(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function candidates(value: WebRtcSummary | undefined): Set<string> {
  return new Set((value?.candidateTypes ?? []).map(norm).filter(Boolean));
}

function hasCandidateDrift(left: WebRtcSummary, right: WebRtcSummary): boolean {
  const a = candidates(left);
  const b = candidates(right);
  if (a.size !== b.size) return true;
  for (const item of a) {
    if (!b.has(item)) return true;
  }
  return false;
}

function pushIfDrift<T>(
  reasons: string[],
  left: T | undefined,
  right: T | undefined,
  reason: string
): void {
  if (left === undefined || right === undefined) {
    reasons.push(`${reason}_missing`);
    return;
  }
  if (left !== right) reasons.push(reason);
}

function validatePhoneLeg(
  label: 'merchant' | 'hosted',
  obs: HostedRedirectObservation,
  reasons: string[]
): void {
  if (obs.mobileClass !== 'phone') {
    reasons.push(`${label}_not_supported_phone`);
  }
  if (!SUPPORTED_PHONE_OS.has(norm(obs.osFamily))) {
    reasons.push(`${label}_unsupported_phone_os`);
  }
  if (!obs.webRtc?.present) {
    reasons.push(`${label}_webrtc_missing`);
  }
  if ((obs.touchPoints ?? 0) <= 0) {
    reasons.push(`${label}_touch_missing`);
  }
}

export function evaluateHostedRedirectContinuity(
  input: HostedRedirectContinuityInput
): HostedRedirectContinuityResult {
  const reasons: string[] = [];
  const warnings: string[] = [];
  const { merchant, hosted } = input;

  validatePhoneLeg('merchant', merchant, reasons);
  validatePhoneLeg('hosted', hosted, reasons);

  pushIfDrift(reasons, norm(merchant.osFamily), norm(hosted.osFamily), 'os_family_drift');
  pushIfDrift(reasons, merchant.osVersionMajor, hosted.osVersionMajor, 'os_version_major_drift');
  pushIfDrift(
    reasons,
    norm(merchant.browserFamily),
    norm(hosted.browserFamily),
    'browser_family_drift'
  );
  pushIfDrift(
    reasons,
    merchant.browserVersionMajor,
    hosted.browserVersionMajor,
    'browser_version_major_drift'
  );
  pushIfDrift(
    reasons,
    norm(merchant.userAgentPlatform),
    norm(hosted.userAgentPlatform),
    'ua_platform_drift'
  );
  pushIfDrift(reasons, merchant.screenBucket, hosted.screenBucket, 'screen_bucket_drift');
  pushIfDrift(reasons, merchant.timezone, hosted.timezone, 'timezone_drift');
  pushIfDrift(reasons, merchant.localePrimary, hosted.localePrimary, 'locale_drift');

  if (merchant.webRtc?.present && hosted.webRtc?.present) {
    if (hasCandidateDrift(merchant.webRtc, hosted.webRtc)) {
      reasons.push('webrtc_candidate_type_drift');
    }
    if (merchant.webRtc.udpSupported !== hosted.webRtc.udpSupported) {
      reasons.push('webrtc_udp_drift');
    }
    if (merchant.webRtc.mdnsHostCandidate !== hosted.webRtc.mdnsHostCandidate) {
      reasons.push('webrtc_mdns_drift');
    }
  }

  if (merchant.ip && hosted.ip && merchant.ip !== hosted.ip) warnings.push('ip_drift');
  if (merchant.asn && hosted.asn && merchant.asn !== hosted.asn) warnings.push('asn_drift');

  return { ok: reasons.length === 0, reasons, warnings };
}
