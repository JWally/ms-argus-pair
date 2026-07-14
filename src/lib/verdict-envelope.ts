/**
 * Fixed-size AES-GCM envelope for deferred Pair verdict disclosure.
 *
 * The ciphertext can be delivered as soon as the verdict is ready, but the
 * browser cannot distinguish pass from fail until the server releases the
 * session-specific key after the phone's DONE message. Fixed plaintext size
 * prevents verdict, reason, and annotation length from becoming an oracle.
 */

interface SubtleLike {
  importKey(
    format: string,
    data: ArrayBufferView,
    algorithm: object,
    extractable: boolean,
    usages: string[]
  ): Promise<CryptoKey>;
  encrypt(algorithm: object, key: CryptoKey, data: ArrayBufferView): Promise<ArrayBuffer>;
  decrypt(algorithm: object, key: CryptoKey, data: ArrayBufferView): Promise<ArrayBuffer>;
}

export interface DesktopVerdictPayload {
  kind: 'desktop-verdict';
  verdict: 'paired' | 'failed';
  reason: string | null;
  annotations: Record<string, unknown>;
}

export interface PhoneStatePayload {
  kind: 'phone-state';
  verdict: 'paired' | 'failed';
  nextDeviceTrust: string | null;
}

export type FixedVerdictPayload = DesktopVerdictPayload | PhoneStatePayload;

export interface SealedVerdictEnvelope {
  v: 1;
  algorithm: 'A256GCM';
  paddedBytes: number;
  iv: string;
  ciphertext: string;
}

export const FIXED_VERDICT_PLAINTEXT_BYTES = 16 * 1024;
const LENGTH_PREFIX_BYTES = 4;
const IV_BYTES = 12;
const AES_GCM = { name: 'AES-GCM', length: 256 };
const SUBTLE = globalThis.crypto.subtle as unknown as SubtleLike;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(value: string): Uint8Array {
  const base64 =
    value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  // eslint-disable-next-line security/detect-object-injection -- bounded decode into byte array.
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function additionalData(sessionId: string): Uint8Array {
  return encoder.encode(`argus-pair-verdict-v1:${sessionId}`);
}

async function importRevealKey(rawKey: Uint8Array): Promise<CryptoKey> {
  if (rawKey.byteLength !== 32) throw new Error('verdict reveal key must be 32 bytes');
  return SUBTLE.importKey('raw', Uint8Array.from(rawKey), AES_GCM, false, ['encrypt', 'decrypt']);
}

export async function sealFixedVerdictEnvelope(
  rawKey: Uint8Array,
  sessionId: string,
  payload: FixedVerdictPayload
): Promise<SealedVerdictEnvelope> {
  const encoded = encoder.encode(JSON.stringify(payload));
  if (encoded.byteLength + LENGTH_PREFIX_BYTES > FIXED_VERDICT_PLAINTEXT_BYTES) {
    throw new Error('verdict payload exceeds fixed envelope');
  }

  const plaintext = globalThis.crypto.getRandomValues(
    new Uint8Array(FIXED_VERDICT_PLAINTEXT_BYTES)
  );
  new DataView(plaintext.buffer).setUint32(0, encoded.byteLength);
  plaintext.set(encoded, LENGTH_PREFIX_BYTES);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await importRevealKey(rawKey);
  const ciphertext = new Uint8Array(
    await SUBTLE.encrypt(
      { name: 'AES-GCM', iv, additionalData: additionalData(sessionId), tagLength: 128 },
      key,
      plaintext
    )
  );
  return {
    v: 1,
    algorithm: 'A256GCM',
    paddedBytes: FIXED_VERDICT_PLAINTEXT_BYTES,
    iv: bytesToBase64Url(iv),
    ciphertext: bytesToBase64Url(ciphertext),
  };
}

export async function openFixedVerdictEnvelope(
  rawKey: Uint8Array,
  sessionId: string,
  envelope: SealedVerdictEnvelope
): Promise<FixedVerdictPayload> {
  if (
    envelope.v !== 1 ||
    envelope.algorithm !== 'A256GCM' ||
    envelope.paddedBytes !== FIXED_VERDICT_PLAINTEXT_BYTES
  ) {
    throw new Error('unsupported verdict envelope');
  }
  const key = await importRevealKey(rawKey);
  const plaintext = new Uint8Array(
    await SUBTLE.decrypt(
      {
        name: 'AES-GCM',
        iv: base64UrlToBytes(envelope.iv),
        additionalData: additionalData(sessionId),
        tagLength: 128,
      },
      key,
      base64UrlToBytes(envelope.ciphertext)
    )
  );
  if (plaintext.byteLength !== FIXED_VERDICT_PLAINTEXT_BYTES) {
    throw new Error('invalid verdict envelope size');
  }
  const length = new DataView(
    plaintext.buffer,
    plaintext.byteOffset,
    plaintext.byteLength
  ).getUint32(0);
  if (length <= 0 || length + LENGTH_PREFIX_BYTES > plaintext.byteLength) {
    throw new Error('invalid verdict envelope payload');
  }
  return JSON.parse(
    decoder.decode(plaintext.subarray(LENGTH_PREFIX_BYTES, LENGTH_PREFIX_BYTES + length))
  ) as FixedVerdictPayload;
}

export function decodeVerdictRevealKey(value: string): Uint8Array {
  const key = base64UrlToBytes(value);
  if (key.byteLength !== 32) throw new Error('invalid verdict reveal key');
  return key;
}

export function encodeVerdictRevealKey(value: Uint8Array): string {
  if (value.byteLength !== 32) throw new Error('invalid verdict reveal key');
  return bytesToBase64Url(value);
}
