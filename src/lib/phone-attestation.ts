import {
  buildProofAttestationBody,
  buildTrustRedeemAttestationBody,
  createdCredentialIdFromProof,
  type PhoneOauthProof,
} from './phone-attestation-body';
import type { PhoneSessionInfo, PhoneScanResult } from './phone-session-runtime';
import { HttpError } from './json-http';
import { webauthnError } from './passkey-client';
import type { FixedVerdictPayload, SealedVerdictEnvelope } from './verdict-envelope';

export interface PhoneAttestationResponse {
  verdict: string;
  reason: string | null;
  annotations?: Record<string, unknown>;
  nextDeviceTrust?: string | null;
  phoneState?: SealedVerdictEnvelope;
  revealKey?: string;
  finalizeAfterDone?: () => Promise<'paired' | 'failed' | null>;
}

export interface SubmitPhoneAttestationOptions {
  mode?: 'integrity' | 'passkey-create' | 'passkey-auth' | 'oauth';
  oauthResult?: PhoneOauthProof;
  /** Never open interactive proof when the background fast-pass has no valid trust token. */
  trustOnly?: boolean;
}

export interface PhoneAttestationEvents {
  onStatus?: (status: string) => void;
  onError?: (error: unknown) => void;
}

export interface PhoneAttestationDependencies {
  loadTrustToken(): Promise<string | null>;
  saveTrustToken(token: string): Promise<void>;
  clearTrustToken(): Promise<void>;
  authenticatePasskey(nonce: string): Promise<unknown | { error: string }>;
  createPasskey(nonce: string): Promise<unknown | { error: string }>;
  rememberPasskeyCredential(credentialId: string): void;
  postAttestation(
    sessionId: string,
    body: Record<string, unknown>
  ): Promise<PhoneAttestationResponse>;
  openPhoneState(
    revealKey: string,
    sessionId: string,
    envelope: SealedVerdictEnvelope
  ): Promise<FixedVerdictPayload>;
}

interface PhoneAttestationRequest {
  sessionId: string;
  info: PhoneSessionInfo;
  events?: PhoneAttestationEvents;
  options?: SubmitPhoneAttestationOptions;
}

interface FreshEvidence {
  run: PhoneScanResult & { attestation: NonNullable<PhoneScanResult['attestation']> };
  webauthn: unknown;
  passkeyMode: 'passkey-create' | 'passkey-auth';
  webauthnSettled: PromiseSettledResult<unknown>;
  oauth?: PhoneOauthProof;
}

function neutralCompletion(): PhoneAttestationResponse {
  return { verdict: 'complete', reason: null, annotations: {} };
}

function isAlreadyAttested(error: unknown): boolean {
  return (
    error instanceof HttpError &&
    error.status === 409 &&
    error.bodyJson?.error === 'already_attested'
  );
}

function proofPromise(
  info: PhoneSessionInfo,
  options: SubmitPhoneAttestationOptions,
  deps: PhoneAttestationDependencies
): Promise<unknown | { error: string }> {
  if (options.mode === 'integrity') return Promise.resolve({ error: 'mode_integrity_only' });
  if (options.mode === 'oauth') return Promise.resolve({ error: 'mode_oauth_skipped' });
  return options.mode === 'passkey-auth'
    ? deps.authenticatePasskey(info.nonce)
    : deps.createPasskey(info.nonce);
}

