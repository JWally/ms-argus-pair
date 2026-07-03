/*
 * QR keyholder — owns the client ECDH private key and turns a sealed pair-token
 * into poisoned QR pixels, WITHOUT the plaintext ever touching the page realm.
 *
 * Two implementations behind one interface:
 *   - workerKeyholder: the SCIF path. The private key + descramble + render all
 *     live in a Web Worker (pair-qr-worker.ts); the page only sends pubkeys and
 *     receives pixels. This is what stops a page-context automation bot.
 *   - inlineKeyholder: fallback for environments without Worker (essentially
 *     none among real browsers). Same crypto, but in the page realm — so the
 *     plaintext is transiently page-visible. Kept so the widget always works.
 *
 * The mint fetch itself stays in pair.ts (page realm) — it only carries pubkeys
 * and ciphertext, nothing secret.
 */
import { exportPubRaw, genKeyPair } from './ecdh-seal';
import { paintSecureQr, type SecureQrPixels } from './qr-secure';

export interface QrKeyholder {
  /** Generate the ephemeral keypair; returns the public key (base64url) to mint with. */
  keygen(): Promise<string>;
  /** Descramble the sealed token and paint the poisoned QR. */
  render(enc: string, sPub: string): Promise<SecureQrPixels>;
  dispose(): void;
}

export function createQrKeyholder(base: string, debug: string): QrKeyholder {
  if (typeof Worker !== 'undefined') {
    try {
      return workerKeyholder(base, debug);
    } catch {
      /* Worker construction blocked — fall back to inline. */
    }
  }
  return inlineKeyholder(base, debug);
}

function workerKeyholder(base: string, debug: string): QrKeyholder {
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

function inlineKeyholder(base: string, debug: string): QrKeyholder {
  let priv: CryptoKey | null = null;
  return {
    async keygen() {
      const pair = await genKeyPair();
      priv = pair.privateKey;
      return exportPubRaw(pair.publicKey);
    },
    render(enc, sPub) {
      if (!priv) throw new Error('keygen not run');
      return paintSecureQr(priv, sPub, enc, base, debug);
    },
    dispose() {
      priv = null;
    },
  };
}
