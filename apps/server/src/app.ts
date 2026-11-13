import fs from 'node:fs';
import path from 'node:path';
import cookieParser from 'cookie-parser';
import express, { type NextFunction, type Request, type Response } from 'express';
import { mountAuth, sessionMiddleware } from './auth.js';
import { syncClock } from './clock.js';
import { config } from './config.js';
import { HttpError, ReadOnlyError } from './db.js';
import { mcpHandler } from './mcp.js';
import { oauthRoutes } from './oauth.js';
import { reportRouter } from './public/report.js';
import { publicRouter } from './public/routes.js';
import { licenceRouter } from './public/licences.js';
import { validationRouter } from './public/validate.js';
import { apiRouter } from './routes/api.js';
import { mountGithubAppWebhook } from './routes/githubApp.js';
import { forkResolver } from './routes/forkResolver.js';
import { dailyCron, scheduleAfterRequests } from './services/scheduler.js';
import { solid } from './services/solid.js';
import { getUser } from './services/users.js';
import { StoreBusyError } from './store/index.js';

export function createApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');
  // Only believe X-Forwarded-* from a proxy on this machine or its private network (Caddy in the
  // same Docker network in production, Vite in development). TRUST_PROXY overrides it, in Express's syntax.
  app.set('trust proxy', process.env.TRUST_PROXY ?? 'loopback, linklocal, uniquelocal');
  app.use(cookieParser());
  // Read-only while Concord moves (CONCORD_READ_ONLY): anything that would change something is turned away.
  if (config.readOnly)
    app.use((req, res, next) => {
      if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
      res.setHeader('Retry-After', '300');
      res.status(503).json({ error: new ReadOnlyError().message });
    });
  // Scheduled work on Vercel: due work is looked for after requests (services/scheduler.ts).
  if (config.schedule === 'requests' && !config.readOnly) app.use(scheduleAfterRequests);
  // The demo's governance clock may have been moved by another instance: load it before the request.
  if (config.demoMode)
    app.use((_req, _res, next) => {
      syncClock().then(() => next(), next);
    });
  app.use(sessionMiddleware);

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  // Auto-provisioned WebID profiles, used when no Solid server is configured.
  app.get('/people/:id', async (req, res) => {
    const user = await getUser(String(req.params.id));
    if (!user) throw new HttpError(404, 'No such person');
    // Anyone can resolve a WebID (sign-in needs that), but names are for signed-in users.
    res.set('Vary', 'Cookie').type('text/turtle').send(solid.profileDocument(user, { named: !!req.user }));
  });

  const auth = express.Router();
  mountAuth(auth);
  app.use(auth);

  // Domain verification for the OpenAI plugin directory, when submitting Concord there.
  app.get('/.well-known/openai-apps-challenge', (_req, res) => {
    if (!process.env.OPENAI_APPS_CHALLENGE) throw new HttpError(404, 'Not configured');
    res.type('text/plain').send(process.env.OPENAI_APPS_CHALLENGE);
  });
  // OAuth 2.1 for MCP clients: discovery, client registration, /authorize, /token, /revoke.
  app.use(oauthRoutes);
  app.all('/mcp', express.json({ limit: config.bodyLimits.json }), mcpHandler);
  mountGithubAppWebhook(app);
  // The daily Vercel Cron call: everything scheduled, due or not.
  app.get('/api/cron/daily', dailyCron);
  app.use('/api', apiRouter());
  // Development forks, dereferenceable so applications can import them (/def/<ontology>/forks/<fork>).
  app.use(forkResolver());
  // Public, dereferenceable ontology and version IRIs (HTML or RDF by content negotiation),
  // POST to them to validate data against their SHACL shapes, and public problem reports.
  app.use(reportRouter());
  app.use(validationRouter());
  app.use(publicRouter());
  app.use(licenceRouter());

  // The built web app, with client-side routing fallback.
  if (fs.existsSync(path.join(config.webDist, 'index.html'))) {
    app.use(express.static(config.webDist, { index: false, maxAge: '1h' }));
    app.get(/^(?!\/(api|auth|mcp|people|def|\.well-known)\b).*/, (_req, res) => res.sendFile(path.join(config.webDist, 'index.html')));
  }

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    // Another writer held the database for longer than this request waits: it is busy, not
    // broken, and the same request will work again shortly.
    if (err instanceof ReadOnlyError) {
      res.setHeader('Retry-After', '300');
      return void res.status(503).json({ error: err.message });
    }
    if (isDatabaseBusy(err)) {
      res.setHeader('Retry-After', '2');
      return void res.status(503).json({ error: 'The server is busy with another change. Try again in a moment.' });
    }
    const status = err instanceof HttpError ? err.status : ((err as { status?: number }).status ?? 500);
    if (status === 413 && (err as { type?: string }).type === 'entity.too.large') {
      const limit = (err as { limit?: number }).limit;
      return void res.status(413).json({ error: `That's too large to send${limit ? ` (the limit is ${Math.floor(limit / 1024 / 1024)} MB)` : ''}.` });
    }
    if (status >= 500) {
      const privatePath = /(?:\/join\/|\/api\/invites\/)/i.test(req.path);
      const loggedPath = req.path.replace(/(\/(?:join|api\/invites)\/)[^/]+/gi, '$1[redacted]');
      // An exception can contain the request URL too: private paths only log the status.
      console.error(`[${req.method} ${loggedPath}]`, privatePath ? `HTTP ${status}` : err);
    }
    const message = status >= 500 && !(err instanceof HttpError) ? 'Something went wrong on the server' : (err as Error).message;
    if (req.path.startsWith('/auth/') && !req.accepts('json')) return void res.status(status).send(message);
    res.status(status).json({ error: message });
  });
  return app;
}

/**
 * The store gave up waiting for another writer (StoreBusyError, on any store), or SQLite reported
 * "database is locked" (SQLITE_BUSY, 5, or its extended codes) directly.
 */
function isDatabaseBusy(err: unknown): boolean {
  if (err instanceof StoreBusyError) return true;
  const e = err as { code?: string; errcode?: number; message?: string };
  return e?.code === 'ERR_SQLITE_ERROR' && ((e.errcode ?? 0) & 0xff) === 5;
}
