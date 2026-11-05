import { Router, type Request, type Response } from 'express';
import { NEGOTIABLE, sendFormat, splitExtension, type PublicFormat } from '../public/routes.js';
import { findFork, forkUrls, forkVersion } from '../services/forks.js';
import { findProject } from '../services/ontologies.js';
import { ontologyStore } from '../services/ontologyStore.js';

/**
 * Dereferenceable development forks:
 *
 *   /def/<ontology>/forks/<fork>          content negotiated (Turtle unless the client asks for HTML)
 *   /def/<ontology>/forks/<fork>.ttl      one format by extension: every format a release offers (.jsonld, .owl,
 *                                         .nt, .omn, .linkml.yaml, .shacl.ttl, .shaclc, .js, .ts, .d.ts, .tgz)
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
  const project = await findProject(String(req.params.slug));
  if (!project) return plain(res, 404, `There is no ontology called “${req.params.slug}”.`);
  const seg = splitExtension(String(req.params.fork));
  const fork = await findFork(seg.base, project);
  if (!fork || fork.ontologyId !== project.id) return plain(res, 404, `${project.title} has no fork called “${seg.base}”.`);
  const urls = forkUrls(project, fork);

  let format: PublicFormat | undefined = seg.format;
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
  if (format === 'html') {
    res.set('Link', `<${urls.iri}>; rel="canonical", <${urls.app}>; rel="alternate"; type="text/html"`);
    return res.redirect(303, urls.app);
  }

  res.set('ETag', `"${fork.head}-${format}${req.query.deps === 'bare' ? '-bare' : ''}${req.query.syntax === 'extended' ? '-ext' : ''}"`);
  res.set('Cache-Control', 'no-cache');
  if (req.fresh) return void res.status(304).end();
  res.set('X-Concord-Fork-Version', forkVersion(fork));
  // The same formats, headers and file names as a release (public/routes.ts).
  await sendFormat(req, res, {
    project,
    graph: await ontologyStore.forkGraph(project, fork.slug),
    format,
    version: `fork-${fork.slug}`,
    self: urls.iri,
    mutable: true,
    packageVersion: forkVersion(fork),
  });
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
