import type { PhoneBundle } from '../session-store';
import type { StoredPairAttestation } from './desktop-attest';

export interface PhoneAttestationCommitInput {
  sessionId: string;
  stored: StoredPairAttestation;
  verdict: 'paired' | 'failed';
  reason: string;
  annotations: Record<string, unknown>;
}

interface ExistingPhoneDecision {
  phoneAttestation?: { publicKey?: string };
  verdict?: 'pending' | 'paired' | 'failed';
}

type StoredPhoneBundle = PhoneBundle<StoredPairAttestation>;
type ValkeyCommitResult = { ok: true } | { ok: false; existing: StoredPhoneBundle | null };
export interface PhoneAttestationCommitDependencies {
  useValkey(): boolean;
  recordValkey(sessionId: string, bundle: StoredPhoneBundle): Promise<ValkeyCommitResult>;
  updateDdb(input: PhoneAttestationCommitInput): Promise<void>;
  loadSession(sessionId: string): Promise<ExistingPhoneDecision | null>;
}

export type PhoneAttestationCommitOutcome =
  | { outcome: 'committed' }
  | { outcome: 'same_device_retry' }
  | { outcome: 'other_device' }
  | { outcome: 'write_conflict' };

function raceOutcome(
  hasExistingAttestation: boolean,
  existingPublicKey: string | undefined,
  existingVerdict: 'pending' | 'paired' | 'failed' | undefined,
  submittedPublicKey: string
): PhoneAttestationCommitOutcome {
  const isSameDevice = existingPublicKey === submittedPublicKey;
  if (hasExistingAttestation && !isSameDevice) return { outcome: 'other_device' };
  if (isSameDevice && existingVerdict && existingVerdict !== 'pending') {
    return { outcome: 'same_device_retry' };
  }
  return { outcome: 'write_conflict' };
}

function phoneBundle(input: PhoneAttestationCommitInput): StoredPhoneBundle {
  return {
    att: input.stored,
    verdict: input.verdict,
    reason: input.reason,
    annotations: input.annotations,
  };
}

/** Commit the single-writer phone slot with backend-independent race semantics. */
export function createPhoneAttestationCommitter(deps: PhoneAttestationCommitDependencies) {
  return async (input: PhoneAttestationCommitInput): Promise<PhoneAttestationCommitOutcome> => {
    if (deps.useValkey()) {
      const result = await deps.recordValkey(input.sessionId, phoneBundle(input));
      if (result.ok) return { outcome: 'committed' };
      const existing = result.existing;
      return raceOutcome(
        !!existing?.att,
        existing?.att.publicKey,
        existing?.verdict,
        input.stored.publicKey
      );
    }

    try {
      await deps.updateDdb(input);
      return { outcome: 'committed' };
    } catch (error: unknown) {
      if ((error as { name?: string })?.name !== 'ConditionalCheckFailedException') throw error;
      const existing = await deps.loadSession(input.sessionId);
      return raceOutcome(
        !!existing?.phoneAttestation,
        existing?.phoneAttestation?.publicKey,
        existing?.verdict,
        input.stored.publicKey
      );
    }
  };
}
