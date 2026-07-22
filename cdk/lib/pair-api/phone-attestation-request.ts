import type { Envelope } from '../ws-handler';
import {
  validatePairAttestationBody,
  verifyPairAttestationPayload,
  type AttestationInput,
} from './attestation/envelope';
import type { StoredDesktopAttestation, StoredPairAttestation } from './desktop-attest';
import type { StoredHostPreflight } from './host-preflight';

export interface PhoneAttestationSession {
  nonce: string;
  proofRequired?: boolean;
  freshProofRequired?: boolean;
  hostAttestation?: StoredHostPreflight;
  desktopAttestation?: StoredDesktopAttestation;
  phoneAttestation?: StoredPairAttestation;
  verdict?: 'pending' | 'paired' | 'failed';
}

interface ReadyPhoneAttestationSession extends PhoneAttestationSession {
  desktopAttestation: StoredDesktopAttestation;
}

export interface PhoneAttestationRequestDependencies {
  loadSession(sessionId: string): Promise<PhoneAttestationSession | null>;
  openDesktopEnvelope(envelope: string): Promise<Envelope | null>;
  claimPhoneArgusSession(
    argusSessionId: string,
    pairSessionId: string
  ): Promise<{ ok: true } | { ok: false; reason: string }>;
  nowEpochSeconds(): number;
}

type RequestFailure = { ok: false; status: number; body: Record<string, unknown> };

export interface PreparedPhoneAttestation {
  ok: true;
  session: ReadyPhoneAttestationSession;
  argusSessionId: string;
  attestation: AttestationInput;
  stored: StoredPairAttestation;
  desktopEnv: Envelope;
  webauthnInput: unknown;
  oauthInput: unknown;
  deviceTrustToken?: string;
}

export type PhoneAttestationRequestResult = PreparedPhoneAttestation | RequestFailure;

function sessionGate(
  session: PhoneAttestationSession | null,
  phonePublicKey: string,
  deviceTrustToken: string | undefined
): RequestFailure | null {
  if (!session) return { ok: false, status: 404, body: { error: 'session_not_found' } };
  if (!session.desktopAttestation) {
    return { ok: false, status: 409, body: { error: 'desktop_not_attested_yet' } };
  }
  if (session.freshProofRequired && deviceTrustToken) {
    return {
      ok: false,
      status: 401,
      body: { error: 'fresh_proof_required', clearDeviceTrust: false },
    };
  }
  if (!session.phoneAttestation) return null;
  if (session.phoneAttestation.publicKey === phonePublicKey) {
    return { ok: false, status: 409, body: { error: 'already_attested' } };
  }
  return {
    ok: false,
    status: 409,
    body: {
      error: 'session_paired_with_other_device',
      reason: 'This QR code is already paired with a different device.',
    },
  };
}

async function authenticateDesktopBinding(
  body: Record<string, unknown>,
  sessionId: string,
  session: ReadyPhoneAttestationSession,
  openDesktopEnvelope: PhoneAttestationRequestDependencies['openDesktopEnvelope']
): Promise<{ ok: true; desktopEnv: Envelope } | RequestFailure> {
  const sealedEnvelope = typeof body.desktopEnvelope === 'string' ? body.desktopEnvelope : '';
  const desktopEnv = sealedEnvelope ? await openDesktopEnvelope(sealedEnvelope) : null;
  if (!desktopEnv || desktopEnv.sessionId !== sessionId || desktopEnv.role !== 'desktop') {
    return { ok: false, status: 400, body: { error: 'desktop_binding_unauthenticated' } };
  }
  if (body.desktopArgusSessionId !== session.desktopAttestation.argusSessionId) {
    return { ok: false, status: 400, body: { error: 'desktop_argus_session_mismatch' } };
  }
  if (body.desktopKeyId !== session.desktopAttestation.keyId) {
    return { ok: false, status: 400, body: { error: 'desktop_keyId_mismatch' } };
  }
  return { ok: true, desktopEnv };
}

/** Validate and bind a phone request before proof, projection, or persistence work. */
export async function preparePhoneAttestation(
  body: Record<string, unknown>,
  sessionId: string,
  deps: PhoneAttestationRequestDependencies
): Promise<PhoneAttestationRequestResult> {
  const pairBody = validatePairAttestationBody(body);
  if (!pairBody.ok) return pairBody;
  const deviceTrustToken =
    typeof body.deviceTrustToken === 'string' ? body.deviceTrustToken : undefined;
  const session = await deps.loadSession(sessionId);
  const gateFailure = sessionGate(session, pairBody.attestation.publicKey, deviceTrustToken);
  if (gateFailure) return gateFailure;
  const readySession = session as ReadyPhoneAttestationSession;

  const verified = verifyPairAttestationPayload(pairBody.attestation, {
    role: 'phone',
    sessionId,
    nonce: readySession.nonce,
    argusSessionId: pairBody.argusSessionId,
  });
  if (!verified.ok) return verified as RequestFailure;
  const binding = await authenticateDesktopBinding(
    body,
    sessionId,
    readySession,
    deps.openDesktopEnvelope
  );
  if (!binding.ok) return binding;
  if (pairBody.attestation.keyId === readySession.desktopAttestation.keyId) {
    return { ok: false, status: 400, body: { error: 'same_device_both_sides' } };
  }

  const claim = await deps.claimPhoneArgusSession(pairBody.argusSessionId, sessionId);
  if (!claim.ok) {
    return {
      ok: false,
      status: 409,
      body: { error: 'argus_session_already_claimed', reason: claim.reason },
    };
  }
  return {
    ok: true,
    session: readySession,
    argusSessionId: pairBody.argusSessionId,
    attestation: pairBody.attestation,
    stored: {
      ...pairBody.attestation,
      argusSessionId: pairBody.argusSessionId,
      receivedAt: deps.nowEpochSeconds(),
      envelopeDecoded: verified.decoded,
    },
    desktopEnv: binding.desktopEnv,
    webauthnInput: body.webauthn,
    oauthInput: body.oauth,
    deviceTrustToken,
  };
}
