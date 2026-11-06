import express, { type Express, type Router } from 'express';
import { requireUser } from '../auth.js';
import { HttpError } from '../db.js';
import { exchangeRunProof } from '../services/appChecks.js';
import { finishInstall, githubAppStatus, onWebhook, openWorkflowPr, runNow, startInstall, unlinkGithub } from '../services/appGithub.js';
import { mustSettings, signedByGithub } from '../services/githubApp.js';

/**
 * The Concord GitHub App's webhook. Mounted ahead of the API's JSON parser, because the signature
 * is over the exact bytes GitHub sent.
 */
export function mountGithubAppWebhook(app: Express) {
  app.post('/api/github-app/webhook', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
    const s = mustSettings();
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!signedByGithub(s, body, req.get('x-hub-signature-256'))) throw new HttpError(401, 'Bad or missing signature');
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
    } catch {
      throw new HttpError(400, 'The delivery isn’t JSON');
    }
    const out = await onWebhook(String(req.get('x-github-event') ?? ''), payload);
    res.set('Cache-Control', 'no-store').json(out);
  });
}

/** Connecting an app through the GitHub App, and a GitHub-connected run signing in. */
export function mountGithubApp(r: Router) {
  r.get('/github-app', (_req, res) => res.json(githubAppStatus()));
  r.post('/apps/:id/github/install', async (req, res) => res.json(await startInstall(String(req.params.id), requireUser(req))));
  // GitHub sends the installer back here, in their browser, signed in to Concord (or not).
  r.get('/github-app/setup', async (req, res) => res.redirect(303, await finishInstall(req.query as Record<string, unknown>, req.user)));
  r.delete('/apps/:id/github', async (req, res) => res.json(await unlinkGithub(String(req.params.id), requireUser(req))));
  r.post('/apps/:id/github/run', async (req, res) => res.json(await runNow(String(req.params.id), requireUser(req))));
  r.post('/apps/:id/github/workflow-pr', async (req, res) => res.json(await openWorkflowPr(String(req.params.id), requireUser(req))));
  // A run of an app connected through GitHub trades GitHub's proof for a run token.
  r.post('/app-checks/session', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await exchangeRunProof(req.body?.app, req.body?.oidc));
  });
}
