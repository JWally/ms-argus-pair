/**
 * Device-trust token: silent re-auth after first WebAuthn.
 *
 * Once a phone passes the WebAuthn ceremony we mint an HMAC-signed
 * blob containing (pubkey, ip, exp). On the NEXT visit within the
 * TTL, from the same IP, the phone presents the token instead of
 * running the biometric ceremony again.
 *
 * Strict IP-pin: any drift forces fresh WebAuthn. The HMAC secret
 * lives in Secrets Manager so it survives Lambda redeploys —
 * otherwise every deploy would invalidate every token.
 *
 * Token format: `<body>.<mac>` where:
 *   - body = base64url(JSON.stringify({ v, pubkey, keyId, ip, iat, exp }))
 *   - mac  = HMAC-SHA256(secret, body) as base64url
 */

import { createHmac, timingSafeEqual } from 'crypto';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { b64urlToBuf } from './envelope';

const DEVICE_TRUST_SECRET_ARN = process.env.DEVICE_TRUST_SECRET_ARN || '';
const DEVICE_TRUST_TTL_SECONDS = 12 * 3600;

const sm = new SecretsManagerClient({});
let cachedTrustSecret: string | null = null;

/**
 * Exposed so warmup middleware can pre-fetch the secret in
 * background, sparing the first real /phone-attest the round-trip.
 * Internal callers (mintDeviceTrust, verifyDeviceTrust) use this
 * directly; nothing else should need it.
 */
export async function getTrustSecret(): Promise<string | null> {
  if (cachedTrustSecret) return cachedTrustSecret;
  if (!DEVICE_TRUST_SECRET_ARN) return null;
  try {
    const r = await sm.send(new GetSecretValueCommand({ SecretId: DEVICE_TRUST_SECRET_ARN }));
    cachedTrustSecret = r.SecretString || null;
    return cachedTrustSecret;
  } catch (e) {
    console.warn(`[pair] getTrustSecret failed: ${(e as Error).message}`);
    return null;
  }
}

interface DeviceTrustPayload {
  v: 1;
  pubkey: string; // SPKI base64, matches the SDK device key
  keyId: string;
  ip: string; // strict — any drift forces re-WebAuthn
  iat: number;
  exp: number;
}

export interface DeviceTrustVerifyResult {
  ok: boolean;
  reason?: string;
  payload?: DeviceTrustPayload;
}

function b64urlEncodeBytes(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Mint a fresh device-trust token. Returns null when no secret is
 *  available or the IP is missing. */
export async function mintDeviceTrust(
  pubkey: string,
  keyId: string,
  ip: string
): Promise<string | null> {
  const secret = await getTrustSecret();
  if (!secret || !ip) return null;
  const iat = Math.floor(Date.now() / 1000);
  const payload: DeviceTrustPayload = {
    v: 1,
    pubkey,
    keyId,
    ip,
    iat,
    exp: iat + DEVICE_TRUST_TTL_SECONDS,
  };
  const body = b64urlEncodeBytes(Buffer.from(JSON.stringify(payload), 'utf8'));
  const mac = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

/**
 * Verify a presented token against the requester's IP and the
 * phone's claimed argus pubkey. All four checks must pass:
 *   - HMAC matches
 *   - JSON-parseable payload, v === 1
 *   - exp not in the past
 *   - payload.ip === requesterIp (strict)
 *   - payload.pubkey === expectedPubKey
 */
export async function verifyDeviceTrust(
  token: string,
  requesterIp: string,
  expectedPubKey: string
): Promise<DeviceTrustVerifyResult> {
  if (typeof token !== 'string' || !token.includes('.')) {
    return { ok: false, reason: 'malformed' };
  }
  const [body, mac] = token.split('.', 2);
  if (!body || !mac) return { ok: false, reason: 'malformed' };
  const secret = await getTrustSecret();
  if (!secret) return { ok: false, reason: 'no_secret' };
  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'hmac' };
  }
  let payload: DeviceTrustPayload;
  try {
    payload = JSON.parse(b64urlToBuf(body).toString('utf8')) as DeviceTrustPayload;
  } catch {
    return { ok: false, reason: 'not_json' };
  }
  if (payload.v !== 1) return { ok: false, reason: 'version' };
  const now = Math.floor(Date.now() / 1000);
  if (now > payload.exp) return { ok: false, reason: 'expired' };
  if (!requesterIp) return { ok: false, reason: 'no_requester_ip' };
  if (payload.ip !== requesterIp) return { ok: false, reason: 'ip_changed' };
  if (payload.pubkey !== expectedPubKey) return { ok: false, reason: 'pubkey_mismatch' };
  return { ok: true, payload };
}
