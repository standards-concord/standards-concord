import fs from 'node:fs';
import path from 'node:path';
import cookieParser from 'cookie-parser';
import express, { type NextFunction, type Request, type Response } from 'express';
import { mountAuth, sessionMiddleware } from './auth.js';
import { config } from './config.js';
import { HttpError } from './db.js';
import { mcpHandler } from './mcp.js';
import { oauthRoutes } from './oauth.js';
import { reportRouter } from './public/report.js';
import { publicRouter } from './public/routes.js';
import { validationRouter } from './public/validate.js';
import { apiRouter } from './routes/api.js';
import { solid } from './services/solid.js';
import { getUser } from './services/users.js';

export function createApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');
  // Only believe X-Forwarded-* from a proxy on this machine or its private network (Caddy in the
  // same Docker network in production, Vite in development). TRUST_PROXY overrides it, in Express's syntax.
  app.set('trust proxy', process.env.TRUST_PROXY ?? 'loopback, linklocal, uniquelocal');
  app.use(cookieParser());
  app.use(sessionMiddleware);

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  // Auto-provisioned WebID profiles, used when no Solid server is configured.
  app.get('/people/:id', (req, res) => {
    const user = getUser(String(req.params.id));
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
  app.all('/mcp', express.json({ limit: '5mb' }), mcpHandler);
  app.use('/api', apiRouter());
  // Public, dereferenceable ontology and version IRIs (HTML or RDF by content negotiation),
  // POST to them to validate data against their SHACL shapes, and public problem reports.
  app.use(reportRouter());
  app.use(validationRouter());
  app.use(publicRouter());

  // The built web app, with client-side routing fallback.
  if (fs.existsSync(path.join(config.webDist, 'index.html'))) {
    app.use(express.static(config.webDist, { index: false, maxAge: '1h' }));
    app.get(/^(?!\/(api|auth|mcp|people|def|\.well-known)\b).*/, (_req, res) => res.sendFile(path.join(config.webDist, 'index.html')));
  }

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const status = err instanceof HttpError ? err.status : ((err as { status?: number }).status ?? 500);
    if (status >= 500) console.error(`[${req.method} ${req.path}]`, err);
    const message = status >= 500 && !(err instanceof HttpError) ? 'Something went wrong on the server' : (err as Error).message;
    if (req.path.startsWith('/auth/') && !req.accepts('json')) return void res.status(status).send(message);
    res.status(status).json({ error: message });
  });
  return app;
}
