// Verdict thresholds (per spec). Individual = max(automation, device_tampering,
// network_tampering) for one side. Total = sum of the two sides' individual
// scores.
export const INDIVIDUAL_SCORE_LIMIT = 30;
const TOTAL_SCORE_LIMIT = 50;
// #13: PAT is a strong Apple-device signal but FARMABLE (the upstream
// /v1/pat-attestation challenge is unbound + not single-use). So PAT is no
// longer an unconditional golden ticket. It EXTENDS the per-side score
// tolerance from INDIVIDUAL_SCORE_LIMIT up to PAT_SCORE_FLOOR for an
// attested side, but cannot whitewash hard automation/tampering evidence
// (score >= floor), and no longer exempts the datacenter or total-score
// checks. A genuine Apple device scores well under 30, so this never costs a
// legit PAT user; it only denies a farmed PAT stapled onto a dirty device.
const PAT_SCORE_FLOOR = 70;

export const PROJECTION_FRESHNESS_WINDOW_SECONDS = 180;

type PairVerdict = 'paired' | 'failed';

export interface MerchantProjection {
  automation?: number;
  device_tampering?: number;
  network_tampering?: number;
  /** Epoch ms; null on legacy records. From ms-argus-api MerchantSafeResponse. */
  created_at?: number | null;
  verdict?: string;
  identification?: {
    browserDetails?: {
      device?: string | null;
      os?: string | null;
    };
  };
  tags?: string[];
  pat_attested?: boolean;
}

export interface ClassifiedScan {
  individualScore: number;
  isPhone: boolean;
  isDatacenter: boolean;
  isProxy: boolean;
  patAttested: boolean;
  ok: boolean;
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
  details: Record<string, unknown> | undefined;
  deviceLabel: string;
  deviceType: string;
  platform: string;
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
  if (!p || typeof p.created_at !== 'number') return null;
  return Math.round((Date.now() - p.created_at) / 1000);
}

export function isProjectionFresh(p: MerchantProjection | null): boolean {
  const age = projectionAgeSeconds(p);
  if (age === null) return false;
  return age >= -PROJECTION_FRESHNESS_WINDOW_SECONDS && age <= PROJECTION_FRESHNESS_WINDOW_SECONDS;
}

/** Lowercased tag check, defensive against missing/empty tags array. */
function hasTagLike(tags: string[] | undefined, ...patterns: string[]): boolean {
  if (!Array.isArray(tags) || tags.length === 0) return false;
  const lc = tags.map((t) => String(t).toLowerCase());
  return patterns.some((p) => {
    const needle = p.toLowerCase();
    return lc.some((t) => t.includes(needle));
  });
}

function browserSignals(p: MerchantProjection): BrowserSignals {
  const projAny = p as unknown as Record<string, unknown>;
  const details = (projAny.identification as Record<string, unknown> | undefined)
    ?.browserDetails as Record<string, unknown> | undefined;
  return {
    details,
    deviceLabel: String(details?.device ?? '').toLowerCase(),
    deviceType: String(details?.deviceType ?? '').toLowerCase(),
    platform: String(details?.platform ?? '').toLowerCase(),
    os: String(details?.os ?? '').toLowerCase(),
    ua: String(details?.userAgent ?? ''),
  };
}

function hasPhoneSignals(signals: BrowserSignals): boolean {
  const phoneSignals = [signals.deviceLabel, signals.deviceType, signals.platform, signals.os].some(
    (v) => v === 'mobile' || v === 'tablet' || v === 'phone'
  );
  const phoneOsRe = /\b(ios|ipados|android|iphone|ipod)\b/i;
  return (
    phoneSignals ||
    phoneOsRe.test(signals.os) ||
    phoneOsRe.test(signals.platform) ||
    /Mobile|Android|iPhone|iPad|iPod/.test(signals.ua)
  );
}

