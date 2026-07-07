import { randomBytes } from 'node:crypto';

export interface SsoLegProfile {
  argusSessionId: string;
  keyId: string | null;
  ip: string | null;
  asnName: string | null;
  country: string | null;
  city: string | null;
  score: number | null;
  isPhone: boolean;
  isProxy: boolean;
  isDatacenter: boolean;
  isVpn: boolean;
}

export interface SsoContinuityInput {
  start: SsoLegProfile;
  challenge: SsoLegProfile;
  validate: SsoLegProfile;
}

export interface SsoContinuityVerdict {
  ok: boolean;
  reason: 'approved' | 'not_phone' | 'device_changed' | 'network_changed' | 'risk_changed';
  reasons: string[];
}

const MAX_SCORE = 40;
const MAX_SCORE_DRIFT = 35;

function ipv4Prefix24(ip: string | null): string | null {
  if (!ip) return null;
  const octets = ip.split('.');
  if (
    octets.length !== 4 ||
    octets.some((octet) => {
      if (!octet || octet.length > 3) return true;
      const parsed = Number(octet);
      return !Number.isInteger(parsed) || parsed < 0 || parsed > 255 || String(parsed) !== octet;
    })
  ) {
    return null;
  }
  return octets.slice(0, 3).join('.');
}

function sameDevice(legs: SsoLegProfile[]): boolean {
  const keys = legs.map((leg) => leg.keyId).filter((key): key is string => !!key);
  return keys.length === legs.length && new Set(keys).size === 1;
}

function allPhones(legs: SsoLegProfile[]): boolean {
  return legs.every((leg) => leg.isPhone === true);
}

function sameOrNearbyNetwork(legs: SsoLegProfile[]): boolean {
  if (legs.some((leg) => leg.isProxy || leg.isDatacenter || leg.isVpn)) return false;

  const countries = legs.map((leg) => leg.country).filter(Boolean);
  if (countries.length === legs.length && new Set(countries).size > 1) return false;

  const asns = legs.map((leg) => leg.asnName).filter(Boolean);
  if (asns.length === legs.length && new Set(asns).size === 1) return true;

  const prefixes = legs.map((leg) => ipv4Prefix24(leg.ip)).filter(Boolean);
  return prefixes.length === legs.length && new Set(prefixes).size === 1;
}

function stableRisk(legs: SsoLegProfile[]): boolean {
  const scores = legs.map((leg) => leg.score).filter((score): score is number => score !== null);
  if (scores.some((score) => score > MAX_SCORE)) return false;
  if (scores.length < 2) return true;
  return Math.max(...scores) - Math.min(...scores) <= MAX_SCORE_DRIFT;
}

export function evaluateSsoContinuity(input: SsoContinuityInput): SsoContinuityVerdict {
  const legs = [input.start, input.challenge, input.validate];
  const reasons: string[] = [];

  if (!allPhones(legs)) {
    return { ok: false, reason: 'not_phone', reasons: ['phone_required'] };
  }
  reasons.push('phone_classified');

  if (!sameDevice(legs)) {
    return { ok: false, reason: 'device_changed', reasons: ['device_key_mismatch'] };
  }
  reasons.push('device_key_match');

  if (!sameOrNearbyNetwork(legs)) {
    return { ok: false, reason: 'network_changed', reasons };
  }
  reasons.push('network_continuity');

  if (!stableRisk(legs)) {
    return { ok: false, reason: 'risk_changed', reasons };
  }
  reasons.push('risk_stable');

  return { ok: true, reason: 'approved', reasons };
}

export interface ReturnCode {
  value: string;
  sessionId: string;
  expiresAt: number;
  consumed: boolean;
}

export function mintReturnCode({
  sessionId,
  ttlSeconds,
}: {
  sessionId: string;
  ttlSeconds: number;
}): ReturnCode {
  return {
    value: `sso_${randomBytes(24).toString('base64url')}`,
    sessionId,
    expiresAt: Date.now() + ttlSeconds * 1000,
    consumed: false,
  };
}

export function consumeReturnCode(
  code: ReturnCode,
  nowMs: number
): { ok: true; sessionId: string } | { ok: false; reason: 'expired' | 'consumed' } {
  if (code.consumed) return { ok: false, reason: 'consumed' };
  if (nowMs > code.expiresAt) return { ok: false, reason: 'expired' };
  code.consumed = true;
  return { ok: true, sessionId: code.sessionId };
}
