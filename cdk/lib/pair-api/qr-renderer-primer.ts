import { renderPairTokenPngFrames } from './server-qr-png';

type RenderQr = () => Promise<unknown>;

// Match the 22-character token minted by pair-token.ts so the warmup render
// exercises the same QR geometry and PNG encoder path as a real request.
const WARMUP_PAIR_TOKEN = '0000000000000000000000';

export function createQrRendererPrimer(renderQr: RenderQr): () => Promise<boolean> {
  let rendered: Promise<unknown> | undefined;

  return async () => {
    if (rendered) {
      await rendered;
      return false;
    }

    const attempt = Promise.resolve().then(renderQr);
    rendered = attempt;
    try {
      await attempt;
      return true;
    } catch (error) {
      // A transient warmup failure must not permanently suppress later retries.
      if (rendered === attempt) rendered = undefined;
      throw error;
    }
  };
}

export function createServerQrRendererPrimer(pairOrigin: string): () => Promise<boolean> {
  return createQrRendererPrimer(() =>
    renderPairTokenPngFrames(pairOrigin, WARMUP_PAIR_TOKEN).then(() => undefined)
  );
}
