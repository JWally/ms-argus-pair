import type { SsoAttestationResult } from './attestation/envelope';
import type { MerchantProjection } from './merchant-projection';
import { classifyScan } from './projection-verdict';
import { parseScopedCpi, requiresProofOfLife } from './scoped-cpi';
import { parseSsoMerchantBinding, ssoFailureReturn } from './sso-merchant-callback';
import { requirePhoneSsoScan, ssoProfileFromScan } from './sso-scan';
import type { SsoSessionItem } from './sso-session';

export interface SsoStartDependencies {
  callbackOrigins: readonly string[];
  validateAttestation(body: Record<string, unknown>, cpi: string): SsoAttestationResult;
  fetchProjection(argusSessionId: string): Promise<MerchantProjection | null>;
  storeSession(session: SsoSessionItem): Promise<void>;
  newSessionId(): string;
  newNonce(): string;
  newMerchantSessionId(): string;
  nowEpochSeconds(): number;
  sessionTtlSeconds: number;
  requireProofOfLife: boolean;
}

export type SsoStartResult =
  | {
      ok: true;
      sessionId: string;
      session: SsoSessionItem;
      failureReturnUrl: string;
    }
  | { ok: false; status: number; body: unknown };

/** Application boundary for POST /api/sso/start. */
export async function startSsoSession(
  body: Record<string, unknown>,
  deps: SsoStartDependencies
): Promise<SsoStartResult> {
  if (body.cpi === undefined) {
    return { ok: false, status: 400, body: { error: 'missing_cpi' } };
  }
  const scopedCpi = parseScopedCpi(body.cpi);
  if (!scopedCpi) return { ok: false, status: 400, body: { error: 'invalid_cpi' } };

  const checked = deps.validateAttestation(body, scopedCpi.cpi);
  if (!checked.ok) return { ok: false, status: checked.status, body: checked.body };

  const sessionId = deps.newSessionId();
  const nonce = deps.newNonce();
  const merchantSessionId =
    typeof body.merchantSessionId === 'string' && body.merchantSessionId.length > 0
      ? body.merchantSessionId.slice(0, 128)
      : deps.newMerchantSessionId();
  const merchantBinding = parseSsoMerchantBinding(body, deps.callbackOrigins);
  if (!merchantBinding.ok) {
    return { ok: false, status: 400, body: { error: 'invalid_sso_merchant_binding' } };
  }

  const failureReturnUrl = ssoFailureReturn(sessionId, scopedCpi.cpi, merchantBinding.value);
  const argusSessionId = body.argusSessionId as string;
  const scan = classifyScan(await deps.fetchProjection(argusSessionId), 'sso_start');
  const phoneCheck = requirePhoneSsoScan(scan, 'start', failureReturnUrl);
  if (!phoneCheck.ok) return phoneCheck;

  const session: SsoSessionItem = {
    PK: `SSO#${sessionId}`,
    SK: 'META',
    nonce,
    merchantSessionId,
    cpi: scopedCpi.cpi,
    ...merchantBinding.value,
    proofRequired: requiresProofOfLife(scopedCpi, deps.requireProofOfLife),
    freshProofRequired: scopedCpi.freshProofRequired,
    startProfile: ssoProfileFromScan(argusSessionId, checked.attestation, scan),
    verdict: 'pending',
    expiresAt: deps.nowEpochSeconds() + deps.sessionTtlSeconds,
  };
  await deps.storeSession(session);
  return { ok: true, sessionId, session, failureReturnUrl };
}
