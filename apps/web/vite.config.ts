import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const target = process.env.CONCORD_API ?? 'http://localhost:8787';

// The commit being built, shown next to the app version on the alpha pages (Vercel and GitHub Actions set these).
const commit = (process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.GITHUB_SHA ?? '').slice(0, 40);

/**
 * Writes sw.js (from sw/sw.js) into the build with the list of every built file, so the service
 * worker keeps the whole app on the device and Concord opens with no connection. Its version is a hash
 * of every kept file's contents, so any change makes browsers install the new one.
 */
function serviceWorker(): Plugin {
  let outDir = 'dist';
  return {
    name: 'concord-service-worker',
    apply: 'build',
    configResolved(c) {
      outDir = path.resolve(c.root, c.build.outDir);
    },
    closeBundle() {
      const files: string[] = [];
      const walk = (dir: string) => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) walk(full);
          else if (!/\.(map|md)$/.test(e.name) && e.name !== 'sw.js' && e.name !== 'index.html') files.push('/' + path.relative(outDir, full).split(path.sep).join('/'));
        }
      };
      walk(outDir);
      files.sort();
      // Every kept file's contents, not just its name: a public file replaced under the same name changes it too.
      const hash = createHash('sha256').update(readFileSync(path.join(outDir, 'index.html')));
      for (const f of files) hash.update(f).update(readFileSync(path.join(outDir, f.slice(1))));
      const version = hash.digest('hex').slice(0, 12);
      const template = readFileSync(path.resolve(import.meta.dirname, 'sw/sw.js'), 'utf8');
      const sw = template.replace('self.__CONCORD_VERSION__', JSON.stringify(version)).replace('self.__CONCORD_FILES__', JSON.stringify(files));
      writeFileSync(path.join(outDir, 'sw.js'), sw);
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), serviceWorker()],
  define: { 'import.meta.env.VITE_APP_COMMIT': JSON.stringify(commit) },
  // sparq loads its WebAssembly from a URL relative to its own module. Vite's dev
  // prebundler moves the module into node_modules/.vite/deps, where that URL
  // falls through to index.html ("expected magic word 00 61 73 6d"). Serving
  // sparq unbundled keeps the .wasm next to the module in dev; the production
  // build already rewrites the URL to a hashed asset.
  optimizeDeps: {
    exclude: ['@sparq-org/sparq'],
  },
  // The query worker runs as a module Web Worker: it code-splits, and loads sparq with a dynamic import.
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
      // Public ontology pages and fork documents; the regex keeps app routes such as /definitions out, and
      // allows a query string (Vite matches the whole URL).
      '^/def(?:/|$|\\?|\\.(?:jsonld|ttl)(?:$|\\?))': { target, changeOrigin: false },
    },
  },
  build: { outDir: 'dist', sourcemap: true, chunkSizeWarningLimit: 1500 },
});
