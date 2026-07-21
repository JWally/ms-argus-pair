import type { SsoContinuityVerdict, SsoLegProfile } from '../sso-continuity';
import { evaluateSsoContinuity } from '../sso-continuity';
import type { SsoAttestationResult } from './attestation/envelope';
import type { MerchantProjection } from './merchant-projection';
import { classifyScan } from './projection-verdict';
import { hashApprovalToken } from './sso-approval';
import { ssoFailureReturn } from './sso-merchant-callback';
import { hashSsoReturnCode, requirePhoneSsoScan, ssoProfileFromScan } from './sso-scan';
import type { SsoSessionItem } from './sso-session';
import type { SsoValidationProofInput, SsoValidationProofResult } from './sso-validation-proof';

interface SsoValidationAttestationExpectation {
  role: 'merchant-validate';
  sessionId: string;
  nonce: string;
  returnCode: string;
  cpi: string;
}

export interface StoredSsoValidation {
  sessionId: string;
  validateProfile: SsoLegProfile;
  verdict: 'approved' | 'failed';
  verdictReason: string;
  returnCodeConsumedAt: number;
  proofAnnotations: Record<string, unknown>;
  approval?: {
    approvedAt: number;
    approvalTokenHash: string;
    expiresAt: number;
  };
}

export interface SsoValidationDependencies {
  loadSession(sessionId: string): Promise<SsoSessionItem | null>;
  validateAttestation(
    body: Record<string, unknown>,
    expected: SsoValidationAttestationExpectation
  ): SsoAttestationResult;
  fetchProjection(argusSessionId: string): Promise<MerchantProjection | null>;
  verifyProof(input: SsoValidationProofInput): Promise<SsoValidationProofResult>;
  mintApprovalToken(): string;
  mintDeviceTrust(publicKey: string, keyId: string, requesterIp: string): Promise<string | null>;
  storeValidation(validation: StoredSsoValidation): Promise<void>;
  nowEpochSeconds(): number;
  approvalTtlSeconds: number;
}

export type SsoValidationResult =
  | {
      ok: true;
      verdict: SsoContinuityVerdict;
      approvalToken: string | null;
      merchantSessionId: string;
      cpi: string;
      merchantCallbackUrl?: string;
      merchantChallengeId?: string;
      nextDeviceTrust: string | null;
    }
  | { ok: false; status: number; body: unknown };

function readReturnCode(
  session: SsoSessionItem,
  body: Record<string, unknown>,
  now: number
):
  | { ok: true; returnCode: string; challengeProfile: SsoLegProfile }
  | { ok: false; status: 401 | 409; body: unknown } {
  if (!session.challengeProfile || !session.returnCodeHash || !session.returnCodeExpiresAt) {
    return { ok: false, status: 409, body: { error: 'sso_challenge_not_completed' } };
  }
  if (session.returnCodeConsumedAt) {
    return { ok: false, status: 409, body: { error: 'sso_return_code_consumed' } };
  }
  const returnCode = typeof body.returnCode === 'string' ? body.returnCode : '';
  if (!returnCode || hashSsoReturnCode(returnCode) !== session.returnCodeHash) {
    return { ok: false, status: 401, body: { error: 'sso_return_code_invalid' } };
  }
  if (now > session.returnCodeExpiresAt) {
    return { ok: false, status: 401, body: { error: 'sso_return_code_expired' } };
  }
  return { ok: true, returnCode, challengeProfile: session.challengeProfile };
}

/** Application boundary for POST /api/sso/{id}/validate. */
export async function validateSsoSession(
  sessionId: string,
  body: Record<string, unknown>,
  requesterIp: string,
  deps: SsoValidationDependencies
): Promise<SsoValidationResult> {
  const session = await deps.loadSession(sessionId);
  if (!session) return { ok: false, status: 404, body: { error: 'sso_session_not_found' } };

  const now = deps.nowEpochSeconds();
  const code = readReturnCode(session, body, now);
  if (!code.ok) return code;

  const checked = deps.validateAttestation(body, {
    role: 'merchant-validate',
    sessionId,
    nonce: session.nonce,
    returnCode: code.returnCode,
    cpi: session.cpi,
  });
  if (!checked.ok) return { ok: false, status: checked.status, body: checked.body };

  const argusSessionId = body.argusSessionId as string;
  const scan = classifyScan(await deps.fetchProjection(argusSessionId), 'sso_validate');
  const phoneCheck = requirePhoneSsoScan(
    scan,
    'validate',
    ssoFailureReturn(sessionId, session.cpi, session)
  );
  if (!phoneCheck.ok) return phoneCheck;

  const validateProfile = ssoProfileFromScan(argusSessionId, checked.attestation, scan);
  const proof = await deps.verifyProof({
    body,
    requesterIp,
    attestation: checked.attestation,
    nonce: session.nonce,
    proofRequired: session.proofRequired,
    freshProofRequired: session.freshProofRequired,
  });
  if (!proof.ok) return proof;

  const verdict = evaluateSsoContinuity({
    start: session.startProfile,
    challenge: code.challengeProfile,
    validate: validateProfile,
  });
  const approvalToken = verdict.ok ? deps.mintApprovalToken() : null;
  const nextDeviceTrust =
    verdict.ok && !proof.trustRedeemed && proof.annotations.phone_webauthn_attested === true
      ? await deps.mintDeviceTrust(
          checked.attestation.publicKey,
          checked.attestation.keyId,
          requesterIp
        )
      : null;
  await deps.storeValidation({
    sessionId,
    validateProfile,
    verdict: verdict.ok ? 'approved' : 'failed',
    verdictReason: verdict.reason,
    returnCodeConsumedAt: now,
    proofAnnotations: proof.annotations,
    approval:
      verdict.ok && approvalToken
        ? {
            approvedAt: now,
            approvalTokenHash: hashApprovalToken(approvalToken),
            expiresAt: now + deps.approvalTtlSeconds,
          }
        : undefined,
  });
  return {
    ok: true,
    verdict,
    approvalToken,
    merchantSessionId: session.merchantSessionId,
    cpi: session.cpi,
    merchantCallbackUrl: session.merchantCallbackUrl,
    merchantChallengeId: session.merchantChallengeId,
    nextDeviceTrust,
  };
}
