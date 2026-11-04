import fs from 'node:fs';
import path from 'node:path';
import cookieParser from 'cookie-parser';
import express, { type NextFunction, type Request, type Response } from 'express';
import { mountAuth, sessionMiddleware } from './auth.js';
import { config } from './config.js';
import { HttpError } from './db.js';
import { mcpHandler } from './mcp.js';
import { publicRouter } from './public/routes.js';
import { apiRouter } from './routes/api.js';
import { forkResolver } from './routes/forkResolver.js';
import { solid } from './services/solid.js';
import { getUser } from './services/users.js';

export function createApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use(cookieParser());
  app.use(sessionMiddleware);

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  // Auto-provisioned WebID profiles, used when no Solid server is configured.
  app.get('/people/:id', (req, res) => {
    const user = getUser(String(req.params.id));
    if (!user) throw new HttpError(404, 'No such person');
    res.type('text/turtle').send(solid.profileDocument(user));
  });

  const auth = express.Router();
  mountAuth(auth);
  app.use(auth);

  app.all('/mcp', express.json({ limit: '5mb' }), mcpHandler);
  app.use('/api', apiRouter());
  // Development forks, dereferenceable so applications can import them (/def/<ontology>/forks/<fork>).
  app.use(forkResolver());
  // Public, dereferenceable ontology and version IRIs (HTML or RDF by content negotiation).
  app.use(publicRouter());

  // The built web app, with client-side routing fallback.
  if (fs.existsSync(path.join(config.webDist, 'index.html'))) {
    app.use(express.static(config.webDist, { index: false, maxAge: '1h' }));
    app.get(/^(?!\/(api|auth|mcp|people|def)\b).*/, (_req, res) => res.sendFile(path.join(config.webDist, 'index.html')));
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
