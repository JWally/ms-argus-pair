import { describe, expect, it, vi } from 'vitest';
import { createPasskeyClient, webauthnError, type PasskeyStorage } from '../src/lib/passkey-client';

function memoryStorage(initial: Record<string, string> = {}): PasskeyStorage {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
}

function client(
  overrides: {
    storage?: PasskeyStorage;
    getStorage?: () => PasskeyStorage;
    startAuthentication?: (options: unknown) => Promise<unknown>;
    startRegistration?: (options: unknown) => Promise<unknown>;
  } = {}
) {
  const storage = overrides.storage ?? memoryStorage();
  const startAuthentication = overrides.startAuthentication ?? vi.fn(async () => ({ id: 'auth' }));
  const startRegistration = overrides.startRegistration ?? vi.fn(async () => ({ id: 'created' }));
  return {
    passkeys: createPasskeyClient({
      getHostname: () => 'captcha.example.test',
      getStorage: overrides.getStorage ?? (() => storage),
      startAuthentication,
      startRegistration,
    }),
    storage,
    startAuthentication,
    startRegistration,
  };
}

describe('passkey hints', () => {
  it('records, reads, and clears the server-confirmed credential hint', () => {
    const { passkeys, storage } = client();

    expect(passkeys.hasHint()).toBe(false);
    passkeys.rememberCredential('credential-1');
    expect(passkeys.hasHint()).toBe(true);
    expect(storage.getItem('argus-pair:passkey-credential-id')).toBe('credential-1');
    passkeys.clearHint();

    expect(passkeys.hasHint()).toBe(false);
    expect(storage.getItem('argus-pair:passkey-credential-id')).toBeNull();
  });

  it('fails soft when browser storage is unavailable', () => {
    const { passkeys } = client({
      getStorage: () => {
        throw new Error('storage disabled');
      },
    });

    expect(passkeys.hasHint()).toBe(false);
    expect(() => passkeys.rememberCredential('credential-1')).not.toThrow();
    expect(() => passkeys.clearHint()).not.toThrow();
  });
});

describe('passkey authentication', () => {
  it('binds the request to the current host and stored credential', async () => {
    const storage = memoryStorage({
      'argus-pair:passkey-registered': '1',
      'argus-pair:passkey-credential-id': 'credential-1',
    });
    const { passkeys, startAuthentication } = client({ storage });

    await expect(passkeys.authenticate('nonce-1')).resolves.toEqual({ id: 'auth' });
    expect(startAuthentication).toHaveBeenCalledWith({
      challenge: 'nonce-1',
      rpId: 'captcha.example.test',
      userVerification: 'required',
      timeout: 60_000,
      allowCredentials: [{ id: 'credential-1', type: 'public-key' }],
    });
  });

  it('clears a stale hint when the browser rejects authentication', async () => {
    const storage = memoryStorage({
      'argus-pair:passkey-registered': '1',
      'argus-pair:passkey-credential-id': 'stale-credential',
    });
    const { passkeys } = client({
      storage,
      startAuthentication: vi.fn(async () => {
        throw new Error('credential unavailable');
      }),
    });

    await expect(passkeys.authenticate('nonce-1')).resolves.toEqual({
      error: 'credential unavailable',
    });
    expect(passkeys.hasHint()).toBe(false);
    expect(storage.getItem('argus-pair:passkey-credential-id')).toBeNull();
  });
});

describe('passkey registration', () => {
  it('builds a resident platform credential without persisting an optimistic hint', async () => {
    const { passkeys, storage, startRegistration } = client();

    await expect(passkeys.create('nonce-1')).resolves.toEqual({ id: 'created' });
    expect(startRegistration).toHaveBeenCalledWith(
      expect.objectContaining({
        challenge: 'nonce-1',
        rp: { id: 'captcha.example.test', name: 'Argus Pair' },
        user: expect.objectContaining({ name: 'pair', displayName: 'Argus Pair' }),
        authenticatorSelection: expect.objectContaining({
          authenticatorAttachment: 'platform',
          residentKey: 'preferred',
          userVerification: 'required',
        }),
        attestation: 'none',
      })
    );
    const registration = vi.mocked(startRegistration).mock.calls[0]?.[0] as {
      user: { id: string };
    };
    expect(registration.user.id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(storage.getItem('argus-pair:passkey-registered')).toBeNull();
  });

  it('returns a stable error object when registration fails', async () => {
    const { passkeys } = client({
      startRegistration: vi.fn(async () => {
        throw new Error('registration cancelled');
      }),
    });

    await expect(passkeys.create('nonce-1')).resolves.toEqual({
      error: 'registration cancelled',
    });
  });
});

describe('webauthn errors', () => {
  it('recognizes only non-empty error fields', () => {
    expect(webauthnError({ error: 'cancelled' })).toBe('cancelled');
    expect(webauthnError({ error: '' })).toBeNull();
    expect(webauthnError(null)).toBeNull();
  });
});
