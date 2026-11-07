#!/usr/bin/env node
// Serves the Vercel function that scripts/vercel-build.mjs wrote, on this machine, to check it before a deploy:
//
//   node scripts/vercel-build.mjs --function
//   VERCEL=1 DATABASE_URL=postgres://… node scripts/vercel-serve.mjs [port]
//
// Requests go to the function as Vercel's routes would send them (.vercel/output/config.json); work the function
// hands to waitUntil is awaited in the background. Static files aren't served: use the web app's own server.
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fn = path.join(root, '.vercel/output/functions/api.func');
const vc = JSON.parse(fs.readFileSync(path.join(fn, '.vc-config.json'), 'utf8'));
// The launcher's request context, where @vercel/functions finds waitUntil.
const pending = new Set();
globalThis[Symbol.for('@vercel/request-context')] = {
  get: () => ({ waitUntil: (p) => (pending.add(p), p.finally(() => pending.delete(p))) }),
};
const { default: handler } = await import(pathToFileURL(path.join(fn, vc.handler)).href);
const api = new RegExp(JSON.parse(fs.readFileSync(path.join(root, '.vercel/output/config.json'), 'utf8')).routes[0].src);
const port = Number(process.argv[2] ?? 8797);
http
  .createServer((req, res) => {
    if (!api.test(new URL(req.url, 'http://x').pathname)) return void res.writeHead(404).end('not an API path');
    handler(req, res);
  })
  .listen(port, () => console.log(`Vercel function on http://localhost:${port}`));
