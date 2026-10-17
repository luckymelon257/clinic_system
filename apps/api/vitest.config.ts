import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/global-setup.ts'], // resets clinic_api_test
    setupFiles: ['tests/setup-env.ts'], // points the app pool at clinic_api_test
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
