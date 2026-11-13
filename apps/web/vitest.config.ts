import { defineConfig } from 'vitest/config';
import { APP_VERSION } from '../../packages/shared/src/appReleases';

// Unit tests for pure browser-side logic (query builder, highlighters). The UI
// itself is covered end to end by Playwright in e2e/.
export default defineConfig({
  define: { 'import.meta.env.VITE_APP_VERSION': JSON.stringify(APP_VERSION) },
  test: { include: ['src/**/*.test.ts', 'src/**/*.test.tsx'], environment: 'node' },
});
