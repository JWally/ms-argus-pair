/*
 * QR SCIF worker.
 *
 * A dedicated Web Worker — the isolation is the point: CDP `addInitScript` /
 * page-context `Runtime.evaluate` cannot read worker scope, so the descramble
 * key and the plaintext pair-token live here, out of reach of a page-driving
 * bot. The worker:
 *
 *   1. 'keygen' → generates an ephemeral ECDH keypair (private key
 *      NON-EXTRACTABLE, never leaves this realm) and returns its public key.
 *      The page relays that pubkey to the mint call so the server seals to it.
 *   2. 'render' {enc, sPub, base, debug} → derives the shared key, opens the
 *      sealed token, paints the poisoned QR, and posts back ONLY the pixel
 *      buffer. The token and clean matrix never cross back to the page.
 *
 * The page only ever receives poisoned pixels — the same thing a screenshotter
 * gets — so a bot is forced onto the optical-decode path the poison defends.
 */
import { exportPubRaw, genKeyPair } from './ecdh-seal';
import { paintSecureQr } from './qr-secure';

type InMsg =
  | { type: 'keygen' }
  | { type: 'render'; enc: string; sPub: string; base: string; debug: string };

// `self` types as Window under the DOM lib; type only the worker surface we use.
const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<InMsg>) => void) | null;
  postMessage(message: unknown, transfer?: ArrayBufferLike[]): void;
};

let priv: CryptoKey | null = null;

ctx.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'keygen') {
      const pair = await genKeyPair();
      priv = pair.privateKey;
      ctx.postMessage({ type: 'pub', cPub: await exportPubRaw(pair.publicKey) });
      return;
    }
    if (msg.type === 'render') {
      if (!priv) throw new Error('keygen not run');
      const { data, width } = await paintSecureQr(priv, msg.sPub, msg.enc, msg.base, msg.debug);
      // Transfer the pixel buffer (zero-copy) — it's the only thing that leaves.
      ctx.postMessage({ type: 'pixels', data, width }, [data.buffer]);
    }
  } catch (err) {
    ctx.postMessage({ type: 'error', message: String((err as Error)?.message ?? err) });
  }
};
