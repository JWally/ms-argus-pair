/*
 * Isomorphic ECIES-style sealing for the pair-token QR delivery.
 *
 * Runs identically in the Node 22 Lambda (pair-api) and a browser Web Worker —
 * uses only `globalThis.crypto.subtle`, no Node or DOM APIs. The point: the
 * pair-token is delivered to the desktop's rendering pipeline as ciphertext, so
 * a page-context automation bot reading the mint response (or the wire) gets an
 * opaque blob instead of the redeemable token. The descramble key is an ECDH
 * shared secret whose private halves never leave their realm (the worker's is
 * non-extractable), so obtaining the ciphertext is useless without breaking
 * into the worker. Speed-bump under phone-attest, not the lock — but it forces
 * every bot onto the optical-decode path the poison QR already defends. See the
 * pair README + docs/qr-poisoning-research.md.
 *
 * Ephemeral-ephemeral (ECIES): each mint the worker sends its ephemeral public
 * key, the server generates its own ephemeral pair, both derive the same
 * AES-GCM key, the server seals, the worker opens. Nothing is stored server-side
 * and each token has a fresh key.
 */

// Minimal, lib-agnostic WebCrypto surface. This file is compiled under BOTH the
// app tsconfig (DOM lib) and the node tsconfig (ES lib), which disagree on
// SubtleCrypto's exact typed-array signatures (TS 5.9 ArrayBuffer generics).
// Typing our own surface with ArrayBufferView data params sidesteps the clash.
interface KeyPair {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
}
interface SubtleLike {
  generateKey(algo: object, extractable: boolean, usages: string[]): Promise<KeyPair>;
  exportKey(format: string, key: CryptoKey): Promise<ArrayBuffer>;
  importKey(
    format: string,
    data: ArrayBufferView,
    algo: object,
    extractable: boolean,
    usages: string[]
  ): Promise<CryptoKey>;
  deriveKey(
    algo: object,
    base: CryptoKey,
    derived: object,
    extractable: boolean,
    usages: string[]
  ): Promise<CryptoKey>;
  encrypt(algo: object, key: CryptoKey, data: ArrayBufferView): Promise<ArrayBuffer>;
  decrypt(algo: object, key: CryptoKey, data: ArrayBufferView): Promise<ArrayBuffer>;
}

const SUBTLE = globalThis.crypto.subtle as unknown as SubtleLike;
const ECDH = { name: 'ECDH', namedCurve: 'P-256' };

// ── base64url (isomorphic; no Buffer) ──────────────────────────────────────
function b64urlFromBytes(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function bytesFromB64url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  // eslint-disable-next-line security/detect-object-injection -- bounded decode into byte array.
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

// ── ECDH key handling ──────────────────────────────────────────────────────

/** Generate an ephemeral ECDH P-256 keypair. Private key is non-extractable. */
export function genKeyPair(): Promise<KeyPair> {
  return SUBTLE.generateKey(ECDH, false, ['deriveKey']);
}

/** Export a public key to raw base64url (65-byte uncompressed point). */
export async function exportPubRaw(pub: CryptoKey): Promise<string> {
  return b64urlFromBytes(new Uint8Array(await SUBTLE.exportKey('raw', pub)));
}

/** Import a peer public key from raw base64url. */
export function importPubRaw(b64: string): Promise<CryptoKey> {
  return SUBTLE.importKey('raw', bytesFromB64url(b64), ECDH, false, []);
}

/** Derive the shared AES-GCM-256 key from our private key + the peer public key. */
export function deriveAesKey(priv: CryptoKey, peerPub: CryptoKey): Promise<CryptoKey> {
  return SUBTLE.deriveKey(
    { name: 'ECDH', public: peerPub },
    priv,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

// ── AES-GCM seal / open (bytes) ─────────────────────────────────────────────
//
// Byte-level on purpose: the active QR path seals server-rendered PNG bytes,
// not a string. Keeping it as bytes means `open` never TextDecodes a plaintext
// URL into a JS value.

/** Seal bytes → base64url(iv[12] || ciphertext||tag). */
export async function sealBytes(aesKey: CryptoKey, bytes: Uint8Array): Promise<string> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await SUBTLE.encrypt({ name: 'AES-GCM', iv }, aesKey, bytes));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return b64urlFromBytes(out);
}

/** Open a base64url(iv||ct) blob to bytes. Throws on a bad tag (tamper / wrong key). */
export async function openBytes(aesKey: CryptoKey, blob: string): Promise<Uint8Array> {
  const raw = bytesFromB64url(blob);
  const iv = raw.subarray(0, 12);
  const ct = raw.subarray(12);
  return new Uint8Array(await SUBTLE.decrypt({ name: 'AES-GCM', iv }, aesKey, ct));
}
