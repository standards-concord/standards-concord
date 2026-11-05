/**
 * Boots a fresh, offline Concord (API + web app) for a recording, the same way the
 * Playwright tests do, plus a small static server for the sample app and the terminal.
 */
import { pathToFileURL } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

async function waitFor(url: string, ms: number, proc?: ChildProcess, log?: () => string) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (proc && proc.exitCode !== null) throw new Error(`Server for ${url} exited early (${proc.exitCode}).\n${log?.().slice(-2000) ?? ''}`);
    try {
      const r = await fetch(url);
      if (r.status < 500) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`Timed out waiting for ${url}.\n${log?.().slice(-2000) ?? ''}`);
}

export interface Concord {
  web: string;
  api: string;
  /** The server's data directory: each ontology's git repository is under ontologies/<slug>. */
  dataDir: string;
  stop(): void;
}

export async function startConcord(opts: { apiPort: number; webPort: number; mode: 'dev' | 'preview'; epoch: string; env?: Record<string, string> }): Promise<Concord> {
  const dataDir = path.join(os.tmpdir(), `concord-walkthrough-${process.pid}`);
  const procs: ChildProcess[] = [];
  const logs: string[] = ['', ''];
  const start = (i: number, args: string[], env: Record<string, string>) => {
    const p = spawn('pnpm', args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    p.stdout!.on('data', (d) => (logs[i] += d));
    p.stderr!.on('data', (d) => (logs[i] += d));
    procs.push(p);
    return p;
  };
  const api = `http://localhost:${opts.apiPort}`;
  const web = `http://localhost:${opts.webPort}`;
  const apiProc = start(0, ['--filter', '@concord/server', 'start'], {
    PORT: String(opts.apiPort),
    CONCORD_DATA_DIR: dataDir,
    WEB_URL: web,
    DEMO_MODE: 'true',
    // Deterministic and offline: no real LLM, pods or sign-in providers.
    LLM_PROVIDER: 'simulated',
    ANTHROPIC_API_KEY: '',
    SOLID_SERVER_URL: '',
    GOOGLE_CLIENT_ID: '',
    GITHUB_CLIENT_ID: '',
    // No lookups on the internet: the FAIR "resolvable IRI" checks show as not checked.
    FAIR_RESOLVE: '0',
    // The same dates and ids on every recording (see deterministic.mjs).
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import ${pathToFileURL(path.join(import.meta.dirname, 'deterministic.mjs')).href}`.trim(),
    WALKTHROUGH_EPOCH: opts.epoch,
    WALKTHROUGH_SEED: 'concord-walkthrough',
    ...opts.env,
  });
  if (opts.mode === 'preview' && !existsSync(path.join(ROOT, 'apps/web/dist/index.html'))) throw new Error('No production build: run `pnpm --filter @concord/web build` first, or use --web dev');
  const webArgs = opts.mode === 'preview' ? ['vite', 'preview'] : ['vite'];
  const webProc = start(1, ['--filter', '@concord/web', 'exec', ...webArgs, '--port', String(opts.webPort), '--strictPort'], { CONCORD_API: api });
  const stop = () => {
    for (const p of procs) {
      try {
        process.kill(-p.pid!, 'SIGTERM');
      } catch {
        /* gone */
      }
    }
  };
  process.on('exit', stop);
  try {
    await Promise.all([waitFor(`${api}/healthz`, 120_000, apiProc, () => logs[0]), waitFor(web, 120_000, webProc, () => logs[1])]);
  } catch (e) {
    stop();
    throw e;
  }
  return { web, api, dataDir, stop };
}

/** Serves the sample app (with {{PLACEHOLDERS}} filled in) and the stage pages. */
export function startStatic(opts: { port: number; appDir: () => string; stageDir: string; vars: () => Record<string, string> }) {
  const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.ttl': 'text/turtle; charset=utf-8', '.json': 'application/json' };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      let file: string;
      if (url.pathname.startsWith('/__stage/')) file = path.join(opts.stageDir, url.pathname.slice('/__stage/'.length));
      else file = path.join(opts.appDir(), url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
      const base = url.pathname.startsWith('/__stage/') ? opts.stageDir : opts.appDir();
      if (!path.resolve(file).startsWith(path.resolve(base)) || !(await stat(file).catch(() => null))?.isFile()) {
        res.writeHead(404).end('Not found');
        return;
      }
      const ext = path.extname(file);
      let body: Buffer | string = await readFile(file);
      if (ext === '.js' || ext === '.html') body = fill(body.toString('utf8'), opts.vars());
      res.writeHead(200, { 'content-type': types[ext] ?? 'application/octet-stream', 'cache-control': 'no-store' }).end(body);
    } catch (e) {
      res.writeHead(500).end(String(e));
    }
  });
  return new Promise<{ url: string; close: () => void }>((resolve) => server.listen(opts.port, () => resolve({ url: `http://localhost:${opts.port}`, close: () => server.close() })));
}

export function fill(text: string, vars: Record<string, string>) {
  return text.replace(/\{\{(\w+)\}\}/g, (m, k) => vars[k] ?? m);
}
