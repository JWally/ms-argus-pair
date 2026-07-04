/*
 * QR keyholder — owns the client ECDH private key and turns a sealed pair-token
 * into poisoned QR pixels inside a dedicated Web Worker. The isolation is the
 * point: CDP `addInitScript` / page-context `Runtime.evaluate` cannot read
 * worker scope, so the descramble key and the plaintext pair-token live there,
 * out of reach of a page-driving bot that runs AFTER the app starts.
 *
 * FAIL-CLOSED, no inline fallback. An inline (page-realm) descramble would let
 * an attacker force the weak path just by deleting `window.Worker`, then read
 * the plaintext token directly — strictly worse than the worker. Worker support
 * is universal, so if the worker can't be created we render no QR rather than
 * leak. (Note: a page realm the attacker fully owns BEFORE app start can still
 * substitute the Worker constructor and wrap the real worker — that's the hard
 * ceiling; the server-side pairing gate, not QR secrecy, is the actual lock.)
 *
 * The mint fetch stays in pair.ts (page realm) — it only carries pubkeys and
 * ciphertext, nothing secret.
 */
/** Poisoned QR as a raw RGBA pixel buffer (square; width px per side). */
export interface SecureQrPixels {
  data: Uint8ClampedArray;
  width: number;
}

export interface QrKeyholder {
  /** Generate the ephemeral keypair; returns the public key (base64url) to mint with. */
  keygen(): Promise<string>;
  /** Descramble the sealed token and paint the poisoned QR. */
  render(enc: string, sPub: string): Promise<SecureQrPixels>;
  dispose(): void;
}

/** Create the SCIF worker keyholder. Throws (fails closed) if Worker is unavailable. */
export function createQrKeyholder(base: string, debug: string): QrKeyholder {
  if (typeof Worker === 'undefined') {
    throw new Error('Web Worker unavailable — cannot render the pairing QR securely');
  }
  const worker = new Worker(new URL('./pair-qr-worker.ts', import.meta.url), { type: 'module' });
  const await1 = <T>(type: string): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const on = (e: MessageEvent) => {
        const d = e.data as { type?: string; message?: string };
        if (d?.type === type) {
          worker.removeEventListener('message', on);
          resolve(d as T);
        } else if (d?.type === 'error') {
          worker.removeEventListener('message', on);
          reject(new Error(d.message ?? 'qr worker error'));
        }
      };
      worker.addEventListener('message', on);
    });
  return {
    async keygen() {
      worker.postMessage({ type: 'keygen' });
      return (await await1<{ cPub: string }>('pub')).cPub;
    },
    async render(enc, sPub) {
      worker.postMessage({ type: 'render', enc, sPub, base, debug });
      const { data, width } = await await1<{ data: Uint8ClampedArray; width: number }>('pixels');
      return { data, width };
    },
    dispose() {
      worker.terminate();
    },
  };
}
