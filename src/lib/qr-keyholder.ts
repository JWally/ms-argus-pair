/*
 * QR keyholder — owns the client ECDH private key and opens a sealed server-
 * rendered QR PNG inside a dedicated Web Worker. The isolation is the
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
/** Poisoned QR image bytes. The page receives display bytes, not the token URL. */
export type SecureQrImage =
  | {
      kind: 'png';
      data: Uint8Array;
      width: number;
      mime: 'image/png';
    }
  | {
      kind: 'png-frames';
      frames: Uint8Array[];
      frameMs: number;
      mime: 'image/png';
    };

export interface SecureQrPixels {
  data: Uint8Array;
  width: number;
  mime: 'image/png';
}

type WorkerQrMessage =
  | (SecureQrPixels & { type: 'image' })
  | {
      type: 'frames';
      frames: Uint8Array[];
      frameMs: number;
      mime: 'image/png';
    }
  | { type: 'error'; message?: string }
  | { type?: string; message?: string };

export function preferredQrCompression(): 'gzip' | 'none' {
  return 'none';
}

export interface QrKeyholder {
  /** Generate the ephemeral keypair and worker self-hash used for the mint. */
  keygen(): Promise<{ cPub: string; workerUrl: string; workerSha256: string }>;
  /** Open the sealed server-rendered QR image. */
  render(
    enc: string,
    sPub: string,
    opts?: { kind?: 'png' | 'png-frames'; compression?: 'gzip' | 'none' }
  ): Promise<SecureQrImage>;
  dispose(): void;
}

/** Create the SCIF worker keyholder. Throws (fails closed) if Worker is unavailable. */
export function createQrKeyholder(): QrKeyholder {
  if (typeof Worker === 'undefined') {
    throw new Error('Web Worker unavailable — cannot render the pairing QR securely');
  }
  const worker = new Worker(new URL('./pair-qr-worker.ts', import.meta.url), { type: 'module' });
  const awaitWorker = <T>(resolveMessage: (message: WorkerQrMessage) => T | null): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const on = (e: MessageEvent) => {
        const message = e.data as WorkerQrMessage;
        const value = resolveMessage(message);
        if (value) {
          worker.removeEventListener('message', on);
          resolve(value);
        } else if (message?.type === 'error') {
          worker.removeEventListener('message', on);
          reject(new Error(message.message ?? 'qr worker error'));
        }
      };
      worker.addEventListener('message', on);
    });
  const awaitImage = (): Promise<SecureQrImage> =>
    awaitWorker<SecureQrImage>((message) => {
      if (message.type === 'image') {
        const image = message as SecureQrPixels & { type: 'image' };
        return { kind: 'png', data: image.data, width: image.width, mime: image.mime };
      }
      if (message.type === 'frames') {
        const frameMessage = message as Extract<WorkerQrMessage, { type: 'frames' }>;
        return {
          kind: 'png-frames',
          frames: frameMessage.frames,
          frameMs: frameMessage.frameMs,
          mime: frameMessage.mime,
        };
      }
      return null;
    });
  return {
    async keygen() {
      worker.postMessage({ type: 'keygen' });
      const pub = await awaitWorker<{ cPub: string; workerUrl: string; workerSha256: string }>(
        (message) =>
          message.type === 'pub'
            ? (message as { cPub: string; workerUrl: string; workerSha256: string })
            : null
      );
      return pub;
    },
    async render(enc, sPub, opts) {
      worker.postMessage({
        type: 'render',
        enc,
        sPub,
        kind: opts?.kind,
        compression: opts?.compression,
      });
      return awaitImage();
    },
    dispose() {
      worker.terminate();
    },
  };
}
