import type { Request, Router } from 'express';
import { FORMAT_INFO } from '@concord/core';
import type { OutputFormat } from '@concord/core/types';
import { requireUser } from '../auth.js';
import { HttpError } from '../db.js';
import * as apps from '../services/appChecks.js';
import { getCR } from '../services/changeRequests.js';
import { mustFindProject } from '../services/ontologies.js';

const FORMATS = Object.keys(FORMAT_INFO) as OutputFormat[];

/**
 * Connected apps: people register an application, its CI tests it against every
 * proposed change (actions/app-check), and autopilot can approve or vote for them.
 */
export function mountAppChecks(r: Router) {
  r.get('/ontologies/:id/apps', async (req, res) => {
    requireUser(req);
    res.json(await apps.listApps((await mustFindProject(String(req.params.id))).id));
  });
  r.post('/ontologies/:id/apps', async (req, res) => {
    const b = req.body ?? {};
    res.status(201).json(await apps.createApp(await mustFindProject(String(req.params.id)), requireUser(req), { name: b.name, repo: b.repo, autopilot: b.autopilot }));
  });
  r.patch('/apps/:id', async (req, res) => {
    const b = req.body ?? {};
    res.json(await apps.updateApp(String(req.params.id), requireUser(req), { name: b.name, repo: b.repo, autopilot: b.autopilot }));
  });
  r.post('/apps/:id/token', async (req, res) => res.json(await apps.rotateToken(String(req.params.id), requireUser(req))));
  r.delete('/apps/:id', async (req, res) => {
    await apps.deleteApp(String(req.params.id), requireUser(req));
    res.status(204).end();
  });

  // The ontology as it would be with this change merged. For signed-in people, like the change
  // request itself, and for the CI of an app connected to that ontology (with its app token).
  r.get('/change-requests/:id/proposed', async (req, res) => {
    const format = (FORMATS.includes(req.query.format as OutputFormat) ? req.query.format : 'turtle') as OutputFormat;
    const cr = await getCR(String(req.params.id));
    // An app's CI gets what a member of the ontology sees of a change it is asked to test (the
    // change's edits, plus the provenance the merge adds: author's name, date, change number),
    // and only while that change is open for checks: never drafts, rejected or withdrawn changes.
    if (!req.user) {
      const app = await apps.appForToken(req.get('authorization'));
      if (app.ontologyId !== cr.ontologyId || !apps.openForChecks(cr)) throw new HttpError(404, 'No such change request open for app checks');
    }
    const { text, revision, filename } = await apps.proposedSource(cr, format);
    res.set('X-Concord-Revision', revision);
    res.type(`${FORMAT_INFO[format].mediaType}; charset=utf-8`);
    if (req.query.download) res.attachment(filename);
    res.send(text);
  });

  // For an app's CI, authenticated with the app's token; or for the app's owner, signed in
  // (their own runs, or a simulated one), naming the app.
  const caller = async (req: Request, appId: unknown) => {
    if (req.get('authorization') || !req.user) {
      const app = await apps.appForToken(req.get('authorization'));
      return { app, by: apps.byToken(app) };
    }
    return { app: await apps.appForOwner(appId, req.user), by: { trusted: true, ownerId: req.user.id } };
  };
  r.get('/app-checks/pending', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const { app, by } = await caller(req, req.query.appId);
    res.json(await apps.pending(app, req.query.all === '1' || req.query.all === 'true', req.query.commit, by));
  });
  r.post('/app-checks', async (req, res) => {
    const { app, by } = await caller(req, req.body?.appId);
    res.json(await apps.report(app, req.body ?? {}, by));
  });
}
