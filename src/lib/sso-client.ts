import {
  ARGUS_CPI,
  baseIntegrityCpi,
  runArgusAttestation,
  type ArgusAttestedScan,
} from './argus-client';
import { saveTrustToken } from './device-trust';
import { HttpError, jsonFetch } from './json-http';
import {
  authenticateExistingPasskey,
  createNewPasskey,
  rememberPasskeyCredential,
} from './passkey-client';
import { withSsoClientStage } from './sso-observability';

export interface SsoStartResult {
  sessionId: string;
  nonce: string;
  expiresAt: number;
  cpi: string;
  proofRequired: boolean;
  freshProofRequired: boolean;
  challengeUrl: string;
  failureReturnUrl: string;
}

export interface SsoChallengeResult {
  ok: true;
  returnCode: string;
  returnUrl: string;
}

export interface SsoValidateResult {
  verdict: 'approved' | 'failed';
  reason: string;
  reasons: string[];
  merchantSessionId: string;
  cpi: string;
  approvalCode?: string;
  merchantCallbackUrl?: string;
  merchantChallengeId?: string;
  nextDeviceTrust?: string | null;
}

export type SsoProofMode =
  | 'integrity-only'
  | 'passkey-create'
  | 'passkey-auth'
  | 'oauth'
  | 'device-trust';

export interface SsoValidationInput {
  sessionId: string;
  nonce: string;
  returnCode: string;
  cpi: string;
  mode?: SsoProofMode;
  oauthResult?: { provider: 'google'; token: string };
  deviceTrustToken?: string;
}

export interface SsoClientDependencies {
  defaultCpi: string;
  runAttestedScan(input: {
    cpi: string;
    payload: Record<string, unknown>;
  }): Promise<ArgusAttestedScan>;
  request<T>(input: string, init?: RequestInit): Promise<T>;
  runStage<T>(
    stage: string,
    event: string,
    sessionId: string | null,
    operation: () => Promise<T>
  ): Promise<T>;
  authenticatePasskey(nonce: string): Promise<unknown | { error: string }>;
  createPasskey(nonce: string): Promise<unknown | { error: string }>;
  rememberPasskeyCredential(credentialId: string): void;
  saveTrustToken(token: string): Promise<void>;
}

export interface SsoClient {
  defaultCpi(): string;
  startSession(
    merchantSessionId: string,
    cpi: string,
    merchantBinding?: { challengeId: string; callbackUrl: string }
  ): Promise<SsoStartResult>;
  submitChallenge(sessionId: string, nonce: string, cpi: string): Promise<SsoChallengeResult>;
  validateReturn(input: SsoValidationInput): Promise<SsoValidateResult>;
  redeemApproval(
    sessionId: string,
    expectedCpi: string
  ): Promise<{ verdict: 'approved'; reason: 'approved'; cpi: string; scope: string }>;
}

function runSsoLeg(
  deps: SsoClientDependencies,
  cpi: string,
  payload: Record<string, unknown>
): Promise<ArgusAttestedScan> {
  const stage = typeof payload.role === 'string' ? payload.role : 'unknown';
  const sessionId = typeof payload.ssoSessionId === 'string' ? payload.ssoSessionId : null;
  return deps.runStage(stage, 'argus_leg', sessionId, () =>
    deps.runAttestedScan({
      cpi: baseIntegrityCpi(cpi),
      payload: { ...payload, cpi },
    })
  );
}

