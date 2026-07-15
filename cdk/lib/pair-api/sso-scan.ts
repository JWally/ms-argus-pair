import { createHash } from 'crypto';
import type { SsoLegProfile } from '../sso-continuity';
import type { AttestationInput } from './attestation/envelope';
import type { ClassifiedScan } from './projection-verdict';
import { jsonResp } from './shared/http';

export type SsoScanLeg = 'start' | 'challenge' | 'validate';

export function ssoProfileFromScan(
  argusSessionId: string,
  attestation: AttestationInput,
  scan: ClassifiedScan | null
): SsoLegProfile {
  return {
    argusSessionId,
    keyId: attestation.keyId,
    ip: scan?.ip ?? null,
    asnName: scan?.asnName ?? null,
    country: scan?.country ?? null,
    city: scan?.city ?? null,
    score: scan?.individualScore ?? null,
    isPhone: scan?.isPhone === true,
    isProxy: scan?.isProxy ?? false,
    isDatacenter: scan?.isDatacenter ?? false,
    isVpn: scan?.isVpn ?? false,
  };
}

export function requirePhoneSsoScan(
  scan: ClassifiedScan | null,
  leg: SsoScanLeg,
  failureReturnUrl?: string
): { ok: true } | { ok: false; response: ReturnType<typeof jsonResp> } {
  if (scan?.isPhone === true) return { ok: true };
  return {
    ok: false,
    response: jsonResp(403, {
      error: 'sso_requires_phone',
      leg,
      message: 'SSO is only available from phone-classified Argus scans.',
      ...(failureReturnUrl ? { failureReturnUrl } : {}),
    }),
  };
}

export function hashSsoReturnCode(code: string): string {
  return createHash('sha256').update(`argus-pair-sso-return:${code}`).digest('hex');
}
