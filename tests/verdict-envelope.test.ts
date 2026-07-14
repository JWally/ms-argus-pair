import { describe, expect, it } from 'vitest';
import {
  FIXED_VERDICT_PLAINTEXT_BYTES,
  openFixedVerdictEnvelope,
  sealFixedVerdictEnvelope,
} from '../src/lib/verdict-envelope';

const KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const OTHER_KEY = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);

describe('fixed verdict envelope', () => {
  it('round-trips a verdict only with the session-bound reveal key', async () => {
    const payload = {
      kind: 'desktop-verdict' as const,
      verdict: 'failed' as const,
      reason: 'projection_stale',
      annotations: { score: 8, worker: 'clean' },
    };
    const sealed = await sealFixedVerdictEnvelope(KEY, 'session-a', payload);

    await expect(openFixedVerdictEnvelope(KEY, 'session-a', sealed)).resolves.toEqual(payload);
    await expect(openFixedVerdictEnvelope(OTHER_KEY, 'session-a', sealed)).rejects.toThrow();
    await expect(openFixedVerdictEnvelope(KEY, 'session-b', sealed)).rejects.toThrow();
  });

  it('does not leak pass/fail through ciphertext length', async () => {
    const paired = await sealFixedVerdictEnvelope(KEY, 'session-a', {
      kind: 'desktop-verdict',
      verdict: 'paired',
      reason: 'ok',
      annotations: {},
    });
    const failed = await sealFixedVerdictEnvelope(KEY, 'session-a', {
      kind: 'desktop-verdict',
      verdict: 'failed',
      reason: 'projection_lookup_failed',
      annotations: { reasons: Array.from({ length: 100 }, (_, index) => `reason-${index}`) },
    });

    expect(paired.ciphertext).toHaveLength(failed.ciphertext.length);
    expect(paired.paddedBytes).toBe(FIXED_VERDICT_PLAINTEXT_BYTES);
    expect(failed.paddedBytes).toBe(FIXED_VERDICT_PLAINTEXT_BYTES);
  });

  it('seals phone-only continuation state without exposing the verdict or trust token', async () => {
    const payload = {
      kind: 'phone-state' as const,
      verdict: 'paired' as const,
      nextDeviceTrust: 'opaque-device-trust',
    };
    const sealed = await sealFixedVerdictEnvelope(KEY, 'session-a', payload);

    expect(JSON.stringify(sealed)).not.toContain('paired');
    expect(JSON.stringify(sealed)).not.toContain('opaque-device-trust');
    await expect(openFixedVerdictEnvelope(KEY, 'session-a', sealed)).resolves.toEqual(payload);
  });

  it('rejects payloads too large for the fixed-size envelope', async () => {
    await expect(
      sealFixedVerdictEnvelope(KEY, 'session-a', {
        kind: 'desktop-verdict',
        verdict: 'failed',
        reason: 'oversized',
        annotations: { oversized: 'x'.repeat(FIXED_VERDICT_PLAINTEXT_BYTES) },
      })
    ).rejects.toThrow('verdict payload exceeds fixed envelope');
  });
});
