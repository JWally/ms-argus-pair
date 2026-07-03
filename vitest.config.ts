import { defineConfig } from 'vitest/config';

// Unit tests (tests/**). The scripts/*.test.mjs hygiene checks are
// build-artifact assertions and stay in test:hygiene; new tests should be
// written here, vitest-first. Goal state (see ms-poc-proxy-maker): a separate
// vitest.e2e.config.ts driving the deployed stack.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
