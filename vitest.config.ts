import { defineConfig } from 'vitest/config';

// Unit tests (tests/**). The scripts/*.test.mjs hygiene checks are
// build-artifact assertions and stay in test:hygiene; new tests should be
// written here, vitest-first. Goal state (see ms-poc-proxy-maker): a separate
// vitest.e2e.config.ts driving the deployed stack.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: [
        'cdk/lib/**/*.ts',
        'loader/message-contract.ts',
        'src/lib/**/*.ts',
        'src/lib/**/*.tsx',
        'src/pages/**/*.tsx',
      ],
      exclude: [
        'cdk/lib/pair-stack.ts',
        'cdk/lib/ws-stack.ts',
        'cdk/lib/valkey-stack.ts',
        'src/**/*.d.ts',
      ],
      thresholds: {
        lines: 44.9,
        functions: 45.2,
        branches: 42.5,
        statements: 43.7,
      },
    },
  },
});
