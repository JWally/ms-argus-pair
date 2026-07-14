import {
  validateAttestInput,
  verifyAttestation,
  type AttestationInput,
  type EnvelopeDecoded,
} from './attestation/envelope';

export interface HostPreflightInput {
  argusSessionId: string;
  attestation: AttestationInput;
}

export interface StoredHostPreflight extends AttestationInput {
  argusSessionId: string;
  receivedAt: number;
  envelopeDecoded: EnvelopeDecoded;
  origin: string;
}

export type HostPreflightClaim = (
  argusSessionId: string,
  pairSessionId: string,
  role: 'host'
) => Promise<{ ok: true } | { ok: false; reason: string }>;

type HostPreflightResult =
  | { ok: true; stored: StoredHostPreflight }
  | { ok: false; status: 400 | 409; body: { error: string; reason?: string } };

function badRequest(error: string, reason?: string): HostPreflightResult {
  return { ok: false, status: 400, body: { error, ...(reason ? { reason } : {}) } };
}

function readInput(value: unknown): HostPreflightInput | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const attestation = validateAttestInput(body);
  if (typeof body.argusSessionId !== 'string' || !body.argusSessionId || !attestation) return null;
  return { argusSessionId: body.argusSessionId, attestation };
}

export function validMerchantOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    return (
      parsed.origin === origin &&
      (parsed.protocol === 'https:' ||
        (parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname)))
    );
  } catch {
    return false;
  }
}

/**
 * Verify and consume the merchant-realm scan attached with desktop-attest.
 * This establishes replay-resistant evidence binding only. Verdict policy stays
 * in projection-verdict.ts and must not silently treat this as an iframe pass.
 */
export async function prepareHostPreflight(
  value: unknown,
  expected: {
    pairSessionId: string;
    challengeId: string;
    cpi: string;
    origin: string;
  },
  claim: HostPreflightClaim
): Promise<HostPreflightResult> {
  const input = readInput(value);
  if (!input) return badRequest('host_preflight_invalid');
  if (!validMerchantOrigin(expected.origin)) return badRequest('host_preflight_origin_invalid');

  const verified = verifyAttestation(input.attestation);
  if (!verified.ok || !verified.decoded) {
    return badRequest('host_preflight_attestation_invalid', verified.reason);
  }

  const payload = verified.decoded.payload as {
    role?: string;
    pairSessionId?: string;
    challengeId?: string;
    cpi?: string;
    origin?: string;
    nonce?: string;
  };
  if (payload.role !== 'host') return badRequest('host_preflight_role_mismatch');
  if (payload.pairSessionId !== expected.pairSessionId) {
    return badRequest('host_preflight_session_mismatch');
  }
  if (payload.challengeId !== expected.challengeId) {
    return badRequest('host_preflight_challenge_mismatch');
  }
  if (payload.cpi !== expected.cpi) return badRequest('host_preflight_cpi_mismatch');
  if (payload.origin !== expected.origin) return badRequest('host_preflight_origin_mismatch');
  if (typeof payload.nonce !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(payload.nonce)) {
    return badRequest('host_preflight_nonce_invalid');
  }
  if (verified.decoded.scanSessionId !== input.argusSessionId) {
    return badRequest('host_preflight_scan_mismatch');
  }

  const claimed = await claim(input.argusSessionId, expected.pairSessionId, 'host');
  if (!claimed.ok) {
    return {
      ok: false,
      status: 409,
      body: { error: 'host_preflight_already_claimed', reason: claimed.reason },
    };
  }

  return {
    ok: true,
    stored: {
      ...input.attestation,
      argusSessionId: input.argusSessionId,
      receivedAt: Math.floor(Date.now() / 1000),
      envelopeDecoded: verified.decoded,
      origin: expected.origin,
    },
  };
}
