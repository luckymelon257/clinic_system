import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    passWithNoTests: true,
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 300_000,
  },
});
