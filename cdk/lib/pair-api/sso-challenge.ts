import type { ReturnCode, SsoLegProfile } from '../sso-continuity';
import type { SsoAttestationResult } from './attestation/envelope';
import type { MerchantProjection } from './merchant-projection';
import { classifyScan } from './projection-verdict';
import { ssoFailureReturn } from './sso-merchant-callback';
import { hashSsoReturnCode, requirePhoneSsoScan, ssoProfileFromScan } from './sso-scan';
import type { SsoSessionItem } from './sso-session';

interface SsoChallengeAttestationExpectation {
  role: 'argus-challenge';
  sessionId: string;
  nonce: string;
  cpi: string;
}

export interface StoredSsoChallenge {
  sessionId: string;
  challengeProfile: SsoLegProfile;
  returnCodeHash: string;
  returnCodeExpiresAt: number;
}

export interface SsoChallengeDependencies {
  loadSession(sessionId: string): Promise<SsoSessionItem | null>;
  validateAttestation(
    body: Record<string, unknown>,
    expected: SsoChallengeAttestationExpectation
  ): SsoAttestationResult;
  fetchProjection(argusSessionId: string): Promise<MerchantProjection | null>;
  mintReturnCode(sessionId: string): ReturnCode;
  storeChallenge(challenge: StoredSsoChallenge): Promise<void>;
}

export type SsoChallengeResult =
  | {
      ok: true;
      sessionId: string;
      returnCode: string;
      cpi: string;
      hasMerchantCallback: boolean;
    }
  | { ok: false; status: number; body: unknown };

/** Application boundary for POST /api/sso/{id}/challenge. */
export async function challengeSsoSession(
  sessionId: string,
  body: Record<string, unknown>,
  deps: SsoChallengeDependencies
): Promise<SsoChallengeResult> {
  const session = await deps.loadSession(sessionId);
  if (!session) return { ok: false, status: 404, body: { error: 'sso_session_not_found' } };
  if (session.challengeProfile) {
    return { ok: false, status: 409, body: { error: 'sso_challenge_already_completed' } };
  }

  const failureReturnUrl = ssoFailureReturn(sessionId, session.cpi, session);
  const checked = deps.validateAttestation(body, {
    role: 'argus-challenge',
    sessionId,
    nonce: session.nonce,
    cpi: session.cpi,
  });
  if (!checked.ok) return { ok: false, status: checked.status, body: checked.body };

  const argusSessionId = body.argusSessionId as string;
  const scan = classifyScan(await deps.fetchProjection(argusSessionId), 'sso_challenge');
  const phoneCheck = requirePhoneSsoScan(scan, 'challenge', failureReturnUrl);
  if (!phoneCheck.ok) return phoneCheck;

  const code = deps.mintReturnCode(sessionId);
  await deps.storeChallenge({
    sessionId,
    challengeProfile: ssoProfileFromScan(argusSessionId, checked.attestation, scan),
    returnCodeHash: hashSsoReturnCode(code.value),
    returnCodeExpiresAt: Math.floor(code.expiresAt / 1000),
  });
  return {
    ok: true,
    sessionId,
    returnCode: code.value,
    cpi: session.cpi,
    hasMerchantCallback: !!session.merchantCallbackUrl,
  };
}
