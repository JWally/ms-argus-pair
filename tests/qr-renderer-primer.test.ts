import { describe, expect, it, vi } from 'vitest';
import { createQrRendererPrimer } from '../cdk/lib/pair-api/qr-renderer-primer';

describe('QR renderer primer', () => {
  it('shares one render across concurrent and later warmup calls', async () => {
    let finishRender: (() => void) | undefined;
    const render = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishRender = resolve;
        })
    );
    const prime = createQrRendererPrimer(render);

    const first = prime();
    const concurrent = prime();
    await Promise.resolve();
    expect(render).toHaveBeenCalledTimes(1);

    finishRender?.();
    await expect(Promise.all([first, concurrent])).resolves.toEqual([true, false]);
    await expect(prime()).resolves.toBe(false);
    expect(render).toHaveBeenCalledTimes(1);
  });

  it('retries on the next warmup call after a render failure', async () => {
    const render = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('png unavailable'))
      .mockResolvedValueOnce();
    const prime = createQrRendererPrimer(render);

    await expect(prime()).rejects.toThrow('png unavailable');
    await expect(prime()).resolves.toBe(true);
    await expect(prime()).resolves.toBe(false);
    expect(render).toHaveBeenCalledTimes(2);
  });
});
