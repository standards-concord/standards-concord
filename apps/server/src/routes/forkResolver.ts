import { FORMAT_INFO, serialize } from '@concord/core';
import type { OutputFormat } from '@concord/core/types';
import { Router, type Request, type Response } from 'express';
import { NEGOTIABLE, splitExtension } from '../public/routes.js';
import { findFork, forkUrls, forkVersion } from '../services/forks.js';
import { findProject } from '../services/ontologies.js';
import { ontologyStore } from '../services/ontologyStore.js';

/**
 * Dereferenceable development forks:
 *
 *   /def/<ontology>/forks/<fork>          content negotiated (Turtle unless the client asks for HTML)
 *   /def/<ontology>/forks/<fork>.ttl      one format by extension (.jsonld, .owl, .nt, .omn, .linkml.yaml, .shacl.ttl)
 *
 * Always the fork's latest revision, so an application that imports it picks
 * up new terms as soon as they are added. Browsers asking for HTML are sent
 * to the fork's page in Concord. Responses allow any origin, so a
 * web application can load the fork straight from the browser.
 */

function plain(res: Response, status: number, message: string) {
  res.status(status).type('text/plain').send(message);
}

async function serve(req: Request, res: Response) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Expose-Headers', 'Link, Content-Type');
  const project = findProject(String(req.params.slug));
  if (!project) return plain(res, 404, `There is no ontology called “${req.params.slug}”.`);
  const seg = splitExtension(String(req.params.fork));
  const fork = findFork(seg.base, project);
  if (!fork || fork.ontologyId !== project.id) return plain(res, 404, `${project.title} has no fork called “${seg.base}”.`);
  const urls = forkUrls(project, fork);

  let format: OutputFormat | 'html' | undefined = seg.format;
  if (!format) {
    // A fork IRI is an import target: HTML (a redirect to the fork's page) only for clients that
    // ask for it, as browsers do; a bare Accept or */* (fetch, curl, RDF libraries) gets Turtle.
    const wantsHtml = /\btext\/html\b/i.test(req.get('accept') ?? '');
    const types = Object.keys(NEGOTIABLE).filter((t) => wantsHtml || NEGOTIABLE[t] !== 'html');
    const best = req.accepts(types);
    if (!best) return plain(res, 406, `Not acceptable. Available: ${types.join(', ')}, or add an extension such as .ttl`);
    format = NEGOTIABLE[best];
    res.vary('Accept');
  }
  res.set(
    'Link',
    [
      ...(Object.keys(urls.formats) as OutputFormat[]).map((f) => `<${urls.formats[f]}>; rel="alternate"; type="${FORMAT_INFO[f].mediaType}"`),
      `<${urls.iri}>; rel="canonical"`,
      `<${urls.app}>; rel="alternate"; type="text/html"`,
    ].join(', '),
  );
  if (format === 'html') return res.redirect(303, urls.app);

  const graph = await ontologyStore.forkGraph(project, fork.slug);
  const info = FORMAT_INFO[format];
  res.set('Cache-Control', 'no-cache');
  res.set('ETag', `"${fork.head}-${format}"`);
  if (req.fresh) return void res.status(304).end();
  res.set('X-Concord-Fork-Version', forkVersion(fork));
  res.type(`${info.mediaType}; charset=utf-8`);
  res.set('Content-Disposition', `inline; filename="${project.slug}-fork-${fork.slug}.${info.extension}"`);
  res.send(await serialize(graph, format));
}

export function forkResolver(): Router {
  const r = Router();
  r.options('/def/:slug/forks/:fork', (_req, res) => {
    res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS', 'Access-Control-Allow-Headers': 'Accept' });
    res.status(204).end();
  });
  r.get('/def/:slug/forks/:fork', async (req, res, next) => {
    try {
      await serve(req, res);
    } catch (err) {
      next(err);
    }
  });
  return r;
}
