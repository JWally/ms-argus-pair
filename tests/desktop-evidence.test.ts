import { describe, expect, it, vi } from 'vitest';
import {
  startDesktopEvidence,
  type DesktopEvidenceCallbacks,
  type DesktopEvidenceDependencies,
  type DesktopEvidenceInput,
  type HostPreflightScan,
} from '../src/lib/desktop-evidence';
import type { ArgusRunResult } from '../src/lib/argus-client';

const INPUT: DesktopEvidenceInput = {
  sessionId: 'pair-session-1',
  nonce: 'pair-nonce-1',
  expiresAt: 1_900_000_000,
  cpi: 'argus_cpi_test_UEeqk7Bk7uetxKKDxNmIdB.stepup',
};

const ATTESTED_RUN: ArgusRunResult = {
  sessionId: 'scan-session-1',
  argusSessionId: 'argus-session-1',
  durationMs: 12,
  attestation: {
    envelope: 'attestation-envelope',
    signature: 'attestation-signature',
    publicKey: 'attestation-public-key',
    keyId: 'desktop-key-1',
  },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function dependencies(overrides: Partial<DesktopEvidenceDependencies> = {}) {
  return {
    runScan: vi.fn().mockResolvedValue(ATTESTED_RUN),
    postAttestation: vi.fn().mockResolvedValue({
      ok: true,
      clean: true,
      summary: { score: 4, browser_name: 'Chrome' },
    }),
    ...overrides,
  } satisfies DesktopEvidenceDependencies;
}

function callbacks(overrides: Partial<DesktopEvidenceCallbacks> = {}) {
  return {
    isCancelled: vi.fn(() => false),
    onDesktopAttested: vi.fn(),
    queueDesktopReady: vi.fn(),
    onError: vi.fn(),
    fail: vi.fn(),
    ...overrides,
  } satisfies DesktopEvidenceCallbacks;
}

describe('startDesktopEvidence', () => {
  it('starts integrity and required host evidence immediately, then submits their binding', async () => {
    const scan = deferred<ArgusRunResult>();
    const host = deferred<HostPreflightScan>();
    const requestHostPreflight = vi.fn(() => host.promise);
    const deps = dependencies({ runScan: vi.fn(() => scan.promise) });
    const task = startDesktopEvidence(
      { ...INPUT, hostPreflightRequired: true, requestHostPreflight },
      deps
    );

    expect(deps.runScan).toHaveBeenCalledWith({
      cpi: 'argus_cpi_test_UEeqk7Bk7uetxKKDxNmIdB',
      payload: {
        sessionId: INPUT.sessionId,
        nonce: INPUT.nonce,
        role: 'desktop',
      },
    });
    expect(requestHostPreflight).toHaveBeenCalledWith({ pairSessionId: INPUT.sessionId });
    expect(deps.postAttestation).not.toHaveBeenCalled();

    const sink = callbacks();
    const completion = task.complete(sink);
    const hostScan: HostPreflightScan = {
      argusSessionId: 'host-argus-session-1',
      attestation: ATTESTED_RUN.attestation!,
    };
    scan.resolve(ATTESTED_RUN);
    host.resolve(hostScan);
    await completion;

    expect(deps.postAttestation).toHaveBeenCalledWith(INPUT.sessionId, {
      argusSessionId: ATTESTED_RUN.argusSessionId,
      attestation: ATTESTED_RUN.attestation,
      hostPreflight: hostScan,
    });
    expect(sink.onDesktopAttested).toHaveBeenCalledWith({
      clean: true,
      summary: { score: 4, browser_name: 'Chrome' },
    });
    expect(sink.queueDesktopReady).toHaveBeenCalledWith({
      kind: 'desktop-ready',
      nonce: INPUT.nonce,
      expiresAt: INPUT.expiresAt,
      desktopArgusSessionId: ATTESTED_RUN.argusSessionId,
      desktopKeyId: ATTESTED_RUN.attestation?.keyId,
    });
    expect(sink.onError).not.toHaveBeenCalled();
    expect(sink.fail).not.toHaveBeenCalled();
  });

  it('submits isolated desktop evidence without merchant preflight', async () => {
    const deps = dependencies();
    const sink = callbacks();

    await startDesktopEvidence(INPUT, deps).complete(sink);

    expect(deps.postAttestation).toHaveBeenCalledWith(INPUT.sessionId, {
      argusSessionId: ATTESTED_RUN.argusSessionId,
      attestation: ATTESTED_RUN.attestation,
    });
  });
});

describe('desktop evidence failure handling', () => {
  it('fails closed when required host preflight has no callback', async () => {
    const deps = dependencies();
    const sink = callbacks();

    await startDesktopEvidence({ ...INPUT, hostPreflightRequired: true }, deps).complete(sink);

    expect(deps.postAttestation).not.toHaveBeenCalled();
    expect(sink.onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'host preflight callback missing' })
    );
    expect(sink.fail).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'host preflight callback missing' })
    );
  });

  it('fails closed when the integrity scan has no attestation', async () => {
    const deps = dependencies({
      runScan: vi.fn().mockResolvedValue({
        ...ATTESTED_RUN,
        attestation: null,
        attestError: 'signing unavailable',
      }),
    });
    const sink = callbacks();

    await startDesktopEvidence(INPUT, deps).complete(sink);

    expect(deps.postAttestation).not.toHaveBeenCalled();
    expect(sink.fail).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'argus attestation failed: signing unavailable' })
    );
  });

  it('does not submit evidence after the desktop runtime is cancelled', async () => {
    const scan = deferred<ArgusRunResult>();
    const deps = dependencies({ runScan: vi.fn(() => scan.promise) });
    const sink = callbacks({ isCancelled: vi.fn(() => true) });
    const completion = startDesktopEvidence(INPUT, deps).complete(sink);

    scan.resolve(ATTESTED_RUN);
    await completion;

    expect(deps.postAttestation).not.toHaveBeenCalled();
    expect(sink.onDesktopAttested).not.toHaveBeenCalled();
    expect(sink.queueDesktopReady).not.toHaveBeenCalled();
    expect(sink.onError).not.toHaveBeenCalled();
    expect(sink.fail).not.toHaveBeenCalled();
  });

  it('routes scan and submission failures through the runtime error boundary', async () => {
    const scanError = new Error('scan failed');
    const scanDeps = dependencies({ runScan: vi.fn().mockRejectedValue(scanError) });
    const scanSink = callbacks();
    await startDesktopEvidence(INPUT, scanDeps).complete(scanSink);
    expect(scanSink.onError).toHaveBeenCalledWith(scanError);
    expect(scanSink.fail).toHaveBeenCalledWith(scanError);

    const submitError = new Error('desktop-attest unavailable');
    const submitDeps = dependencies({
      postAttestation: vi.fn().mockRejectedValue(submitError),
    });
    const submitSink = callbacks();
    await startDesktopEvidence(INPUT, submitDeps).complete(submitSink);
    expect(submitSink.onError).toHaveBeenCalledWith(submitError);
    expect(submitSink.fail).toHaveBeenCalledWith(submitError);
  });
});
