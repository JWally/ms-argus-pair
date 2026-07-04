/*
 * QR SCIF worker.
 *
 * A dedicated Web Worker — the isolation is the point: CDP `addInitScript` /
 * page-context `Runtime.evaluate` cannot read worker scope. The worker:
 *
 *   1. 'keygen' → generates an ephemeral ECDH keypair (private key
 *      NON-EXTRACTABLE, never leaves this realm) and returns its public key.
 *   2. 'render' {enc, sPub, base, debug} → derives the shared key, AES-opens the
 *      blob to the still-FIB-SCRAMBLED token bytes, and hands those to the wasm
 *      enclave, which un-scrambles + rasters the poisoned QR in its own linear
 *      memory and returns ONLY pixels. The plaintext URL never becomes a JS
 *      value — not even here in the worker. A page-realm attacker who hooks
 *      `subtle.decrypt` sees scrambled bytes; to get the URL they must dump wasm
 *      memory or optically decode the rendered pixels (the hard ceiling).
 */
import init, { render_qr } from '../../wasm/qr-enclave/pkg/qr_enclave.js';
import { deriveAesKey, exportPubRaw, genKeyPair, importPubRaw, openBytes } from './ecdh-seal';

type InMsg =
  | { type: 'keygen' }
  | { type: 'render'; enc: string; sPub: string; base: string; debug: string };

// `self` types as Window under the DOM lib; type only the worker surface we use.
const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<InMsg>) => void) | null;
  postMessage(message: unknown, transfer?: ArrayBufferLike[]): void;
};

let priv: CryptoKey | null = null;
let wasmReady: Promise<unknown> | null = null;

ctx.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'keygen') {
      wasmReady ??= init(); // warm the wasm while the QR round-trips the server
      const pair = await genKeyPair();
      priv = pair.privateKey;
      ctx.postMessage({ type: 'pub', cPub: await exportPubRaw(pair.publicKey) });
      return;
    }
    if (msg.type === 'render') {
      if (!priv) throw new Error('keygen not run');
      await (wasmReady ??= init());
      const aesKey = await deriveAesKey(priv, await importPubRaw(msg.sPub));
      const scrambled = await openBytes(aesKey, msg.enc); // still fib-scrambled
      const rgba = render_qr(scrambled, msg.base, msg.debug); // Uint8Array RGBA
      const data = new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.length);
      const width = Math.round(Math.sqrt(data.length / 4));
      ctx.postMessage({ type: 'pixels', data, width }, [data.buffer]);
    }
  } catch (err) {
    ctx.postMessage({ type: 'error', message: String((err as Error)?.message ?? err) });
  }
};