function passkeyProof(
  deps: SsoClientDependencies,
  input: SsoValidationInput
): Promise<unknown | { error: string }> {
  if (input.mode === 'passkey-auth') return deps.authenticatePasskey(input.nonce);
  if (!input.mode || input.mode === 'passkey-create') return deps.createPasskey(input.nonce);
  return Promise.resolve({ error: `mode_${input.mode}_skipped` });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function settledProof(settled: PromiseSettledResult<unknown>): unknown {
  return settled.status === 'fulfilled' ? settled.value : { error: errorMessage(settled.reason) };
}

function createdCredentialId(
  input: SsoValidationInput,
  settled: PromiseSettledResult<unknown>
): string | null {
  if ((input.mode && input.mode !== 'passkey-create') || settled.status !== 'fulfilled')
    return null;
  if (!settled.value || typeof settled.value !== 'object') return null;
  const credentialId = (settled.value as { id?: unknown }).id;
  return typeof credentialId === 'string' ? credentialId : null;
}

function selectedProof(input: SsoValidationInput, webauthn: unknown): Record<string, unknown> {
  if (input.mode === 'device-trust') {
    return input.deviceTrustToken ? { deviceTrustToken: input.deviceTrustToken } : {};
  }
  if (input.mode === 'oauth') return input.oauthResult ? { oauth: input.oauthResult } : {};
  if (input.mode === 'integrity-only') return {};
  return { webauthn };
}

function failedValidation(error: unknown): SsoValidateResult {
  if (error instanceof HttpError && error.status === 403 && error.bodyJson?.verdict === 'failed') {
    return error.bodyJson as unknown as SsoValidateResult;
  }
  throw error;
}

async function startSession(
  deps: SsoClientDependencies,
  merchantSessionId: string,
  cpi: string,
  merchantBinding?: { challengeId: string; callbackUrl: string }
): Promise<SsoStartResult> {
  const leg = await runSsoLeg(deps, cpi, { role: 'merchant-start', merchantSessionId });
  return deps.runStage('merchant-start', 'http_request', null, () =>
    deps.request<SsoStartResult>('/api/sso/start', {
      method: 'POST',
      body: JSON.stringify({
        merchantSessionId,
        cpi,
        ...(merchantBinding
          ? {
              merchantChallengeId: merchantBinding.challengeId,
              merchantCallbackUrl: merchantBinding.callbackUrl,
            }
          : {}),
        ...leg,
      }),
    })
  );
}

async function submitChallenge(
  deps: SsoClientDependencies,
  sessionId: string,
  nonce: string,
  cpi: string
): Promise<SsoChallengeResult> {
  const leg = await runSsoLeg(deps, cpi, {
    role: 'argus-challenge',
    ssoSessionId: sessionId,
    nonce,
  });
  return deps.runStage('argus-challenge', 'http_request', sessionId, () =>
    deps.request<SsoChallengeResult>(`/api/sso/${encodeURIComponent(sessionId)}/challenge`, {
      method: 'POST',
      body: JSON.stringify(leg),
    })
  );
}

async function validateReturn(
  deps: SsoClientDependencies,
  input: SsoValidationInput
): Promise<SsoValidateResult> {
  const proofPromise = passkeyProof(deps, input);
  const legPromise = runSsoLeg(deps, input.cpi, {
    role: 'merchant-validate',
    ssoSessionId: input.sessionId,
    nonce: input.nonce,
    returnCode: input.returnCode,
  });
  const [proofSettled, legSettled] = await Promise.allSettled([proofPromise, legPromise]);
  if (legSettled.status === 'rejected') throw legSettled.reason;
  const credentialId = createdCredentialId(input, proofSettled);
  const request = deps.runStage('merchant-validate', 'http_request', input.sessionId, () =>
    deps.request<SsoValidateResult>(`/api/sso/${encodeURIComponent(input.sessionId)}/validate`, {
      method: 'POST',
      body: JSON.stringify({
        returnCode: input.returnCode,
        ...legSettled.value,
        ...selectedProof(input, settledProof(proofSettled)),
      }),
    })
  );
  const result = await request.catch(failedValidation);
  if (result.nextDeviceTrust) await deps.saveTrustToken(result.nextDeviceTrust);
  if (result.verdict === 'approved' && credentialId) {
    deps.rememberPasskeyCredential(credentialId);
  }
  return result;
}

function redeemApproval(
  deps: SsoClientDependencies,
  sessionId: string,
  expectedCpi: string
): Promise<{ verdict: 'approved'; reason: 'approved'; cpi: string; scope: string }> {
  return deps.request('/api/sso/approval/redeem', {
    method: 'POST',
    credentials: 'same-origin',
    body: JSON.stringify({ sessionId, cpi: expectedCpi }),
  });
}

export function createSsoClient(deps: SsoClientDependencies): SsoClient {
  return {
    defaultCpi: () => `${baseIntegrityCpi(deps.defaultCpi)}.stepup`,
    startSession: (merchantSessionId, cpi, binding) =>
      startSession(deps, merchantSessionId, cpi, binding),
    submitChallenge: (sessionId, nonce, cpi) => submitChallenge(deps, sessionId, nonce, cpi),
    validateReturn: (input) => validateReturn(deps, input),
    redeemApproval: (sessionId, expectedCpi) => redeemApproval(deps, sessionId, expectedCpi),
  };
}

const browserSsoClient = createSsoClient({
  defaultCpi: ARGUS_CPI,
  runAttestedScan: runArgusAttestation,
  request: jsonFetch,
  runStage: withSsoClientStage,
  authenticatePasskey: authenticateExistingPasskey,
  createPasskey: createNewPasskey,
  rememberPasskeyCredential,
  saveTrustToken,
});

export const defaultSsoCpi = browserSsoClient.defaultCpi;
export const startSsoSession = browserSsoClient.startSession;
export const submitSsoChallenge = browserSsoClient.submitChallenge;
export const validateSsoReturn = browserSsoClient.validateReturn;
export const redeemSsoApproval = browserSsoClient.redeemApproval;
