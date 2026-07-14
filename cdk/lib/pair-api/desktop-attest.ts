import {
  validatePairAttestationBody,
  verifyPairAttestationPayload,
  type AttestationInput,
  type EnvelopeDecoded,
} from './attestation/envelope';
import { prepareHostPreflight, type StoredHostPreflight } from './host-preflight';

export interface StoredPairAttestation extends AttestationInput {
  argusSessionId: string;
  receivedAt: number;
  envelopeDecoded: EnvelopeDecoded;
}

export interface StoredDesktopAttestation extends StoredPairAttestation {
  hostAttestation?: StoredHostPreflight;
}

export interface DesktopAttestationSession {
  pairSessionId: string;
  nonce: string;
  challengeId?: string;
  cpi?: string | null;
  hostPreflightRequired?: boolean;
  hostOrigin?: string;
}

export type DesktopAttestationClaim = (
  argusSessionId: string,
  pairSessionId: string,
  role: 'host' | 'desktop'
) => Promise<{ ok: true } | { ok: false; reason: string }>;

type DesktopAttestationResult =
  | { ok: true; stored: StoredDesktopAttestation }
  | { ok: false; status: number; body: unknown };

/**
 * Validate and claim the iframe scan plus its required merchant-realm scan.
 * Both are committed later in the caller's existing desktop-slot write.
 */
export async function prepareDesktopAttestation(
  body: Record<string, unknown>,
  session: DesktopAttestationSession,
  claim: DesktopAttestationClaim
): Promise<DesktopAttestationResult> {
  const pairBody = validatePairAttestationBody(body);
  if (!pairBody.ok) return pairBody;

  const verified = verifyPairAttestationPayload(pairBody.attestation, {
    role: 'desktop',
    sessionId: session.pairSessionId,
    nonce: session.nonce,
    argusSessionId: pairBody.argusSessionId,
  });
  if (!verified.ok) return verified;

  let hostAttestation: StoredHostPreflight | undefined;
  if (session.hostPreflightRequired) {
    if (!session.challengeId || !session.cpi || !session.hostOrigin) {
      return { ok: false, status: 400, body: { error: 'host_preflight_session_invalid' } };
    }
    const hostPrepared = await prepareHostPreflight(
      body.hostPreflight,
      {
        pairSessionId: session.pairSessionId,
        challengeId: session.challengeId,
        cpi: session.cpi,
        origin: session.hostOrigin,
      },
      claim
    );
    if (!hostPrepared.ok) return hostPrepared;
    hostAttestation = hostPrepared.stored;
  }

  const desktopClaim = await claim(pairBody.argusSessionId, session.pairSessionId, 'desktop');
  if (!desktopClaim.ok) {
    return {
      ok: false,
      status: 409,
      body: { error: 'argus_session_already_claimed', reason: desktopClaim.reason },
    };
  }

  return {
    ok: true,
    stored: {
      ...pairBody.attestation,
      argusSessionId: pairBody.argusSessionId,
      receivedAt: Math.floor(Date.now() / 1000),
      envelopeDecoded: verified.decoded,
      ...(hostAttestation ? { hostAttestation } : {}),
    },
  };
}
