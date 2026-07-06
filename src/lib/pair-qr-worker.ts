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
  location: { href: string; protocol: string };
};

// Provenance tripwire. This worker is ALWAYS a static same-origin module asset
// (Vite emits /assets/pair-qr-worker-*.js; dev serves it over http). It is
// never legitimately blob-backed. So a `blob:` self.location means we were
// substituted via the known `createObjectURL(new Blob([rewrittenSource]))`
// worker-wrapper attack (red-team, 2026-07-04) — refuse to decrypt/render so a
// tampered copy can't leak the token, and so the QR simply never appears in a
// wrapped session. A determined attacker can strip this after rewriting the
// source, so it's a bar-raiser (forces the pure-optical path), not a wall.
// If a blob-worker fallback is ever legitimately shipped, revisit this.
const BLOB_PROVENANCE = ctx.location?.protocol === 'blob:';

let priv: CryptoKey | null = null;
let wasmReady: Promise<unknown> | null = null;
let workerSha256: string | null = null;

function b64url(bytes: Uint8Array): string {
  let raw = '';
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hashOwnScript(): Promise<string> {
  const res = await fetch(ctx.location.href, { cache: 'no-store' });
  if (!res.ok) throw new Error(`worker_hash_fetch_${res.status}`);
  const digest = await crypto.subtle.digest('SHA-256', await res.arrayBuffer());
  return `sha256-${b64url(new Uint8Array(digest))}`;
}

ctx.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (BLOB_PROVENANCE) {
      ctx.postMessage({ type: 'error', message: 'blob_worker_provenance_refused' });
      return;
    }
    if (msg.type === 'keygen') {
      wasmReady ??= init(); // warm the wasm while the QR round-trips the server
      workerSha256 = await hashOwnScript();
      const pair = await genKeyPair();
      priv = pair.privateKey;
      ctx.postMessage({
        type: 'pub',
        cPub: await exportPubRaw(pair.publicKey),
        workerUrl: ctx.location.href,
        workerSha256,
      });
      return;
    }
    if (msg.type === 'render') {
      if (!priv) throw new Error('keygen not run');
      await (wasmReady ??= init());
      const aesKey = await deriveAesKey(priv, await importPubRaw(msg.sPub));
      const scrambled = await openBytes(aesKey, msg.enc); // still fib-scrambled
      if (!workerSha256) throw new Error('worker hash unavailable');
      const rgba = render_qr(scrambled, msg.base, msg.debug, workerSha256); // Uint8Array RGBA
      const data = new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.length);
      const width = Math.round(Math.sqrt(data.length / 4));
      ctx.postMessage({ type: 'pixels', data, width }, [data.buffer]);
    }
  } catch (err) {
    ctx.postMessage({ type: 'error', message: String((err as Error)?.message ?? err) });
  }
};
