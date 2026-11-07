import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['test/setup.ts'],
    // Files run in parallel (one per CPU): each has its own data directory and, with
    // TEST_DATABASE_URL, its own database per worker (test/setup.ts). One at a time took
    // over 6 minutes; in parallel about 2.
    // Generous: the app check tests run real subprocesses, and CI machines can be slow.
    testTimeout: 180_000,
    hookTimeout: 120_000,
  },
});
