import { createHash } from 'crypto';

export const RAFFLE_FALLBACK_SITE = 'unknown';
export const RAFFLE_BUCKET_MAX = 3;
export const RAFFLE_BUCKET_TTL_SECONDS = 2 * 3600;

const HANDLE_RE = /^[a-z0-9._@-]{3,64}$/;

const md5hex = (value: string) => createHash('md5').update(value).digest('hex');

export function normalizeHandle(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const handle = raw.trim().toLowerCase();
  return HANDLE_RE.test(handle) ? handle : null;
}

/**
 * Hash the submitted handle for storage + display. The doubled
 * `${handle}::${handle}` input is a cheap domain-separator so the stored hash
 * is not directly lookup-able against a rainbow table of plain md5(email).
 * md5 is fine here: this is privacy hygiene, not auth.
 */
export function handleHash(handle: string): { hash: string; code: string } {
  const hash = md5hex(`${handle}::${handle}`);
  const code = hashToCode(hash);
  return { hash, code };
}

export function hashToCode(hash: string): string {
  return `${hash.slice(0, 4)}-${hash.slice(4, 8)}`;
}

/**
 * Pull the desktop's site host from the Origin header. CloudFront forwards
 * Origin, and originAllowed has already validated it against ALLOWED_ORIGINS.
 */
export function desktopSiteHost(event: { headers?: Record<string, string | undefined> }): string {
  const raw = event.headers?.origin ?? event.headers?.Origin ?? '';
  try {
    return new URL(raw).host.toLowerCase();
  } catch {
    return RAFFLE_FALLBACK_SITE;
  }
}

/**
 * Inputs for the raffle rate-limit gate. Five orthogonal axes, any one
 * tripping means the claim is rate-limited.
 */
export interface RaffleRateLimitInputs {
  phonePub: string;
  desktopPub: string;
  desktopUa: string;
  desktopIp: string;
  phoneUa: string;
  phoneIp: string;
  authIdentity: string | null;
  siteHost: string;
}

export function buildRaffleBuckets(inputs: RaffleRateLimitInputs): {
  siteHash: string;
  buckets: string[];
} {
  const siteHash = md5hex(inputs.siteHost);
  const buckets = [
    md5hex(inputs.phonePub + siteHash),
    md5hex(inputs.desktopPub + siteHash),
    md5hex(inputs.desktopUa + inputs.desktopIp + siteHash),
    md5hex(inputs.phoneUa + inputs.phoneIp + siteHash),
  ];
  if (inputs.authIdentity) {
    buckets.push(md5hex(inputs.authIdentity + siteHash));
  }
  return { siteHash, buckets };
}
