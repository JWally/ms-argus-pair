import { defineConfig } from 'vitest/config';

// E2E tests (tests/e2e/**.e2e.ts) drive the DEPLOYED stack over HTTP — they are
// deliberately SEPARATE from the unit suite (vitest.config.ts) and NOT in the
// pre-push gate, so a network blip or an un-deployed change can't block a push.
// Run on demand / after deploy: `npm run test:e2e` (override PAIR_HOST to point
// at a different stage). Mirrors ms-poc-proxy-maker's vitest.e2e.config.ts.
export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.e2e.ts'],
    testTimeout: 20_000,
    // Native REST API keys can take tens of seconds to propagate after the
    // projection suite creates its isolated dev-jw credential.
    hookTimeout: 75_000,
    // Retry at the individual case boundary for transient API/AWS reads. A
    // deterministic trust-boundary regression still fails all three attempts.
    retry: 2,
  },
});
