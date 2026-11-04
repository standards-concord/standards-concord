import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const target = process.env.CONCORD_API ?? 'http://localhost:8787';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target, changeOrigin: true },
      // Not plain '/auth', which would also catch the OAuth '/authorize' endpoint below.
      '^/auth/': { target, changeOrigin: true },
      // MCP and its OAuth endpoints keep the dev server's Host, so the URLs they advertise point back here.
      '/mcp': { target },
      '^/(\\.well-known/|authorize|token|register|revoke)': { target },
    },
  },
  build: { outDir: 'dist', sourcemap: true, chunkSizeWarningLimit: 1500 },
});
