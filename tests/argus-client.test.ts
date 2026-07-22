import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  baseIntegrityCpi,
  runArgusAttestation,
  runArgusScan,
  type ArgusRunResult,
} from '../src/lib/argus-client';

function successfulRun(): ArgusRunResult {
  return {
    sessionId: 'sdk-session',
    argusSessionId: 'argus-session',
    durationMs: 12,
    attestation: {
      envelope: 'envelope',
      signature: 'signature',
      publicKey: 'public-key',
      keyId: 'key-id',
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Argus browser client', () => {
  it.each([
    ['merchant-cpi.fastpass', 'merchant-cpi'],
    ['merchant-cpi.stepup', 'merchant-cpi'],
    ['merchant-cpi.forceauth', 'merchant-cpi'],
    ['merchant-cpi', 'merchant-cpi'],
  ])('maps scoped CPI %s to integrity CPI %s', (scopedCpi, expected) => {
    expect(baseIntegrityCpi(scopedCpi)).toBe(expected);
  });

  it('waits for the signed bootstrap before reading or running the SDK', async () => {
    let releaseBootstrap!: () => void;
    const argusBootstrapReady = new Promise<void>((resolve) => {
      releaseBootstrap = resolve;
    });
    const run = vi.fn(async () => successfulRun());
    const browserWindow: Record<string, unknown> = { argusBootstrapReady };
    vi.stubGlobal('window', browserWindow);

    const pending = runArgusScan({ cpi: 'merchant-cpi', payload: { role: 'phone' } });
    await Promise.resolve();
    expect(run).not.toHaveBeenCalled();

    browserWindow.argus = { run };
    releaseBootstrap();

    await expect(pending).resolves.toMatchObject({ argusSessionId: 'argus-session' });
    expect(run).toHaveBeenCalledWith({
      cpi: 'merchant-cpi',
      timeoutMs: 30_000,
      attest: {
        purpose: 'argus-pair-v1',
        ttlSeconds: 120,
        payload: { role: 'phone' },
      },
    });
  });

  it('fails closed when bootstrap completes without installing the SDK', async () => {
    vi.stubGlobal('window', { argusBootstrapReady: Promise.resolve() });

    await expect(
      runArgusScan({ cpi: 'merchant-cpi', payload: { role: 'desktop' } })
    ).rejects.toThrow('argus SDK not loaded');
  });

  it('requires a signed attestation for callers that need an attested leg', async () => {
    vi.stubGlobal('window', {
      argusBootstrapReady: Promise.resolve(),
      argus: {
        run: vi.fn(async () => ({
          sessionId: 'sdk-session',
          argusSessionId: 'argus-session',
          durationMs: 12,
          attestation: null,
          attestError: 'signing unavailable',
        })),
      },
    });

    await expect(
      runArgusAttestation({ cpi: 'merchant-cpi', payload: { role: 'merchant-start' } })
    ).rejects.toThrow('argus attestation failed: signing unavailable');
  });
});
