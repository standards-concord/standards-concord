/**
 * Browser ES module bundles of the CDN packages the sample app imports, built from the
 * locally installed versions so recordings don't depend on (or change with) a CDN.
 */
import path from 'node:path';
import { build } from 'esbuild';

const cache = new Map<string, Promise<string>>();

export function vendorModule(name: 'n3' | '@rdfjs/wrapper'): Promise<string> {
  let p = cache.get(name);
  if (!p) {
    p = build({
      stdin: { contents: name === 'n3' ? 'export * from "n3"; export { default } from "n3";' : `export * from "${name}";`, resolveDir: path.resolve(import.meta.dirname, '..'), loader: 'js' },
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      write: false,
      minify: true,
      define: { global: 'globalThis', 'process.env.NODE_DEBUG': 'false', 'process.env.NODE_ENV': '"production"' },
      logLevel: 'silent',
    }).then((r) => r.outputFiles[0].text);
    cache.set(name, p);
  }
  return p;
}