async function collectFreshEvidence(
  info: PhoneSessionInfo,
  options: SubmitPhoneAttestationOptions,
  deps: PhoneAttestationDependencies
): Promise<FreshEvidence> {
  const passkeyMode = options.mode === 'passkey-auth' ? 'passkey-auth' : 'passkey-create';
  const [webauthnSettled, runSettled] = await Promise.allSettled([
    proofPromise(info, options, deps),
    info.getScanPromise(),
  ]);
  if (runSettled.status !== 'fulfilled') throw runSettled.reason;
  const run = runSettled.value;
  if (!run.attestation) {
    throw new Error(`argus attestation failed: ${run.attestError ?? 'no attestation'}`);
  }
  const webauthn =
    webauthnSettled.status === 'fulfilled'
      ? webauthnSettled.value
      : { error: errorMessage(webauthnSettled.reason) };
  const isNonPasskey = options.mode === 'oauth' || options.mode === 'integrity';
  const proofError = isNonPasskey ? null : webauthnError(webauthn);
  if (proofError) throw new Error(proofError);
  return {
    run: { ...run, attestation: run.attestation },
    webauthn,
    passkeyMode,
    webauthnSettled,
    oauth: options.mode === 'oauth' ? options.oauthResult : undefined,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function finalizePhoneState(
  response: PhoneAttestationResponse,
  info: PhoneSessionInfo,
  createdCredentialId: string | null,
  deps: PhoneAttestationDependencies
): Promise<'paired' | 'failed' | null> {
  const revealKey = response.revealKey ?? (await info.getVerdictRevealKey());
  const phoneState = await deps.openPhoneState(
    revealKey,
    info.conn.sessionId,
    response.phoneState!
  );
  if (phoneState.kind !== 'phone-state') throw new Error('unexpected phone state payload kind');
  if (phoneState.nextDeviceTrust) await deps.saveTrustToken(phoneState.nextDeviceTrust);
  if (phoneState.verdict === 'paired' && createdCredentialId) {
    deps.rememberPasskeyCredential(createdCredentialId);
  }
  return phoneState.verdict;
}

function attachPhoneStateFinalizer(
  response: PhoneAttestationResponse,
  info: PhoneSessionInfo,
  createdCredentialId: string | null,
  deps: PhoneAttestationDependencies
): PhoneAttestationResponse {
  if (response.verdict !== 'complete' || !response.phoneState) return response;
  let finalization: Promise<'paired' | 'failed' | null> | null = null;
  return {
    ...response,
    finalizeAfterDone: () => {
      finalization ??= finalizePhoneState(response, info, createdCredentialId, deps);
      return finalization;
    },
  };
}

async function tryTrustedAttestation(
  request: PhoneAttestationRequest,
  deps: PhoneAttestationDependencies
): Promise<PhoneAttestationResponse | null> {
  const options = request.options ?? {};
  const trustToken = request.info.freshProofRequired ? null : await deps.loadTrustToken();
  if (!trustToken) {
    if (options.trustOnly) throw new Error('device_trust_unavailable');
    return null;
  }
  request.events?.onStatus?.('welcome back — verifying');
  try {
    const run = await request.info.getScanPromise();
    if (!run.attestation) {
      throw new Error(`argus attestation failed: ${run.attestError ?? 'no attestation'}`);
    }
    const response = await deps.postAttestation(
      request.sessionId,
      buildTrustRedeemAttestationBody(
        { argusSessionId: run.argusSessionId, attestation: run.attestation },
        request.info,
        trustToken
      )
    );
    if (response.nextDeviceTrust) await deps.saveTrustToken(response.nextDeviceTrust);
    return attachPhoneStateFinalizer(response, request.info, null, deps);
  } catch (error) {
    if (isAlreadyAttested(error)) return neutralCompletion();
    await deps.clearTrustToken();
    request.events?.onError?.(error);
    request.events?.onStatus?.(
      error instanceof HttpError && error.status === 401
        ? 'trust expired — re-verifying'
        : 'falling back to webauthn'
    );
    if (options.trustOnly) throw error;
    return null;
  }
}

async function submitFreshAttestation(
  request: PhoneAttestationRequest,
  deps: PhoneAttestationDependencies
): Promise<PhoneAttestationResponse> {
  const options = request.options ?? {};
  request.events?.onStatus?.('proof of life + integrity scan');
  const evidence = await collectFreshEvidence(request.info, options, deps);
  request.events?.onStatus?.('submitting');
  const createdCredentialId = createdCredentialIdFromProof(
    evidence.passkeyMode,
    evidence.webauthnSettled
  );
  try {
    const response = await deps.postAttestation(
      request.sessionId,
      buildProofAttestationBody({
        run: {
          argusSessionId: evidence.run.argusSessionId,
          attestation: evidence.run.attestation,
        },
        bindings: request.info,
        webauthn: evidence.webauthn,
        oauth: evidence.oauth,
      })
    );
    if (response.nextDeviceTrust) await deps.saveTrustToken(response.nextDeviceTrust);
    if (response.verdict === 'paired' && createdCredentialId) {
      deps.rememberPasskeyCredential(createdCredentialId);
    }
    return attachPhoneStateFinalizer(response, request.info, createdCredentialId, deps);
  } catch (error) {
    if (isAlreadyAttested(error)) return neutralCompletion();
    throw error;
  }
}

export async function runPhoneAttestation(
  request: PhoneAttestationRequest,
  deps: PhoneAttestationDependencies
): Promise<PhoneAttestationResponse> {
  const trusted = await tryTrustedAttestation(request, deps);
  return trusted ?? submitFreshAttestation(request, deps);
}