function networkSignals(p: MerchantProjection): NetworkSignals {
  const projAny = p as unknown as Record<string, unknown>;
  const ipInfo = projAny.ipInfo as
    | {
        asn?: { organization?: string | null };
        datacenter?: { result?: boolean };
        mobile?: { result?: boolean };
        vpn?: { result?: boolean };
        hosting?: { result?: boolean };
      }
    | undefined;
  const ipLocation = projAny.ipLocation as
    | { city?: string | null; country?: string | null }
    | undefined;
  return {
    asnName: ipInfo?.asn?.organization ?? null,
    city: ipLocation?.city ?? null,
    country: ipLocation?.country ?? null,
    isProxy: hasTagLike(p.tags, 'proxy') || ipInfo?.hosting?.result === true,
    isDatacenter:
      hasTagLike(p.tags, 'datacenter', 'hyperscaler', 'dc_asn') ||
      ipInfo?.datacenter?.result === true,
    isMobileNetwork: ipInfo?.mobile?.result === true,
    isVpn: ipInfo?.vpn?.result === true,
  };
}

export function classifyScan(p: MerchantProjection | null, side: string): ClassifiedScan | null {
  if (!p) return null;
  const individualScore = Math.max(
    p.automation ?? 0,
    p.device_tampering ?? 0,
    p.network_tampering ?? 0
  );

  const projAny = p as unknown as Record<string, unknown>;
  const browser = browserSignals(p);
  const network = networkSignals(p);
  const isPhone = hasPhoneSignals(browser);
  const patAttested = p.pat_attested === true || hasTagLike(p.tags, 'apple_attested');
  const ok = (p.verdict ?? 'PASS').toUpperCase() === 'PASS';

  const browserName = (browser.details?.browserName as string | null | undefined) ?? null;
  const browserVersion = (browser.details?.browserVersion as string | null | undefined) ?? null;
  const osLabel = (browser.details?.os as string | null | undefined) ?? null;
  const ip = (projAny.ip as string | null | undefined) ?? null;

  console.log(
    `[pair] classifyScan side=${side} score=${individualScore} isPhone=${isPhone} isProxy=${network.isProxy} isDC=${network.isDatacenter} pat=${patAttested} verdict=${p.verdict} ` +
      `device=${JSON.stringify({
        deviceLabel: browser.deviceLabel,
        deviceType: browser.deviceType,
        platform: browser.platform,
        os: browser.os,
        ua: browser.ua.slice(0, 80),
      })} tags=${JSON.stringify(p.tags ?? null)}`
  );

  return {
    individualScore,
    isPhone,
    isDatacenter: network.isDatacenter,
    isProxy: network.isProxy,
    patAttested,
    ok,
    browserName,
    browserVersion,
    os: osLabel,
    ip,
    ua: browser.ua || null,
    asnName: network.asnName,
    city: network.city,
    country: network.country,
    isMobileNetwork: network.isMobileNetwork,
    isVpn: network.isVpn,
  };
}

export function summarizeDesktopScan(scan: ClassifiedScan | null): DesktopScanSummary {
  if (!scan) return { clean: false, summary: null };
  return {
    clean:
      scan.patAttested &&
      !scan.isProxy &&
      !scan.isDatacenter &&
      scan.individualScore < INDIVIDUAL_SCORE_LIMIT,
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
  };

  if (desktop.isProxy) return { verdict: 'failed', reason: 'desktop_on_proxy', annotations };
  if (phone.isProxy) return { verdict: 'failed', reason: 'phone_on_proxy', annotations };

  const scoreOk = (s: ClassifiedScan) =>
    s.individualScore < INDIVIDUAL_SCORE_LIMIT ||
    (s.patAttested && s.individualScore < PAT_SCORE_FLOOR);
  if (!scoreOk(desktop)) {
    return { verdict: 'failed', reason: 'desktop_score_high', annotations };
  }
  if (!scoreOk(phone)) {
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
