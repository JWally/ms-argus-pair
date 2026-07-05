import { verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server';
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
  WebAuthnCredential,
} from '@simplewebauthn/server';
import { isVirtualAuthenticator } from './virtual-authenticator';
import type { PasskeyStore } from './passkey-store';

export interface WebAuthnAnnotations {
  phone_webauthn_attested: boolean;
  phone_webauthn_aaguid?: string;
  phone_webauthn_format?: string;
  /** Stable per-user identifier for the auth-identity rate-limit bucket.
   *  Passkey path -> credentialId; populated by both registration and
   *  authentication so the same user gets the same bucket whether they
   *  just created or just used their passkey. */
  phone_webauthn_credential_id?: string;
  phone_webauthn_credential_backed_up?: boolean;
  phone_webauthn_user_verified?: boolean;
  /** The authenticator is a known virtual/test one (CDP). Automation signal. */
  phone_webauthn_virtual?: boolean;
  phone_webauthn_error?: string;
}

export interface VerifyWebAuthnOptions {
  webauthn: unknown;
  expectedNonce: string;
  argusPubkey: string;
  rpId: string;
  expectedOrigin: string;
  allowTestAuthenticators: boolean;
  passkeyStore: PasskeyStore;
}

function publicKeyBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function base64ToBytes(s: string): Uint8Array<ArrayBuffer> {
  // Copy into a fresh Uint8Array backed by a real ArrayBuffer (Buffer's
  // underlying ArrayBufferLike isn't assignable to the simplewebauthn
  // WebAuthnCredential publicKey type, which insists on ArrayBuffer).
  const src = Buffer.from(s, 'base64');
  const out = new Uint8Array(new ArrayBuffer(src.length));
  out.set(src);
  return out;
}

/**
 * Verify a stored-passkey authentication assertion. Returns the same
 * annotations shape as verifyWebAuthnProof() so the verdict branch can stay
 * homogeneous. Bumps signCount + lastUsedAt on success.
 */
async function verifyPasskeyAuthentication(
  opts: VerifyWebAuthnOptions
): Promise<WebAuthnAnnotations> {
  const { webauthn, expectedNonce, argusPubkey, expectedOrigin, rpId, passkeyStore } = opts;
  if (!webauthn || typeof webauthn !== 'object') {
    return { phone_webauthn_attested: false, phone_webauthn_error: 'missing' };
  }
  const w = webauthn as Record<string, unknown>;
  if (typeof w.error === 'string') {
    return { phone_webauthn_attested: false, phone_webauthn_error: w.error };
  }
  const auth = webauthn as AuthenticationResponseJSON;
  if (!auth.id) {
    return { phone_webauthn_attested: false, phone_webauthn_error: 'missing_credential_id' };
  }
  const stored = await passkeyStore.load(auth.id);
  if (!stored) {
    return { phone_webauthn_attested: false, phone_webauthn_error: 'credential_not_registered' };
  }
  try {
    const credential: WebAuthnCredential = {
      id: stored.credentialId,
      publicKey: base64ToBytes(stored.publicKey),
      counter: stored.signCount,
    };
    const verification = await verifyAuthenticationResponse({
      response: auth,
      expectedChallenge: expectedNonce,
      expectedOrigin,
      expectedRPID: rpId,
      credential,
      requireUserVerification: true,
    });
    if (!verification.verified) {
      return { phone_webauthn_attested: false, phone_webauthn_error: 'not_verified' };
    }
    await passkeyStore.save({
      credentialId: stored.credentialId,
      publicKey: stored.publicKey,
      signCount: verification.authenticationInfo.newCounter,
      argusPubkey,
      createdAt: stored.createdAt,
      lastUsedAt: Math.floor(Date.now() / 1000),
    });
    return {
      phone_webauthn_attested: true,
      phone_webauthn_format: 'passkey_authentication',
      phone_webauthn_credential_id: stored.credentialId,
      phone_webauthn_user_verified: verification.authenticationInfo.userVerified,
      phone_webauthn_credential_backed_up: verification.authenticationInfo.credentialBackedUp,
    };
  } catch (e) {
    return {
      phone_webauthn_attested: false,
      phone_webauthn_error: (e as Error).message,
    };
  }
}

/**
 * Verify the phone's WebAuthn proof-of-life ceremony.
 *
 * This accepts privacy-preserving platform authenticator registrations
 * (`fmt:'none'` + all-zero AAGUID), but marks known virtual/test authenticators
 * so production can reject them as proof-of-life.
 */
export async function verifyWebAuthnProof(
  opts: VerifyWebAuthnOptions
): Promise<WebAuthnAnnotations> {
  const { webauthn, expectedNonce, argusPubkey, expectedOrigin, rpId, allowTestAuthenticators } =
    opts;
  if (!webauthn || typeof webauthn !== 'object') {
    return { phone_webauthn_attested: false, phone_webauthn_error: 'missing' };
  }
  const w = webauthn as Record<string, unknown>;
  if (typeof w.error === 'string') {
    return { phone_webauthn_attested: false, phone_webauthn_error: w.error };
  }
  const response = w.response as Record<string, unknown> | undefined;
  const isAuthentication =
    typeof response?.signature === 'string' && typeof response?.authenticatorData === 'string';
  if (isAuthentication) {
    return verifyPasskeyAuthentication(opts);
  }
  try {
    const verification = await verifyRegistrationResponse({
      response: webauthn as RegistrationResponseJSON,
      expectedChallenge: expectedNonce,
      expectedOrigin,
      expectedRPID: rpId,
      requireUserVerification: true,
    });
    if (!verification.verified || !verification.registrationInfo) {
      return { phone_webauthn_attested: false, phone_webauthn_error: 'not_verified' };
    }
    const info = verification.registrationInfo;
    const isVirtual = isVirtualAuthenticator(info.aaguid);
    if (isVirtual && !allowTestAuthenticators) {
      return {
        phone_webauthn_attested: false,
        phone_webauthn_error: 'virtual_authenticator',
        phone_webauthn_virtual: true,
        phone_webauthn_aaguid: info.aaguid,
      };
    }
    if (info.credential?.id && info.credential?.publicKey) {
      const now = Math.floor(Date.now() / 1000);
      void opts.passkeyStore
        .save({
          credentialId: info.credential.id,
          publicKey: publicKeyBase64(info.credential.publicKey),
          signCount: info.credential.counter ?? 0,
          argusPubkey,
          createdAt: now,
          lastUsedAt: now,
        })
        .catch(() => {
          /* non-fatal - paired succeeds either way */
        });
    }
    return {
      phone_webauthn_attested: true,
      phone_webauthn_aaguid: info.aaguid,
      phone_webauthn_format: info.fmt,
      phone_webauthn_credential_id: info.credential?.id,
      phone_webauthn_credential_backed_up: info.credentialBackedUp,
      phone_webauthn_user_verified: info.userVerified,
      ...(isVirtual ? { phone_webauthn_virtual: true } : {}),
    };
  } catch (e) {
    return {
      phone_webauthn_attested: false,
      phone_webauthn_error: (e as Error).message,
    };
  }
}
