import type { MiddlewareObj } from '@middy/core';

interface PairApiWarmupDependencies {
  hydrateTrustSecret: () => Promise<unknown>;
  warmStoreConnection: () => Promise<unknown>;
  primeQrRenderer: () => Promise<boolean>;
  now: () => number;
  logInfo: (message: string) => void;
  logWarn: (message: string) => void;
}

function isWarmingUp(event: unknown): boolean {
  if (!event || typeof event !== 'object') return false;
  const candidate = event as { source?: unknown; warmup?: unknown };
  return candidate.source === 'serverless-plugin-warmup' || candidate.warmup === true;
}

export function createPairApiWarmupMiddleware(
  dependencies: PairApiWarmupDependencies
): MiddlewareObj<unknown, unknown> {
  return {
    before: async (request) => {
      if (!isWarmingUp(request.event)) return;

      // Keeping Lambda warm does not initialize the PNG encoder. Exercise it
      // once per environment so a customer does not pay its 0.5-0.8s first use.
      const primeStartedAt = dependencies.now();
      try {
        const [, , didPrimeQrRenderer] = await Promise.all([
          dependencies.hydrateTrustSecret(),
          dependencies.warmStoreConnection(),
          dependencies.primeQrRenderer(),
        ]);
        if (didPrimeQrRenderer) {
          dependencies.logInfo(
            JSON.stringify({
              event: 'pair_qr_renderer_primed',
              durationMs: dependencies.now() - primeStartedAt,
            })
          );
        }
      } catch (error) {
        dependencies.logWarn(`[pair] warmup priming failed: ${(error as Error).message}`);
      }

      request.response = { warmed: true };
    },
  };
}
