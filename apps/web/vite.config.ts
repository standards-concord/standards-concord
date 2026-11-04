import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const target = process.env.CONCORD_API ?? 'http://localhost:8787';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // sparq loads its WebAssembly from a URL relative to its own module. Vite's dev
  // prebundler moves the module into node_modules/.vite/deps, where that URL
  // falls through to index.html ("expected magic word 00 61 73 6d"). Serving
  // sparq unbundled keeps the .wasm next to the module in dev; the production
  // build already rewrites the URL to a hashed asset.
  optimizeDeps: { exclude: ['@sparq-org/sparq'] },
  // The in-browser reasoner runs in a module Web Worker (src/lib/reasonWorker.ts), which code-splits.
  worker: { format: 'es' },
  server: {
    port: 5173,
    proxy: {
      '/api': { target, changeOrigin: true },
      // Not plain '/auth', which would also catch the OAuth '/authorize' endpoint below.
      '^/auth/': { target, changeOrigin: true },
      // MCP and its OAuth endpoints keep the dev server's Host, so the URLs they advertise point back here.
      '/mcp': { target },
      '^/(\\.well-known/|authorize|token|register|revoke)': { target },
      // Public ontology pages; the regex keeps app routes such as /definitions out.
      '^/def/': { target, changeOrigin: false },
    },
  },
  build: { outDir: 'dist', sourcemap: true, chunkSizeWarningLimit: 1500 },
});
