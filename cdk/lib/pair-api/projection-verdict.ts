import type { MerchantProjection } from './merchant-projection';

// Verdict thresholds (per spec). Individual = max(automation, device_tampering,
// network_tampering) for one side. Total = sum of the two sides' individual
// scores.
export const INDIVIDUAL_SCORE_LIMIT = 30;
const LOCATION_MISMATCH_SCORE = 35;
const LOCATION_MISMATCH_SCORE_LIMIT = 40;
const TOTAL_SCORE_LIMIT = 50;

// These tags are diagnostic companions, not independent risk signals. Any
// unknown or security-bearing tag keeps the ordinary fail-closed threshold.
const ISOLATED_LOCATION_MISMATCH_TAGS = new Set([
  'apple_attestation_missing',
  'apple_attested',
  'cellular',
  'incognito',
  'location_mismatch',
]);

export const PROJECTION_FRESHNESS_WINDOW_SECONDS = 180;

type PairVerdict = 'paired' | 'failed';

export interface ClassifiedScan {
  individualScore: number;
  isPhone: boolean;
  isDatacenter: boolean;
  isProxy: boolean;
  patAttested: boolean;
  browserName: string | null;
  browserVersion: string | null;
  os: string | null;
  ip: string | null;
  ua: string | null;
  asnName: string | null;
  city: string | null;
  country: string | null;
  isMobileNetwork: boolean;
  isVpn: boolean;
  isIsolatedLocationMismatch: boolean;
}

export interface VerdictResult {
  verdict: PairVerdict;
  reason: string;
  annotations: Record<string, unknown>;
}

export interface DesktopScanSummary {
  clean: boolean;
  summary: Record<string, unknown> | null;
}

interface BrowserSignals {
  details: MerchantProjection['identification']['browserDetails'];
  deviceLabel: string;
  os: string;
  ua: string;
}

interface NetworkSignals {
  asnName: string | null;
  city: string | null;
  country: string | null;
  isProxy: boolean;
  isDatacenter: boolean;
  isMobileNetwork: boolean;
  isVpn: boolean;
}

export function projectionAgeSeconds(p: MerchantProjection | null): number | null {
  if (!p) return null;
  return Math.round((Date.now() - p.created_at) / 1000);
}

export function isProjectionFresh(p: MerchantProjection | null): boolean {
  const age = projectionAgeSeconds(p);
  if (age === null) return false;
  return age >= -PROJECTION_FRESHNESS_WINDOW_SECONDS && age <= PROJECTION_FRESHNESS_WINDOW_SECONDS;
}

function hasTagLike(tags: string[], ...patterns: string[]): boolean {
  if (tags.length === 0) return false;
  const lc = tags.map((t) => String(t).toLowerCase());
  return patterns.some((p) => {
    const needle = p.toLowerCase();
    return lc.some((t) => t.includes(needle));
  });
}

function browserSignals(p: MerchantProjection): BrowserSignals {
  const details = p.identification.browserDetails;
  return {
    details,
    deviceLabel: String(details?.device ?? '').toLowerCase(),
    os: String(details?.os ?? '').toLowerCase(),
    ua: String(details?.userAgent ?? ''),
  };
}

function hasPhoneSignals(signals: BrowserSignals): boolean {
  const phoneSignals = [signals.deviceLabel, signals.os].some(
    (value) => value === 'mobile' || value === 'tablet' || value === 'phone'
  );
  const phoneOsRe = /\b(ios|ipados|android|iphone|ipod)\b/i;
  return (
    phoneSignals || phoneOsRe.test(signals.os) || /Mobile|Android|iPhone|iPad|iPod/.test(signals.ua)
  );
}

function networkSignals(p: MerchantProjection): NetworkSignals {
  const ipInfo = p.ipInfo;
  const ipLocation = p.ipLocation;
  return {
    asnName: ipInfo.asn.organization,
    city: ipLocation.city,
    country: ipLocation.country,
    isProxy: hasTagLike(p.tags, 'proxy') || ipInfo.hosting.result,
    isDatacenter:
      hasTagLike(p.tags, 'datacenter', 'hyperscaler', 'dc_asn') || ipInfo.datacenter.result,
    isMobileNetwork: ipInfo.mobile.result,
    isVpn: ipInfo.vpn.result,
  };
}

function isIsolatedLocationMismatch(p: MerchantProjection): boolean {
  const tags = p.tags.map((tag) => tag.toLowerCase());
  return (
    p.automation === 0 &&
    p.device_tampering === LOCATION_MISMATCH_SCORE &&
    p.network_tampering === 0 &&
    tags.includes('location_mismatch') &&
    tags.every((tag) => ISOLATED_LOCATION_MISMATCH_TAGS.has(tag))
  );
}

function isIndividualScoreAllowed(scan: ClassifiedScan): boolean {
  const limit = scan.isIsolatedLocationMismatch
    ? LOCATION_MISMATCH_SCORE_LIMIT
    : INDIVIDUAL_SCORE_LIMIT;
  return scan.individualScore < limit;
}

