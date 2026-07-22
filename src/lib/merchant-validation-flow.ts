import { clearTrustToken, loadTrustToken } from './device-trust';
import { HttpError } from './json-http';
import { runGoogleProofOfLife, type OAuthOutcome } from './oauth';
import { clearPasskeyHint, hasPasskeyHint } from './passkey-client';
import { validateSsoReturn, type SsoValidateResult, type SsoValidationInput } from './sso-client';

export interface MerchantValidationMaterial {
  sessionId: string;
  returnCode: string;
  cpi: string;
  nonce: string;
}

export type MerchantProofChoice = 'passkey-create' | 'passkey-auth' | 'google';

type InitialValidationOutcome =
  | { kind: 'validated'; result: SsoValidateResult; passkeySeen: boolean }
  | { kind: 'proof-required'; passkeySeen: boolean };

type ProofValidationOutcome =
  | { kind: 'validated'; result: SsoValidateResult; passkeySeen: boolean }
  | { kind: 'proof-error'; error: string; passkeySeen: boolean };

export interface MerchantValidationService {
  validateInitial(material: MerchantValidationMaterial): Promise<InitialValidationOutcome>;
  validateProof(
    material: MerchantValidationMaterial,
    proofChoice: MerchantProofChoice,
    passkeySeen: boolean
  ): Promise<ProofValidationOutcome>;
}

export interface MerchantValidationDependencies {
  validateReturn(input: SsoValidationInput): Promise<SsoValidateResult>;
  loadTrustToken(): Promise<string | null>;
  clearTrustToken(): Promise<void>;
  hasPasskeyHint(): boolean;
  clearPasskeyHint(): void;
  runGoogleProof(nonce: string): Promise<OAuthOutcome>;
}

interface SearchParamsReader {
  get(name: string): string | null;
}

export type MerchantValidationMaterialResult =
  | { ok: true; material: MerchantValidationMaterial }
  | { ok: false; error: string };

export function readMerchantValidationMaterial(
  params: SearchParamsReader,
  readNonce: (sessionId: string) => string | null
): MerchantValidationMaterialResult {
  const sessionId = params.get('session');
  const returnCode = params.get('code');
  const cpi = params.get('cpi');
  if (!sessionId || !returnCode || !cpi) {
    return { ok: false, error: 'Missing return material' };
  }
  const nonce = readNonce(sessionId);
  if (!nonce) return { ok: false, error: 'Missing session state' };
  return { ok: true, material: { sessionId, returnCode, cpi, nonce } };
}

interface MerchantValidationRedirectInput {
  sessionId: string | null;
  cpi: string | null;
  isMerchantCallback: boolean;
  result: SsoValidateResult | null;
  error: string | null;
  failureReturnUrl: string | null;
}

export type MerchantValidationRedirect =
  | { kind: 'replace'; url: string }
  | { kind: 'navigate'; url: string }
  | null;

function boundMerchantCallback(
  input: MerchantValidationRedirectInput,
  sessionId: string,
  cpi: string,
  approved: boolean,
  failed: boolean
): MerchantValidationRedirect {
  const { result } = input;
  if (!result?.merchantCallbackUrl || !result.merchantChallengeId) return null;
  const callback = new URL(result.merchantCallbackUrl);
  callback.searchParams.set('session', sessionId);
  callback.searchParams.set('cpi', cpi);
  callback.searchParams.set('challengeId', result.merchantChallengeId);
  if (approved && result.approvalCode) callback.searchParams.set('code', result.approvalCode);
  else if (failed) callback.searchParams.set('status', 'failed');
  else return null;
  return { kind: 'replace', url: callback.toString() };
}

export function merchantValidationRedirect(
  input: MerchantValidationRedirectInput
): MerchantValidationRedirect {
  if (!input.sessionId || !input.cpi) return null;
  const approved = input.result?.verdict === 'approved';
  const failed = Boolean(input.error) || input.result?.verdict === 'failed';
  if (input.isMerchantCallback) {
    if (input.result?.merchantCallbackUrl && input.result.merchantChallengeId) {
      return boundMerchantCallback(input, input.sessionId, input.cpi, approved, failed);
    }
    return approved || failed
      ? input.failureReturnUrl
        ? { kind: 'replace', url: input.failureReturnUrl }
        : null
      : null;
  }
  if (!approved) return null;
  const merchantParams = new URLSearchParams({
    complete: '1',
    session: input.sessionId,
    cpi: input.cpi,
  });
  return { kind: 'navigate', url: `/merchant?${merchantParams.toString()}` };
}

function isUnauthorized(cause: unknown): boolean {
  return cause instanceof HttpError && cause.status === 401;
}

async function validateInitial(
  deps: MerchantValidationDependencies,
  material: MerchantValidationMaterial
): Promise<InitialValidationOutcome> {
  let passkeySeen = deps.hasPasskeyHint();
  try {
    if (material.cpi.endsWith('.fastpass')) {
      const result = await deps.validateReturn({ ...material, mode: 'integrity-only' });
      return { kind: 'validated', result, passkeySeen };
    }
    if (material.cpi.endsWith('.forceauth')) return { kind: 'proof-required', passkeySeen };
    const trustToken = await deps.loadTrustToken();
    if (!trustToken) return { kind: 'proof-required', passkeySeen };
    const result = await deps.validateReturn({
      ...material,
      mode: 'device-trust',
      deviceTrustToken: trustToken,
    });
    return { kind: 'validated', result, passkeySeen };
  } catch (cause) {
    if (!isUnauthorized(cause)) throw cause;
    await deps.clearTrustToken();
    passkeySeen = deps.hasPasskeyHint();
    return { kind: 'proof-required', passkeySeen };
  }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

async function validateProof(
  deps: MerchantValidationDependencies,
  material: MerchantValidationMaterial,
  proofChoice: MerchantProofChoice,
  passkeySeen: boolean
): Promise<ProofValidationOutcome> {
  try {
    let result: SsoValidateResult;
    if (proofChoice === 'google') {
      const oauthResult = await deps.runGoogleProof(material.nonce);
      if ('error' in oauthResult) {
        return { kind: 'proof-error', error: oauthResult.error, passkeySeen };
      }
      result = await deps.validateReturn({ ...material, mode: 'oauth', oauthResult });
    } else {
      result = await deps.validateReturn({ ...material, mode: proofChoice });
    }
    if (
      proofChoice === 'passkey-auth' &&
      result.verdict === 'failed' &&
      result.reason === 'credential_not_registered'
    ) {
      deps.clearPasskeyHint();
      passkeySeen = false;
    }
    return { kind: 'validated', result, passkeySeen };
  } catch (cause) {
    const error = isUnauthorized(cause) ? 'Proof required' : errorMessage(cause);
    return { kind: 'proof-error', error, passkeySeen };
  }
}

export function createMerchantValidationService(
  deps: MerchantValidationDependencies
): MerchantValidationService {
  return {
    validateInitial: (material) => validateInitial(deps, material),
    validateProof: (material, proofChoice, passkeySeen) =>
      validateProof(deps, material, proofChoice, passkeySeen),
  };
}

export const browserMerchantValidationService = createMerchantValidationService({
  validateReturn: validateSsoReturn,
  loadTrustToken,
  clearTrustToken,
  hasPasskeyHint,
  clearPasskeyHint,
  runGoogleProof: runGoogleProofOfLife,
});
