import { FORMAT_INFO, serialize } from '@concord/core';
import type { OutputFormat } from '@concord/core/types';
import { Router, type Request, type Response } from 'express';
import { findFork, forkUrls, forkVersion } from '../services/forks.js';
import { findProject } from '../services/ontologies.js';
import { ontologyStore } from '../services/ontologyStore.js';

/**
 * Dereferenceable development forks:
 *
 *   /def/<ontology>/forks/<fork>          content negotiated (Turtle by default)
 *   /def/<ontology>/forks/<fork>.ttl      one format by extension (.jsonld, .owl, .nt, .omn, .linkml.yaml, .shacl.ttl)
 *
 * Always the fork's latest revision, so an application that imports it picks
 * up new terms as soon as they are added. Browsers asking for HTML are sent
 * to the fork's page in Concord. Responses allow any origin, so a
 * web application can load the fork straight from the browser.
 */

/** Media types answered by content negotiation (LinkML and SHACL are by extension only). */
const NEGOTIABLE: Record<string, OutputFormat | 'html'> = {
  'text/turtle': 'turtle',
  'application/x-turtle': 'turtle',
  'application/ld+json': 'jsonld',
  'application/rdf+xml': 'rdfxml',
  'application/owl+xml': 'rdfxml',
  'application/n-triples': 'ntriples',
  'text/owl-manchester': 'manchester',
  'text/html': 'html',
  'application/xhtml+xml': 'html',
};

/** Longest extension first, so ".shacl.ttl" wins over ".ttl". */
const EXTENSIONS = (Object.entries(FORMAT_INFO) as [OutputFormat, (typeof FORMAT_INFO)[OutputFormat]][])
  .map(([format, info]) => [info.extension, format] as const)
  .sort((a, b) => b[0].length - a[0].length);

function splitExtension(segment: string): { base: string; format?: OutputFormat } {
  for (const [ext, format] of EXTENSIONS) if (segment.endsWith(`.${ext}`) && segment.length > ext.length + 1) return { base: segment.slice(0, -ext.length - 1), format };
  return { base: segment };
}

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
    // Turtle first, so clients that send */* (curl, fetch) get RDF rather than a redirect.
    const best = req.accepts(Object.keys(NEGOTIABLE));
    if (!best) return plain(res, 406, `Not acceptable. Available: ${Object.keys(NEGOTIABLE).join(', ')}, or add an extension such as .ttl`);
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