export function classifyScan(p: MerchantProjection | null, side: string): ClassifiedScan | null {
  if (!p) return null;
  const individualScore = Math.max(p.automation, p.device_tampering, p.network_tampering);

  const browser = browserSignals(p);
  const network = networkSignals(p);
  const isPhone = hasPhoneSignals(browser);
  const patAttested = hasTagLike(p.tags, 'apple_attested');
  const isolatedLocationMismatch = isIsolatedLocationMismatch(p);

  const browserName = browser.details.browserName;
  const browserVersion = browser.details.browserVersion;
  const osLabel = browser.details.os;

  console.log(
    `[pair] classifyScan side=${side} score=${individualScore} isPhone=${isPhone} isProxy=${network.isProxy} isDC=${network.isDatacenter} pat=${patAttested} verdict=${p.verdict} ` +
      `device=${JSON.stringify({
        deviceLabel: browser.deviceLabel,
        os: browser.os,
        ua: browser.ua.slice(0, 80),
      })} tags=${JSON.stringify(p.tags)}`
  );

  return {
    individualScore,
    isPhone,
    isDatacenter: network.isDatacenter,
    isProxy: network.isProxy,
    patAttested,
    browserName,
    browserVersion,
    os: osLabel,
    ip: p.ip,
    ua: browser.ua || null,
    asnName: network.asnName,
    city: network.city,
    country: network.country,
    isMobileNetwork: network.isMobileNetwork,
    isVpn: network.isVpn,
    isIsolatedLocationMismatch: isolatedLocationMismatch,
  };
}

export function summarizeDesktopScan(scan: ClassifiedScan | null): DesktopScanSummary {
  if (!scan) return { clean: false, summary: null };
  return {
    clean:
      scan.patAttested && !scan.isProxy && !scan.isDatacenter && isIndividualScoreAllowed(scan),
    summary: {
      score: scan.individualScore,
      pat_attested: scan.patAttested,
      is_proxy: scan.isProxy,
      is_datacenter: scan.isDatacenter,
      is_vpn: scan.isVpn,
      is_mobile_network: scan.isMobileNetwork,
      browser_name: scan.browserName,
      browser_version: scan.browserVersion,
      os: scan.os,
      ip: scan.ip,
      asn_name: scan.asnName,
      city: scan.city,
      country: scan.country,
    },
  };
}

export function computeVerdict(desktop: ClassifiedScan, phone: ClassifiedScan): VerdictResult {
  const annotations: Record<string, unknown> = {
    desktop_score: desktop.individualScore,
    phone_score: phone.individualScore,
    total_score: desktop.individualScore + phone.individualScore,
    pat_used_desktop: desktop.patAttested,
    pat_used_phone: phone.patAttested,
    desktop_is_phone: desktop.isPhone,
    phone_is_phone: phone.isPhone,
    desktop_dc_asn: desktop.isDatacenter,
    phone_dc_asn: phone.isDatacenter,
    phone_to_phone: desktop.isPhone && phone.isPhone,
    desktop_browser_name: desktop.browserName,
    desktop_browser_version: desktop.browserVersion,
    desktop_os: desktop.os,
    desktop_ip: desktop.ip,
    desktop_ua: desktop.ua,
    desktop_asn_name: desktop.asnName,
    desktop_city: desktop.city,
    desktop_country: desktop.country,
    desktop_is_mobile_network: desktop.isMobileNetwork,
    desktop_is_proxy: desktop.isProxy,
    desktop_is_vpn: desktop.isVpn,
    phone_browser_name: phone.browserName,
    phone_browser_version: phone.browserVersion,
    phone_os: phone.os,
    phone_ip: phone.ip,
    phone_ua: phone.ua,
    phone_asn_name: phone.asnName,
    phone_city: phone.city,
    phone_country: phone.country,
    phone_is_mobile_network: phone.isMobileNetwork,
    phone_is_proxy: phone.isProxy,
    phone_is_vpn: phone.isVpn,
    desktop_isolated_location_mismatch: desktop.isIsolatedLocationMismatch,
    phone_isolated_location_mismatch: phone.isIsolatedLocationMismatch,
  };

  if (desktop.isProxy) return { verdict: 'failed', reason: 'desktop_on_proxy', annotations };
  if (phone.isProxy) return { verdict: 'failed', reason: 'phone_on_proxy', annotations };

  if (!isIndividualScoreAllowed(desktop)) {
    return { verdict: 'failed', reason: 'desktop_score_high', annotations };
  }
  if (!isIndividualScoreAllowed(phone)) {
    return { verdict: 'failed', reason: 'phone_score_high', annotations };
  }
  if (desktop.individualScore + phone.individualScore >= TOTAL_SCORE_LIMIT) {
    return { verdict: 'failed', reason: 'total_score_high', annotations };
  }

  if (phone.isDatacenter) {
    return { verdict: 'failed', reason: 'phone_on_datacenter', annotations };
  }
  if (!desktop.isPhone && !phone.isPhone) {
    return { verdict: 'failed', reason: 'both_sides_desktop', annotations };
  }

  return {
    verdict: 'paired',
    reason: annotations.phone_to_phone ? 'paired_phone_to_phone' : 'paired_desktop_and_phone',
    annotations,
  };
}
