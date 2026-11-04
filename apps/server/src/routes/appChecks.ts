import type { Router } from 'express';
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
  r.get('/ontologies/:id/apps', (req, res) => {
    requireUser(req);
    res.json(apps.listApps(mustFindProject(String(req.params.id)).id));
  });
  r.post('/ontologies/:id/apps', async (req, res) => {
    const b = req.body ?? {};
    res.status(201).json(await apps.createApp(mustFindProject(String(req.params.id)), requireUser(req), { name: b.name, repo: b.repo, autopilot: b.autopilot }));
  });
  r.patch('/apps/:id', async (req, res) => {
    const b = req.body ?? {};
    res.json(await apps.updateApp(String(req.params.id), requireUser(req), { name: b.name, repo: b.repo, autopilot: b.autopilot }));
  });
  r.post('/apps/:id/token', (req, res) => res.json(apps.rotateToken(String(req.params.id), requireUser(req))));
  r.delete('/apps/:id', async (req, res) => {
    await apps.deleteApp(String(req.params.id), requireUser(req));
    res.status(204).end();
  });

  // The ontology as it would be with this change merged. For signed-in people, like the change
  // request itself, and for the CI of an app connected to that ontology (with its app token).
  r.get('/change-requests/:id/proposed', async (req, res) => {
    const format = (FORMATS.includes(req.query.format as OutputFormat) ? req.query.format : 'turtle') as OutputFormat;
    const cr = getCR(String(req.params.id));
    if (!req.user && apps.appForToken(req.get('authorization')).ontologyId !== cr.ontologyId) throw new HttpError(404, 'No such change request');
    const { text, revision, filename } = await apps.proposedSource(cr, format);
    res.set('X-Concord-Revision', revision);
    res.type(`${FORMAT_INFO[format].mediaType}; charset=utf-8`);
    if (req.query.download) res.attachment(filename);
    res.send(text);
  });

  // For an app's CI, authenticated with the app's token.
  r.get('/app-checks/pending', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(apps.pending(apps.appForToken(req.get('authorization')), req.query.all === '1' || req.query.all === 'true', req.query.commit));
  });
  r.post('/app-checks', async (req, res) => {
    const app = apps.appForToken(req.get('authorization'));
    res.json(await apps.report(app, req.body ?? {}));
  });
}
