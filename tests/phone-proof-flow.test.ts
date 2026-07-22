import { describe, expect, it, vi } from 'vitest';
import {
  runPhoneProofFlow,
  type PhoneProofFlowDependencies,
  type PhoneProofFlowState,
  type PhoneProofPairOperations,
  type PhoneProofUpdateMode,
} from '../src/lib/phone-proof-flow';
import type { PhoneAttestationResponse } from '../src/lib/phone-attestation';
import type { PhoneSessionInfo } from '../src/lib/phone-session-runtime';
import type { WsConnection } from '../src/lib/ws';

function phoneInfo(overrides: Partial<PhoneSessionInfo> = {}): PhoneSessionInfo {
  return {
    nonce: 'phone-nonce',
    proofRequired: true,
    freshProofRequired: false,
    expiresAt: 300,
    desktopArgusSessionId: 'desktop-argus-session',
    desktopKeyId: 'desktop-key',
    desktopEnvelope: 'desktop-envelope',
    phoneToken: 'phone-token',
    conn: { sessionId: 'pair-session' } as WsConnection,
    getVerdictRevealKey: vi.fn(async () => 'reveal-key'),
    getScanPromise: vi.fn(async () => ({
      sessionId: 'pair-session',
      argusSessionId: 'phone-argus-session',
      durationMs: 10,
    })),
    ...overrides,
  };
}

interface Harness {
  state: PhoneProofFlowState;
  deps: PhoneProofFlowDependencies;
  submit: ReturnType<typeof vi.fn<PhoneProofPairOperations['submitPhoneAttestation']>>;
  clearPasskeyHint: ReturnType<typeof vi.fn>;
  runGoogleProof: ReturnType<typeof vi.fn<PhoneProofFlowDependencies['runGoogleProof']>>;
  recordPerf: ReturnType<typeof vi.fn>;
  flushPerf: ReturnType<typeof vi.fn>;
  scheduleFinalize: ReturnType<typeof vi.fn>;
  updates: PhoneProofUpdateMode[];
}

function harness(response: Partial<PhoneAttestationResponse> = {}): Harness {
  const state: PhoneProofFlowState = {
    info: phoneInfo(),
    phase: 'ready',
    status: '',
    verdict: null,
    errorMsg: null,
    hasTrust: false,
    inflight: false,
  };
  const submit = vi.fn<PhoneProofPairOperations['submitPhoneAttestation']>(async () => ({
    verdict: 'paired',
    reason: null,
    ...response,
  }));
  const clearPasskeyHint = vi.fn();
  const runGoogleProof = vi.fn<PhoneProofFlowDependencies['runGoogleProof']>(async () => ({
    ok: true,
    proof: { provider: 'google', token: 'google-token' },
  }));
  const recordPerf = vi.fn();
  const flushPerf = vi.fn();
  const scheduleFinalize = vi.fn();
  const updates: PhoneProofUpdateMode[] = [];
  const pairOperations: PhoneProofPairOperations = {
    submitPhoneAttestation: submit,
    clearPasskeyHint,
  };
  const deps: PhoneProofFlowDependencies = {
    getState: () => state,
    getPairOperations: () => pairOperations,
    runGoogleProof,
    updateState: (patch, mode) => {
      Object.assign(state, patch);
      updates.push(mode);
    },
    recordPerf,
    flushPerf,
    scheduleFinalize,
  };
  return {
    state,
    deps,
    submit,
    clearPasskeyHint,
    runGoogleProof,
    recordPerf,
    flushPerf,
    scheduleFinalize,
    updates,
  };
}

