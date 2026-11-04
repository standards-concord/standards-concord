import { defineConfig } from 'vitest/config';

// Unit tests for pure browser-side logic (query builder, highlighters). The UI
// itself is covered end to end by Playwright in e2e/.
export default defineConfig({
  test: { include: ['src/**/*.test.ts'], environment: 'node' },
});
