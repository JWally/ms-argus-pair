import type { Envelope } from '../ws-handler/router';
import type { DeviceTrustVerifyResult } from './attestation/trust';
import type {
  PhoneAttestationCommitInput,
  PhoneAttestationCommitOutcome,
} from './phone-attestation-commit';
import { proofModeForLog } from './phone-observability';
import type {
  PhoneAttestationRequestResult,
  PreparedPhoneAttestation,
} from './phone-attestation-request';
import { decidePhoneVerdict } from './phone-verdict-decision';
import type { MerchantProjection } from './merchant-projection';
import { classifyScan, type ClassifiedScan } from './projection-verdict';
import type { ProofOfLifeAnnotations } from './proof-of-life';
import { jsonResp } from './shared/http';

interface HostEvidence {
  iframeProjection: MerchantProjection | null;
  iframeScan: ClassifiedScan | null;
  annotations: Record<string, unknown>;
}

interface ProofRequest {
  webauthn: unknown;
  oauth: unknown;
  expectedNonce: string;
  argusPubkey: string;
  trustRedeemed: boolean;
}

interface VerdictDeliveryInput {
  desktopEnv: Envelope;
  sessionId: string;
  verdict: 'paired' | 'failed';
  reason: string;
  annotations: Record<string, unknown>;
  nextDeviceTrust: string | null;
  decidedAt: number;
  now: number;
}

export interface PhoneAttestationRouteDependencies {
  prepare(body: Record<string, unknown>, sessionId: string): Promise<PhoneAttestationRequestResult>;
  verifyDeviceTrust(
    token: string,
    requesterIp: string,
    publicKey: string
  ): Promise<DeviceTrustVerifyResult>;
  verifyProof(input: ProofRequest): Promise<ProofOfLifeAnnotations>;
  collectHostEvidence(input: {
    hostArgusSessionId: string | null;
    iframeArgusSessionId: string;
    pairSessionId: string;
  }): Promise<HostEvidence>;
  fetchPhoneProjection(argusSessionId: string): Promise<MerchantProjection | null>;
  mintDeviceTrust(publicKey: string, keyId: string, requesterIp: string): Promise<string | null>;
  commit(input: PhoneAttestationCommitInput): Promise<PhoneAttestationCommitOutcome>;
  deliverVerdict(input: VerdictDeliveryInput): Promise<Record<string, unknown>>;
  nowEpochSeconds(): number;
  proofRequiredByDefault: boolean;
  logInfo(message: string): void;
  logWarn(message: string): void;
}

type TrustCheck =
  | { ok: true; trust: DeviceTrustVerifyResult | null }
  | { ok: false; reason: string | undefined };

async function verifyPresentedTrust(
  prepared: PreparedPhoneAttestation,
  requesterIp: string,
  deps: PhoneAttestationRouteDependencies
): Promise<TrustCheck> {
  if (!prepared.deviceTrustToken) return { ok: true, trust: null };
  const trust = await deps.verifyDeviceTrust(
    prepared.deviceTrustToken,
    requesterIp,
    prepared.attestation.publicKey
  );
  return trust.ok ? { ok: true, trust } : { ok: false, reason: trust.reason };
}

async function collectDecisionEvidence(
  prepared: PreparedPhoneAttestation,
  sessionId: string,
  trustRedeemed: boolean,
  deps: PhoneAttestationRouteDependencies
) {
  const [hostEvidence, phoneProjection, proofAnnotations] = await Promise.all([
    deps.collectHostEvidence({
      hostArgusSessionId: prepared.session.hostAttestation?.argusSessionId ?? null,
      iframeArgusSessionId: prepared.session.desktopAttestation.argusSessionId,
      pairSessionId: sessionId,
    }),
    deps.fetchPhoneProjection(prepared.argusSessionId),
    deps.verifyProof({
      webauthn: prepared.webauthnInput,
      oauth: prepared.oauthInput,
      expectedNonce: prepared.session.nonce,
      argusPubkey: prepared.attestation.publicKey,
      trustRedeemed,
    }),
  ]);
  return { hostEvidence, phoneProjection, proofAnnotations };
}

