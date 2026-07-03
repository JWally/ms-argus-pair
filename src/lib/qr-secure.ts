/*
 * Secure QR render: descramble the sealed pair-token and paint the poisoned QR,
 * all from a client ECDH private key that never leaves its realm. Shared by the
 * QR worker (pair-qr-worker.ts — the isolated path) and the inline fallback in
 * pair.ts (only used when Worker is unavailable). Pure compute: takes the
 * private key + server pubkey + sealed blob, returns a poisoned pixel buffer.
 * The plaintext token exists only for the microseconds between `open` and
 * `paintQr`, and only in whichever realm called this.
 */
import { deriveAesKey, importPubRaw, open } from './ecdh-seal';
import { buildQrMatrix, paintQr } from './qr-paint';

export interface SecureQrPixels {
  data: Uint8ClampedArray;
  width: number;
}

export async function paintSecureQr(
  clientPriv: CryptoKey,
  serverPubRaw: string,
  enc: string,
  pairUrlBase: string,
  debugParam: string
): Promise<SecureQrPixels> {
  const aesKey = await deriveAesKey(clientPriv, await importPubRaw(serverPubRaw));
  const token = await open(aesKey, enc);
  const pairUrl = `${pairUrlBase}/p/${token}${debugParam}`;
  const { data, width } = paintQr(buildQrMatrix(pairUrl));
  return { data, width };
}