describe('phone proof selection', () => {
  it.each([
    ['passkey', 'passkey-auth'],
    ['passkey-create', 'passkey-create'],
    ['integrity', 'integrity'],
  ] as const)('maps %s to the explicit attestation mode %s', async (proofMode, mode) => {
    const test = harness();

    await runPhoneProofFlow({ sessionId: 'pair-session', proofMode }, test.deps);

    const [sessionId, info, events, options] = test.submit.mock.calls[0]!;
    expect(sessionId).toBe('pair-session');
    expect(info).toBe(test.state.info);
    expect(events.onStatus).toBeTypeOf('function');
    expect(options).toEqual({ mode, trustOnly: undefined });
  });

  it('binds Google proof to the nonce and submits it beside integrity evidence', async () => {
    const test = harness();

    await runPhoneProofFlow({ sessionId: 'pair-session', proofMode: 'google' }, test.deps);

    expect(test.runGoogleProof).toHaveBeenCalledWith('phone-nonce');
    expect(test.submit.mock.calls[0]?.[3]).toEqual({
      mode: 'oauth',
      oauthResult: { provider: 'google', token: 'google-token' },
      trustOnly: undefined,
    });
  });

  it('returns to proof choices when Google produces no credential', async () => {
    const test = harness();
    test.runGoogleProof.mockResolvedValue({ ok: false, errorMessage: 'prompt_timeout' });

    await runPhoneProofFlow({ sessionId: 'pair-session', proofMode: 'google' }, test.deps);

    expect(test.submit).not.toHaveBeenCalled();
    expect(test.state).toMatchObject({
      phase: 'ready',
      errorMsg: 'prompt_timeout',
      inflight: false,
    });
  });
});

describe('phone proof presentation', () => {
  it('reports progress and completes an interactive proof in the foreground', async () => {
    const finalizeAfterDone = vi.fn(async () => 'paired' as const);
    const test = harness({ finalizeAfterDone });
    test.submit.mockImplementation(async (_sessionId, _info, events) => {
      events.onStatus?.('verifying');
      return { verdict: 'paired', reason: null, finalizeAfterDone };
    });

    await runPhoneProofFlow({ sessionId: 'pair-session' }, test.deps);

    expect(test.state).toMatchObject({
      phase: 'paired',
      status: 'done',
      verdict: 'paired',
      inflight: false,
      finalizeAfterDone,
    });
    expect(test.updates).toContain('render');
    expect(test.scheduleFinalize).toHaveBeenCalledWith(1500);
    expect(test.recordPerf).toHaveBeenCalledWith('attest_done', {
      verdict: 'paired',
      trustOnly: false,
    });
    expect(test.flushPerf).toHaveBeenCalledWith('attest_done');
  });

  it('keeps a background integrity result decision-blind on the drawing board', async () => {
    const test = harness({ verdict: 'failed' });

    await runPhoneProofFlow(
      {
        sessionId: 'pair-session',
        proofMode: 'integrity',
        keepDrawingBoard: true,
        trustOnly: true,
      },
      test.deps
    );

    expect(test.submit.mock.calls[0]?.[3]).toEqual({
      mode: 'integrity',
      trustOnly: true,
    });
    expect(test.state).toMatchObject({ phase: 'challenge', status: 'done', verdict: 'failed' });
    expect(test.updates).toContain('drawing');
    expect(test.scheduleFinalize).not.toHaveBeenCalled();
  });

  it('clears a stale discoverable-passkey hint after server rejection', async () => {
    const test = harness({
      annotations: { phone_webauthn_error: 'credential_not_registered' },
    });

    await runPhoneProofFlow({ sessionId: 'pair-session', proofMode: 'passkey' }, test.deps);

    expect(test.clearPasskeyHint).toHaveBeenCalledOnce();
  });
});

describe('phone proof failure and guards', () => {
  it('expires a failed silent trust attempt back to explicit proof choices', async () => {
    const test = harness();
    test.state.hasTrust = true;
    test.state.status = 'verifying';
    test.submit.mockRejectedValue(new Error('device_trust_unavailable'));

    await runPhoneProofFlow(
      {
        sessionId: 'pair-session',
        proofMode: 'passkey',
        keepDrawingBoard: true,
        trustOnly: true,
      },
      test.deps
    );

    expect(test.state).toMatchObject({
      phase: 'ready',
      status: '',
      hasTrust: false,
      inflight: false,
      errorMsg: 'Trusted device expired. Choose a check.',
    });
    expect(test.recordPerf).toHaveBeenCalledWith('pair_error', {
      trustOnly: true,
      error: 'device_trust_unavailable',
    });
  });

  it('does nothing without a complete idle runtime', async () => {
    const test = harness();
    test.state.inflight = true;

    await runPhoneProofFlow({ sessionId: 'pair-session' }, test.deps);
    await runPhoneProofFlow({ sessionId: null }, test.deps);

    expect(test.submit).not.toHaveBeenCalled();
    expect(test.recordPerf).not.toHaveBeenCalled();
  });
});
