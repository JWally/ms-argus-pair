import type { SsoLegProfile } from '../sso-continuity';

export interface SsoSessionItem {
  PK: string;
  SK: 'META';
  nonce: string;
  merchantSessionId: string;
  cpi: string;
  merchantChallengeId?: string;
  merchantCallbackUrl?: string;
  proofRequired: boolean;
  freshProofRequired: boolean;
  startProfile: SsoLegProfile;
  challengeProfile?: SsoLegProfile;
  validateProfile?: SsoLegProfile;
  returnCodeHash?: string;
  returnCodeExpiresAt?: number;
  returnCodeConsumedAt?: number;
  approvalTokenHash?: string;
  approvalRedeemedAt?: number;
  verdict: 'pending' | 'approved' | 'failed';
  verdictReason?: string;
  expiresAt: number;
  approvedAt?: number;
}
