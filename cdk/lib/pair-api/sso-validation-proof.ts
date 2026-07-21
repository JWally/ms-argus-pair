import type { AttestationInput } from './attestation/envelope';
import type { DeviceTrustVerifyResult } from './attestation/trust';
import type { ProofOfLifeAnnotations } from './proof-of-life';
import { isProofOfLifeSatisfied } from './proof-of-life';
import { evaluateSsoProofPolicy } from './sso-assurance';

export interface SsoValidationProofInput {
  body: Record<string, unknown>;
  requesterIp: string;
  attestation: AttestationInput;
  nonce: string;
  proofRequired: boolean;
  freshProofRequired: boolean;
}

interface VerifyProofOfLifeInput {
  webauthn: unknown;
  oauth: unknown;
  expectedNonce: string;
  argusPubkey: string;
  trustRedeemed: boolean;
}

export interface SsoValidationProofDependencies {
  verifyDeviceTrust(
    token: string,
    requesterIp: string,
    expectedPublicKey: string
  ): Promise<DeviceTrustVerifyResult>;
  verifyProofOfLife(input: VerifyProofOfLifeInput): Promise<ProofOfLifeAnnotations>;
}

export type SsoValidationProofResult =
  | {
      ok: true;
      annotations: Record<string, unknown>;
      trustRedeemed: boolean;
    }
  | { ok: false; status: 401; body: unknown };

export async function verifySsoValidationProof(
  input: SsoValidationProofInput,
  deps: SsoValidationProofDependencies
): Promise<SsoValidationProofResult> {
  const deviceTrustToken =
    typeof input.body.deviceTrustToken === 'string' ? input.body.deviceTrustToken : undefined;
  if (input.freshProofRequired && deviceTrustToken) {
    return { ok: false, status: 401, body: { error: 'fresh_proof_required' } };
  }

  let trustResult: DeviceTrustVerifyResult | null = null;
  if (deviceTrustToken) {
    trustResult = await deps.verifyDeviceTrust(
      deviceTrustToken,
      input.requesterIp,
      input.attestation.publicKey
    );
    if (!trustResult.ok) {
      return {
        ok: false,
        status: 401,
        body: {
          error: 'device_trust_rejected',
          reason: trustResult.reason,
          clearDeviceTrust: true,
        },
      };
    }
  }

  const trustRedeemed = trustResult?.ok === true;
  const proof = await deps.verifyProofOfLife({
    webauthn: input.body.webauthn,
    oauth: input.body.oauth,
    expectedNonce: input.nonce,
    argusPubkey: input.attestation.publicKey,
    trustRedeemed,
  });
  const annotations: Record<string, unknown> = {
    ...proof,
    ...(trustRedeemed ? { phone_device_trust_redeemed: true } : {}),
    ...(trustResult?.ipChanged ? { phone_device_trust_ip_changed: true } : {}),
  };
  const decision = evaluateSsoProofPolicy(
    {
      proofRequired: input.proofRequired,
      freshProofRequired: input.freshProofRequired,
    },
    {
      proofSatisfied: isProofOfLifeSatisfied(proof),
      usedDeviceTrust: trustRedeemed,
    }
  );
  if (!decision.ok) {
    return {
      ok: false,
      status: 401,
      body: { error: decision.reason, annotations },
    };
  }
  return { ok: true, annotations, trustRedeemed };
}
