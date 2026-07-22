const PASSKEY_HINT_KEY = 'argus-pair:passkey-registered';
const PASSKEY_CREDENTIAL_ID_KEY = 'argus-pair:passkey-credential-id';
const PASSKEY_TIMEOUT_MS = 60_000;

export interface PasskeyStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface PasskeyAuthenticationOptions {
  challenge: string;
  rpId: string;
  userVerification: 'required';
  timeout: number;
  allowCredentials?: Array<{ id: string; type: 'public-key' }>;
}

interface PasskeyRegistrationOptions {
  challenge: string;
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: Array<{ type: 'public-key'; alg: number }>;
  authenticatorSelection: {
    authenticatorAttachment: 'platform';
    residentKey: 'preferred';
    requireResidentKey: false;
    userVerification: 'required';
  };
  attestation: 'none';
  timeout: number;
}

export interface PasskeyClientDependencies {
  getHostname(): string;
  getStorage(): PasskeyStorage;
  startAuthentication(options: PasskeyAuthenticationOptions): Promise<unknown>;
  startRegistration(options: PasskeyRegistrationOptions): Promise<unknown>;
}

export interface PasskeyClient {
  hasHint(): boolean;
  clearHint(): void;
  rememberCredential(credentialId: string): void;
  authenticate(nonceB64Url: string): Promise<unknown | { error: string }>;
  create(nonceB64Url: string): Promise<unknown | { error: string }>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readStorage(deps: PasskeyClientDependencies, key: string): string | null {
  try {
    return deps.getStorage().getItem(key);
  } catch {
    return null;
  }
}

function clearStorage(deps: PasskeyClientDependencies): void {
  try {
    const storage = deps.getStorage();
    storage.removeItem(PASSKEY_HINT_KEY);
    storage.removeItem(PASSKEY_CREDENTIAL_ID_KEY);
  } catch {
    /* Private mode and disabled storage are intentionally non-fatal. */
  }
}

function rememberCredential(deps: PasskeyClientDependencies, credentialId: string): void {
  try {
    const storage = deps.getStorage();
    storage.setItem(PASSKEY_HINT_KEY, '1');
    storage.setItem(PASSKEY_CREDENTIAL_ID_KEY, credentialId);
  } catch {
    /* A confirmed credential remains usable without the optional UI hint. */
  }
}

function authenticationOptions(
  deps: PasskeyClientDependencies,
  nonceB64Url: string
): PasskeyAuthenticationOptions {
  const credentialId = readStorage(deps, PASSKEY_CREDENTIAL_ID_KEY);
  return {
    challenge: nonceB64Url,
    rpId: deps.getHostname(),
    userVerification: 'required',
    timeout: PASSKEY_TIMEOUT_MS,
    allowCredentials: credentialId ? [{ id: credentialId, type: 'public-key' }] : undefined,
  };
}

function hostUserId(hostname: string): string {
  return btoa(hostname).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function registrationOptions(
  deps: PasskeyClientDependencies,
  nonceB64Url: string
): PasskeyRegistrationOptions {
  const rpId = deps.getHostname();
  return {
    challenge: nonceB64Url,
    rp: { id: rpId, name: 'Argus Pair' },
    user: { id: hostUserId(rpId), name: 'pair', displayName: 'Argus Pair' },
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
    timeout: PASSKEY_TIMEOUT_MS,
  };
}

export function createPasskeyClient(deps: PasskeyClientDependencies): PasskeyClient {
  return {
    hasHint: () => readStorage(deps, PASSKEY_HINT_KEY) === '1',
    clearHint: () => clearStorage(deps),
    rememberCredential: (credentialId) => rememberCredential(deps, credentialId),
    async authenticate(nonceB64Url) {
      try {
        return await deps.startAuthentication(authenticationOptions(deps, nonceB64Url));
      } catch (error) {
        clearStorage(deps);
        return { error: errorMessage(error) };
      }
    },
    async create(nonceB64Url) {
      try {
        return await deps.startRegistration(registrationOptions(deps, nonceB64Url));
      } catch (error) {
        return { error: errorMessage(error) };
      }
    },
  };
}

const browserPasskeys = createPasskeyClient({
  getHostname: () => window.location.hostname,
  getStorage: () => window.localStorage,
  startAuthentication: async (options) => {
    const { startAuthentication } = await import('@simplewebauthn/browser');
    return startAuthentication({ optionsJSON: options });
  },
  startRegistration: async (options) => {
    const { startRegistration } = await import('@simplewebauthn/browser');
    return startRegistration({ optionsJSON: options });
  },
});

export function hasPasskeyHint(): boolean {
  return browserPasskeys.hasHint();
}

export function clearPasskeyHint(): void {
  browserPasskeys.clearHint();
}

export function rememberPasskeyCredential(credentialId: string): void {
  browserPasskeys.rememberCredential(credentialId);
}

export function authenticateExistingPasskey(
  nonceB64Url: string
): Promise<unknown | { error: string }> {
  return browserPasskeys.authenticate(nonceB64Url);
}

export function createNewPasskey(nonceB64Url: string): Promise<unknown | { error: string }> {
  return browserPasskeys.create(nonceB64Url);
}

export function webauthnError(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const error = (value as { error?: unknown }).error;
  return typeof error === 'string' && error.length > 0 ? error : null;
}
