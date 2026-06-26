import { isOAuthError, runOAuthProofOfLife, type OAuthOutcome } from './oauth';
import { clearTrustToken, loadTrustToken, saveTrustToken } from './device-trust';

const API = '/api';
const ATTEST_PURPOSE = 'argus-pair-v1';
const ATTEST_TTL_SECONDS = 120;
const ARGUS_CPI =
  (import.meta.env.VITE_MERCHANT_CPI as string | undefined) ??
  'argus_cpi_test_UEeqk7Bk7uetxKKDxNmIdB';

interface ArgusAttestation {
  envelope: string;
  signature: string;
  publicKey: string;
  keyId: string;
}

interface ArgusRunResult {
  argusSessionId: string;
  attestation?: ArgusAttestation | null;
  attestError?: string | null;
}

interface ArgusGlobal {
  run(opts: {
    cpi?: string;
    timeoutMs?: number;
    attest?: { purpose: string; payload?: unknown; ttlSeconds?: number };
  }): Promise<ArgusRunResult>;
}

class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly bodyJson: Record<string, unknown> | null,
    message: string
  ) {
    super(message);
  }
}

function getArgus(): ArgusGlobal {
  const argus = (window as unknown as { argus?: ArgusGlobal }).argus;
  if (!argus) throw new Error('argus SDK not loaded');
  return argus;
}

async function jsonFetch<T>(input: string, init?: RequestInit): Promise<T> {
  const url = `${input}${input.includes('?') ? '&' : '?'}_=${Date.now()}`;
  const res = await fetch(url, {
    ...init,
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  });
  const text = await res.text();
  const parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!res.ok) {
    throw new HttpError(res.status, parsed, `${init?.method || 'GET'} ${input} -> ${res.status}`);
  }
  return parsed as T;
}

function randomState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function passkeyUserId(): string {
  return btoa(window.location.hostname).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function createHostedPasskey(nonce: string): Promise<unknown | { error: string }> {
  const { startRegistration } = await import('@simplewebauthn/browser');
  try {
    return await startRegistration({
      optionsJSON: {
        challenge: nonce,
        rp: { id: window.location.hostname, name: 'Argus Verify' },
        user: { id: passkeyUserId(), name: 'verify', displayName: 'Argus Verify' },
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 },
        ],
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          residentKey: 'preferred',
          requireResidentKey: false,
          userVerification: 'required',
        },
        attestation: 'none',
        timeout: 60_000,
      },
    });
  } catch (e) {
    return { error: (e as Error).message };
  }
}