function logPhoneDecision(
  prepared: PreparedPhoneAttestation,
  proofAnnotations: ProofOfLifeAnnotations,
  decision: ReturnType<typeof decidePhoneVerdict>,
  trust: DeviceTrustVerifyResult | null,
  nextDeviceTrust: string | null,
  deps: PhoneAttestationRouteDependencies
): void {
  const annotations = proofAnnotations as ProofOfLifeAnnotations & {
    phone_webauthn_error?: string;
    phone_oauth_error?: string;
  };
  if (decision.verdict !== 'paired') {
    deps.logWarn(
      `[pair] verdict=${decision.verdict} reason=${decision.reason} ` +
        `proofOfLife=${decision.proofOfLife} ` +
        `phone_webauthn_attested=${annotations.phone_webauthn_attested} ` +
        `phone_webauthn_error=${annotations.phone_webauthn_error ?? 'none'} ` +
        `phone_oauth_error=${annotations.phone_oauth_error ?? 'none'} ` +
        `trust_redeemed=${!!trust?.ok}`
    );
  }
  const proofMode = proofModeForLog({
    trustRedeemed: trust?.ok === true,
    oauthInput: prepared.oauthInput,
    webauthnInput: prepared.webauthnInput,
    annotations,
  });
  deps.logInfo(
    `[pair] proof verdict=${decision.verdict} reason=${decision.reason} ` +
      `proofOfLife=${decision.proofOfLife} proof_mode=${proofMode} ` +
      `proof_format=${annotations.phone_webauthn_format ?? 'none'} ` +
      `phone_webauthn_attested=${annotations.phone_webauthn_attested} ` +
      `phone_webauthn_error=${annotations.phone_webauthn_error ?? 'none'} ` +
      `phone_oauth_error=${annotations.phone_oauth_error ?? 'none'} ` +
      `trust_redeemed=${!!trust?.ok} trust_ip_changed=${!!trust?.ipChanged} ` +
      `device_trust_minted=${!!nextDeviceTrust}`
  );
}

function commitFailureResponse(result: PhoneAttestationCommitOutcome) {
  if (result.outcome === 'committed') return null;
  if (result.outcome === 'same_device_retry') {
    return jsonResp(200, {
      verdict: 'complete',
      reason: null,
      annotations: {},
      concurrent_loser: true,
    });
  }
  if (result.outcome === 'other_device') {
    return jsonResp(409, {
      error: 'session_paired_with_other_device',
      reason: 'This QR code is already paired with a different device.',
    });
  }
  return jsonResp(409, { error: 'write_conflict' });
}

/** Application boundary for proof, projection, verdict, commit, and disclosure. */
export function createPhoneAttestationHandler(deps: PhoneAttestationRouteDependencies) {
  return async (body: Record<string, unknown>, sessionId: string, requesterIp: string) => {
    const prepared = await deps.prepare(body, sessionId);
    if (!prepared.ok) return jsonResp(prepared.status, prepared.body);
    const trustCheck = await verifyPresentedTrust(prepared, requesterIp, deps);
    if (!trustCheck.ok) {
      return jsonResp(401, { error: 'device_trust_invalid', reason: trustCheck.reason });
    }

    const evidence = await collectDecisionEvidence(
      prepared,
      sessionId,
      trustCheck.trust?.ok === true,
      deps
    );
    const decision = decidePhoneVerdict({
      proofRequired: prepared.session.proofRequired ?? deps.proofRequiredByDefault,
      proofAnnotations: evidence.proofAnnotations,
      desktopProjection: evidence.hostEvidence.iframeProjection,
      phoneProjection: evidence.phoneProjection,
      desktopScan: evidence.hostEvidence.iframeScan,
      phoneScan: classifyScan(evidence.phoneProjection, 'phone'),
      hostAnnotations: evidence.hostEvidence.annotations,
    });
    const nextDeviceTrust =
      decision.verdict === 'paired' &&
      !trustCheck.trust?.ok &&
      evidence.proofAnnotations.phone_webauthn_attested
        ? await deps.mintDeviceTrust(
            prepared.attestation.publicKey,
            prepared.attestation.keyId,
            requesterIp
          )
        : null;
    if (trustCheck.trust?.ok) {
      decision.annotations.phone_device_trust_redeemed = true;
      if (trustCheck.trust.ipChanged) decision.annotations.phone_device_trust_ip_changed = true;
    }
    logPhoneDecision(
      prepared,
      evidence.proofAnnotations,
      decision,
      trustCheck.trust,
      nextDeviceTrust,
      deps
    );

    const commitResult = await deps.commit({
      sessionId,
      stored: prepared.stored,
      verdict: decision.verdict,
      reason: decision.reason,
      annotations: decision.annotations,
    });
    const commitFailure = commitFailureResponse(commitResult);
    if (commitFailure) return commitFailure;
    const completion = await deps.deliverVerdict({
      desktopEnv: prepared.desktopEnv,
      sessionId,
      verdict: decision.verdict,
      reason: decision.reason,
      annotations: decision.annotations,
      nextDeviceTrust,
      decidedAt: prepared.stored.receivedAt,
      now: deps.nowEpochSeconds(),
    });
    return jsonResp(200, completion);
  };
}
