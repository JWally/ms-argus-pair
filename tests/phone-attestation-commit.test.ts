/**
 * Phone-attestation commit contract.
 *
 * The phone slot is single-writer. A same-device retry may receive the
 * winning completed verdict, while a different scanner must never inherit it.
 * These rules must remain identical across Valkey and DynamoDB.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createPhoneAttestationCommitter,
  type PhoneAttestationCommitDependencies,
} from '../cdk/lib/pair-api/phone-attestation-commit';
import type { StoredPairAttestation } from '../cdk/lib/pair-api/desktop-attest';

const SESSION_ID = 'pair-session-1';
const STORED = {
  argusSessionId: 'argus-phone-1',
  envelope: 'phone-envelope',
  signature: 'signature',
  publicKey: 'phone-public-key',
  keyId: 'phone-key-id',
  receivedAt: 123,
  envelopeDecoded: {
    v: 1,
    purpose: 'argus-pair-v1',
    payload: {},
    iat: 100,
    exp: 200,
    keyId: 'phone-key-id',
  },
} satisfies StoredPairAttestation;

const INPUT = {
  sessionId: SESSION_ID,
  stored: STORED,
  verdict: 'paired' as const,
  reason: 'paired_desktop_and_phone',
  annotations: { proof_of_life: true },
};

function dependencies(
  overrides: Partial<PhoneAttestationCommitDependencies> = {}
): PhoneAttestationCommitDependencies {
  return {
    useValkey: () => true,
    recordValkey: vi.fn().mockResolvedValue({ ok: true }),
    updateDdb: vi.fn().mockResolvedValue(undefined),
    loadSession: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

describe('Valkey phone-attestation commit', () => {
  it('atomically writes the attestation and verdict as one bundle', async () => {
    const deps = dependencies();

    await expect(createPhoneAttestationCommitter(deps)(INPUT)).resolves.toEqual({
      outcome: 'committed',
    });
    expect(deps.recordValkey).toHaveBeenCalledWith(SESSION_ID, {
      att: STORED,
      verdict: 'paired',
      reason: 'paired_desktop_and_phone',
      annotations: { proof_of_life: true },
    });
    expect(deps.updateDdb).not.toHaveBeenCalled();
  });

  it('recognizes a completed same-device retry', async () => {
    const deps = dependencies({
      recordValkey: vi.fn().mockResolvedValue({
        ok: false,
        existing: {
          att: { publicKey: STORED.publicKey },
          verdict: 'failed',
          reason: 'phone_on_proxy',
          annotations: {},
        },
      }),
    });

    await expect(createPhoneAttestationCommitter(deps)(INPUT)).resolves.toEqual({
      outcome: 'same_device_retry',
    });
  });

  it('distinguishes a different scanner from an idempotent retry', async () => {
    const deps = dependencies({
      recordValkey: vi.fn().mockResolvedValue({
        ok: false,
        existing: {
          att: { publicKey: 'other-public-key' },
          verdict: 'paired',
          reason: 'paired_desktop_and_phone',
          annotations: {},
        },
      }),
    });

    await expect(createPhoneAttestationCommitter(deps)(INPUT)).resolves.toEqual({
      outcome: 'other_device',
    });
  });

  it('keeps ambiguous or pending Valkey races fail-closed', async () => {
    const deps = dependencies({
      recordValkey: vi.fn().mockResolvedValue({
        ok: false,
        existing: {
          att: { publicKey: STORED.publicKey },
          verdict: 'pending',
          reason: null,
          annotations: {},
        },
      }),
    });

    await expect(createPhoneAttestationCommitter(deps)(INPUT)).resolves.toEqual({
      outcome: 'write_conflict',
    });
  });

  it('treats an occupied malformed bundle as another device', async () => {
    const deps = dependencies({
      recordValkey: vi.fn().mockResolvedValue({
        ok: false,
        existing: { att: {}, verdict: 'paired', reason: null, annotations: {} },
      }),
    });

    await expect(createPhoneAttestationCommitter(deps)(INPUT)).resolves.toEqual({
      outcome: 'other_device',
    });
  });
});

describe('DynamoDB phone-attestation commit', () => {
  it('uses the conditional session-row update when Valkey is disabled', async () => {
    const deps = dependencies({ useValkey: () => false });

    await expect(createPhoneAttestationCommitter(deps)(INPUT)).resolves.toEqual({
      outcome: 'committed',
    });
    expect(deps.updateDdb).toHaveBeenCalledWith(INPUT);
    expect(deps.recordValkey).not.toHaveBeenCalled();
  });

  it.each([
    ['same_device_retry', STORED.publicKey, 'paired'],
    ['other_device', 'other-public-key', 'failed'],
    ['write_conflict', STORED.publicKey, 'pending'],
  ] as const)('maps a lost conditional race to %s', async (outcome, publicKey, verdict) => {
    const conditionalConflict = Object.assign(new Error('lost race'), {
      name: 'ConditionalCheckFailedException',
    });
    const deps = dependencies({
      useValkey: () => false,
      updateDdb: vi.fn().mockRejectedValue(conditionalConflict),
      loadSession: vi.fn().mockResolvedValue({
        phoneAttestation: { publicKey },
        verdict,
      }),
    });

    await expect(createPhoneAttestationCommitter(deps)(INPUT)).resolves.toEqual({ outcome });
    expect(deps.loadSession).toHaveBeenCalledWith(SESSION_ID);
  });

  it('does not disguise an unexpected storage failure as a race', async () => {
    const storageFailure = new Error('DynamoDB unavailable');
    const deps = dependencies({
      useValkey: () => false,
      updateDdb: vi.fn().mockRejectedValue(storageFailure),
    });

    await expect(createPhoneAttestationCommitter(deps)(INPUT)).rejects.toBe(storageFailure);
    expect(deps.loadSession).not.toHaveBeenCalled();
  });
});
