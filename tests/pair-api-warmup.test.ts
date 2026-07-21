import { describe, expect, it, vi } from 'vitest';
import { createPairApiWarmupMiddleware } from '../cdk/lib/pair-api/warmup';

function createDependencies() {
  return {
    hydrateTrustSecret: vi.fn().mockResolvedValue(undefined),
    warmStoreConnection: vi.fn().mockResolvedValue(undefined),
    primeQrRenderer: vi.fn().mockResolvedValue(true),
    now: vi.fn().mockReturnValueOnce(1_000).mockReturnValueOnce(1_725),
    logInfo: vi.fn(),
    logWarn: vi.fn(),
  };
}

describe('Pair API warmup middleware', () => {
  it('primes every cold-path dependency and short-circuits heater events', async () => {
    const dependencies = createDependencies();
    const middleware = createPairApiWarmupMiddleware(dependencies);
    const request = { event: { source: 'serverless-plugin-warmup' } };

    await middleware.before?.(request as never);

    expect(dependencies.hydrateTrustSecret).toHaveBeenCalledOnce();
    expect(dependencies.warmStoreConnection).toHaveBeenCalledOnce();
    expect(dependencies.primeQrRenderer).toHaveBeenCalledOnce();
    expect(dependencies.logInfo).toHaveBeenCalledWith(
      JSON.stringify({ event: 'pair_qr_renderer_primed', durationMs: 725 })
    );
    expect(request).toHaveProperty('response', { warmed: true });
  });

  it('does nothing for customer requests', async () => {
    const dependencies = createDependencies();
    const middleware = createPairApiWarmupMiddleware(dependencies);
    const request = { event: { routeKey: 'POST /api/session/start' } };

    await middleware.before?.(request as never);

    expect(dependencies.primeQrRenderer).not.toHaveBeenCalled();
    expect(request).not.toHaveProperty('response');
  });
});
