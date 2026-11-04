import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['test/setup.ts'],
    fileParallelism: false,
    // Generous: the app check tests run real subprocesses, and CI machines can be slow.
    testTimeout: 180_000,
    hookTimeout: 120_000,
  },
});
