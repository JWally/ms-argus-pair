import type { PairEvents, PhoneSessionInfo, SubmitPhoneAttestationOptions } from './pair';
import type { PhoneAttestationResponse } from './phone-attestation';
import type { PhoneOauthProof } from './phone-attestation-body';
import { decidePhonePairFailure, type PhoneProofMode } from './phone-pair-failure';
import type { PhonePhase } from './phone-view';

export interface PhoneProofFlowState {
  info: PhoneSessionInfo | null;
  phase: PhonePhase;
  status: string;
  verdict: string | null;
  errorMsg: string | null;
  hasTrust: boolean;
  inflight: boolean;
  finalizeAfterDone?: () => Promise<'paired' | 'failed' | null>;
}

export interface PhoneProofPairOperations {
  submitPhoneAttestation(
    sessionId: string,
    info: PhoneSessionInfo,
    events: PairEvents,
    options: SubmitPhoneAttestationOptions
  ): Promise<PhoneAttestationResponse>;
  clearPasskeyHint(): void;
}

export type PhoneProofUpdateMode = 'render' | 'drawing' | 'silent';

export type GoogleProofAttempt =
  | { ok: true; proof: PhoneOauthProof }
  | { ok: false; errorMessage: string };

export interface PhoneProofFlowDependencies {
  getState(): PhoneProofFlowState;
  getPairOperations(): PhoneProofPairOperations | undefined;
  runGoogleProof(nonce: string): Promise<GoogleProofAttempt>;
  updateState(patch: Partial<PhoneProofFlowState>, mode: PhoneProofUpdateMode): void;
  recordPerf(event: string, extra?: Record<string, unknown>): void;
  flushPerf(reason: string): void;
  scheduleFinalize(delayMs: number): void;
}

export interface PhoneProofRequest {
  sessionId: string | null;
  proofMode?: PhoneProofMode;
  keepDrawingBoard?: boolean;
  trustOnly?: boolean;
}

function beginProof(
  request: Required<Pick<PhoneProofRequest, 'proofMode' | 'keepDrawingBoard' | 'trustOnly'>>,
  state: PhoneProofFlowState,
  deps: PhoneProofFlowDependencies
): void {
  deps.recordPerf('pair_start', {
    proofMode: request.proofMode,
    trustOnly: request.trustOnly,
  });
  deps.updateState({ inflight: true }, 'silent');
  const patch: Partial<PhoneProofFlowState> = {
    status: 'starting',
    errorMsg: null,
  };
  if (!request.keepDrawingBoard) {
    patch.phase = state.hasTrust && !state.info?.freshProofRequired ? 'returning' : 'pairing';
  }
  deps.updateState(patch, request.keepDrawingBoard ? 'drawing' : 'render');
}

function proofEvents(keepDrawingBoard: boolean, deps: PhoneProofFlowDependencies): PairEvents {
  return {
    onStatus: (status) => {
      deps.updateState({ status }, keepDrawingBoard ? 'drawing' : 'render');
    },
  };
}

function baseAttestationOptions(proofMode: PhoneProofMode): SubmitPhoneAttestationOptions {
  const passkeyMode = proofMode === 'passkey-create' ? 'passkey-create' : 'passkey-auth';
  return {
    mode: proofMode === 'integrity' ? 'integrity' : proofMode === 'google' ? 'oauth' : passkeyMode,
  };
}

async function attestationOptions(
  proofMode: PhoneProofMode,
  info: PhoneSessionInfo,
  trustOnly: boolean | undefined,
  deps: PhoneProofFlowDependencies
): Promise<SubmitPhoneAttestationOptions | null> {
  const options = baseAttestationOptions(proofMode);
  if (proofMode === 'google') {
    const attempt = await deps.runGoogleProof(info.nonce);
    if (!attempt.ok) {
      deps.updateState({ phase: 'ready', errorMsg: attempt.errorMessage }, 'render');
      return null;
    }
    options.oauthResult = attempt.proof;
  }
  return { ...options, trustOnly };
}

function shouldClearPasskeyHint(
  proofMode: PhoneProofMode,
  result: PhoneAttestationResponse
): boolean {
  const passkeyMode = proofMode === 'passkey-create' ? 'passkey-create' : 'passkey-auth';
  return (
    proofMode !== 'integrity' &&
    passkeyMode === 'passkey-auth' &&
    result.annotations?.phone_webauthn_error === 'credential_not_registered'
  );
}

function applyProofResult(
  result: PhoneAttestationResponse,
  request: Required<Pick<PhoneProofRequest, 'proofMode' | 'keepDrawingBoard' | 'trustOnly'>>,
  pairOperations: PhoneProofPairOperations,
  deps: PhoneProofFlowDependencies
): void {
  deps.recordPerf('attest_done', {
    verdict: result.verdict,
    trustOnly: request.trustOnly,
  });
  deps.flushPerf('attest_done');
  if (shouldClearPasskeyHint(request.proofMode, result)) pairOperations.clearPasskeyHint();
  const completion = {
    verdict: result.verdict,
    status: 'done',
    finalizeAfterDone: result.finalizeAfterDone,
  };
  if (request.keepDrawingBoard) {
    // Keep the server decision behind the neutral DONE state. The desktop
    // receives and enforces the verdict; the drawing board never discloses it.
    deps.updateState({ ...completion, phase: 'challenge' }, 'drawing');
    return;
  }
  deps.updateState({ ...completion, phase: 'paired' }, 'render');
  deps.scheduleFinalize(1500);
}

function applyProofFailure(
  error: unknown,
  request: Required<Pick<PhoneProofRequest, 'proofMode' | 'keepDrawingBoard' | 'trustOnly'>>,
  deps: PhoneProofFlowDependencies
): void {
  const message = error instanceof Error ? error.message : String(error);
  const failure = decidePhonePairFailure(error, request);
  deps.recordPerf('pair_error', {
    trustOnly: request.trustOnly,
    error: message.slice(0, 80),
  });
  deps.updateState(
    {
      phase: failure.phase,
      ...(failure.clearStatus ? { status: '' } : {}),
      ...(failure.resetTrust ? { hasTrust: false } : {}),
      errorMsg: failure.errorMessage,
    },
    'render'
  );
}

export async function runPhoneProofFlow(
  request: PhoneProofRequest,
  deps: PhoneProofFlowDependencies
): Promise<void> {
  const state = deps.getState();
  const pairOperations = deps.getPairOperations();
  if (!request.sessionId || !state.info || !pairOperations || state.inflight) return;
  const normalized = {
    proofMode: request.proofMode ?? 'passkey',
    keepDrawingBoard: request.keepDrawingBoard === true,
    trustOnly: request.trustOnly === true,
  };
  beginProof(normalized, state, deps);
  try {
    const options = await attestationOptions(
      normalized.proofMode,
      state.info,
      request.trustOnly,
      deps
    );
    if (!options) return;
    const result = await pairOperations.submitPhoneAttestation(
      request.sessionId,
      state.info,
      proofEvents(normalized.keepDrawingBoard, deps),
      options
    );
    applyProofResult(result, normalized, pairOperations, deps);
  } catch (error) {
    applyProofFailure(error, normalized, deps);
  } finally {
    deps.updateState({ inflight: false }, 'silent');
  }
}