async function authenticateHostedPasskey(nonce: string): Promise<unknown | { error: string }> {
  const { startAuthentication } = await import('@simplewebauthn/browser');
  try {
    return await startAuthentication({
      optionsJSON: {
        challenge: nonce,
        rpId: window.location.hostname,
        userVerification: 'required',
        timeout: 60_000,
      },
    });
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export interface HostedStartResult {
  hostedSessionId: string;
  nonce: string;
  expiresAt: number;
  redirectUrl: string;
  state: string;
}

export interface HostedAttestResult {
  verdict: 'passed' | 'failed';
  reason: string;
  code: string;
  callbackUrl: string;
  annotations?: Record<string, unknown>;
  nextDeviceTrust?: string | null;
}

export async function startHostedVerify(): Promise<HostedStartResult> {
  const state = randomState();
  const merchantSessionId = `demo-${Date.now()}-${state.slice(0, 8)}`;
  const returnUrl = `${window.location.origin}/hosted/callback`;
  const result = await jsonFetch<Omit<HostedStartResult, 'state'>>(`${API}/hosted/start`, {
    method: 'POST',
    body: JSON.stringify({
      merchantId: 'demo',
      merchantSessionId,
      returnUrl,
      state,
    }),
  });
  window.sessionStorage.setItem(
    'argus-hosted-demo',
    JSON.stringify({ hostedSessionId: result.hostedSessionId, merchantSessionId, state })
  );
  return { ...result, state };
}

export async function submitHostedMerchantLeg(start: HostedStartResult): Promise<void> {
  const run = await getArgus().run({
    cpi: ARGUS_CPI,
    timeoutMs: 30_000,
    attest: {
      purpose: ATTEST_PURPOSE,
      ttlSeconds: ATTEST_TTL_SECONDS,
      payload: {
        sessionId: start.hostedSessionId,
        nonce: start.nonce,
        role: 'merchant',
      },
    },
  });
  if (!run.attestation) {
    throw new Error(`argus attestation failed: ${run.attestError ?? 'no attestation'}`);
  }
  await jsonFetch(`${API}/hosted/${start.hostedSessionId}/merchant-attest`, {
    method: 'POST',
    body: JSON.stringify({ argusSessionId: run.argusSessionId, attestation: run.attestation }),
  });
}

export async function runHostedChallenge(
  hostedSessionId: string,
  nonce: string,
  proofMode: 'passkey-auth' | 'passkey-create' | 'google' | 'trust'
): Promise<HostedAttestResult> {
  const proof: { webauthn?: unknown; oauth?: OAuthOutcome; deviceTrustToken?: string } = {};
  if (proofMode === 'google') {
    const oauth = await runOAuthProofOfLife('google', nonce);
    if (isOAuthError(oauth)) throw new Error(oauth.error);
    proof.oauth = oauth;
  } else if (proofMode === 'trust') {
    const trustToken = await loadTrustToken();
    if (!trustToken) throw new Error('device_trust_missing');
    proof.deviceTrustToken = trustToken;
  } else {
    proof.webauthn =
      proofMode === 'passkey-auth'
        ? await authenticateHostedPasskey(nonce)
        : await createHostedPasskey(nonce);
  }

  const run = await getArgus().run({
    cpi: ARGUS_CPI,
    timeoutMs: 30_000,
    attest: {
      purpose: ATTEST_PURPOSE,
      ttlSeconds: ATTEST_TTL_SECONDS,
      payload: {
        sessionId: hostedSessionId,
        nonce,
        role: 'hosted',
      },
    },
  });
  if (!run.attestation) {
    throw new Error(`argus attestation failed: ${run.attestError ?? 'no attestation'}`);
  }
  const result = await jsonFetch<HostedAttestResult>(
    `${API}/hosted/${hostedSessionId}/hosted-attest`,
    {
      method: 'POST',
      body: JSON.stringify({
        argusSessionId: run.argusSessionId,
        attestation: run.attestation,
        ...proof,
      }),
    }
  );
  if (result.nextDeviceTrust) await saveTrustToken(result.nextDeviceTrust);
  return result;
}

export async function tryHostedTrustChallenge(
  hostedSessionId: string,
  nonce: string
): Promise<HostedAttestResult | null> {
  const trustToken = await loadTrustToken();
  if (!trustToken) return null;
  try {
    return await runHostedChallenge(hostedSessionId, nonce, 'trust');
  } catch (e) {
    if (e instanceof HttpError && e.status === 401) {
      await clearTrustToken();
      return null;
    }
    throw e;
  }
}

export async function redeemHostedCode(code: string): Promise<{
  verdict: 'passed' | 'failed';
  reason: string | null;
  hostedSessionId: string;
  merchantSessionId: string;
  annotations?: Record<string, unknown>;
}> {
  return jsonFetch(`${API}/hosted/redeem`, {
    method: 'POST',
    body: JSON.stringify({ merchantId: 'demo', code }),
  });
}

export async function submitHostedRaffleEntry(
  code: string,
  handle: string
): Promise<{ ok: true; code: string; count: number }> {
  return jsonFetch(`${API}/hosted/entry`, {
    method: 'POST',
    body: JSON.stringify({ merchantId: 'demo', code, handle }),
  });
}
