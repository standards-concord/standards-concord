import { Router, type Request, type Response } from 'express';
import { FORMAT_INFO, serialize } from '@concord/core';
import type { OutputFormat } from '@concord/core/types';
import type { OntologyProject, Release } from '@concord/shared';
import { clock } from '../clock.js';
import { config } from '../config.js';
import { list } from '../db.js';
import { findProject } from '../services/ontologies.js';
import { ontologyStore } from '../services/ontologyStore.js';
import { escapeHtml } from './markdown.js';
import { renderOntologyPage, type OntologyPageInput } from './render.js';
import { publishedRequirements } from './requirements.js';
import { persistentIdRules, PUBLIC_BASE } from './w3id.js';

export { PUBLIC_BASE };

/**
 * Public, dereferenceable ontology pages.
 *
 *   /def/<slug>                 the ontology IRI: the latest release
 *   /def/<slug>/<version>       a version IRI, e.g. /def/volunteering/1.0.0
 *   /def/<slug>/draft           the unreleased working draft
 *   /def/<slug>/<version>.ttl   a specific serialisation (also .jsonld, .owl, .nt, .omn, .linkml.yaml, .shacl.ttl, .html)
 *
 * Browsers get the HTML page; anything asking for RDF gets RDF (Vary: Accept).
 * Persistent IRIs (w3id.org) redirect here, see w3id.ts.
 */

/** Formats offered for download and by content negotiation, in display order. */
const DOWNLOAD_ORDER: OutputFormat[] = ['turtle', 'jsonld', 'rdfxml', 'ntriples', 'manchester', 'linkml', 'shacl'];

/** Media types we answer by content negotiation (SHACL and LinkML are by extension only). */
export const NEGOTIABLE: Record<string, OutputFormat | 'html'> = {
  'text/html': 'html',
  'application/xhtml+xml': 'html',
  'text/turtle': 'turtle',
  'application/x-turtle': 'turtle',
  'application/ld+json': 'jsonld',
  'application/rdf+xml': 'rdfxml',
  'application/owl+xml': 'rdfxml',
  'application/n-triples': 'ntriples',
  'text/owl-manchester': 'manchester',
};

/** File extensions, longest first so ".shacl.ttl" wins over ".ttl". */
const EXTENSIONS: [string, OutputFormat | 'html'][] = [
  ['linkml.yaml', 'linkml'],
  ['shacl.ttl', 'shacl'],
  ['jsonld', 'jsonld'],
  ['html', 'html'],
  ['ttl', 'turtle'],
  ['owl', 'rdfxml'],
  ['rdf', 'rdfxml'],
  ['omn', 'manchester'],
  ['nt', 'ntriples'],
];

export function splitExtension(segment: string): { base: string; format?: OutputFormat | 'html' } {
  for (const [ext, format] of EXTENSIONS) if (segment.endsWith(`.${ext}`) && segment.length > ext.length + 1) return { base: segment.slice(0, -ext.length - 1), format };
  return { base: segment };
}

export const publishedReleases = (ontologyId: string) =>
  list<Release>('releases', ontologyId)
    .filter((r) => r.status === 'published')
    .sort((a, b) => (b.publishedAt ?? b.createdAt).localeCompare(a.publishedAt ?? a.createdAt));

/** The latest released version, if any, that exists in the repository. */
export function latestVersion(project: OntologyProject): string | undefined {
  const versions = ontologyStore.versions(project);
  if (project.currentVersion !== '0.0.0' && versions.includes(project.currentVersion)) return project.currentVersion;
  return publishedReleases(project.id).find((r) => versions.includes(r.version))?.version;
}

/**
 * Everything the page needs for one version. `base` is the absolute site URL
 * (from the request, or PUBLIC_URL for the copy written into a release);
 * `relativeDownloads` links serialisations as sibling files, for that copy.
 */
export async function pageInput(
  project: OntologyProject,
  version: string,
  base: string,
  opts: { relativeDownloads?: boolean; release?: Release; graph?: Awaited<ReturnType<typeof ontologyStore.at>> } = {},
): Promise<OntologyPageInput> {
  const isDraft = version === 'draft';
  const graph = opts.graph ?? (await ontologyStore.at(project, isDraft ? 'working' : version));
  const root = `${base}${PUBLIC_BASE}/${encodeURIComponent(project.slug)}`;
  const releases = publishedReleases(project.id);
  // A release being published now is the newest, though it isn't stored yet.
  if (opts.release && !releases.some((r) => r.version === opts.release!.version)) releases.unshift({ ...opts.release, publishedAt: opts.release.publishedAt ?? clock.iso() });
  const release = opts.release ?? releases.find((r) => r.version === version);
  const latest = opts.release ? opts.release.version : latestVersion(project);
  const downloads = DOWNLOAD_ORDER.map((format) => {
    const info = FORMAT_INFO[format];
    return {
      label: info.label,
      mediaType: info.mediaType,
      extension: info.extension,
      href: opts.relativeDownloads ? `ontology.${info.extension}` : `${root}/${version}.${info.extension}`,
    };
  });
  return {
    project,
    view: graph.view(),
    kind: isDraft ? 'draft' : 'release',
    version,
    release: release && !isDraft ? { level: release.level, notes: release.notes, publishedAt: release.publishedAt, githubUrl: release.githubUrl } : undefined,
    releases: releases.map((r) => ({ version: r.version, level: r.level, publishedAt: r.publishedAt, href: `${root}/${r.version}` })),
    latestVersion: latest,
    downloads,
    pageUrl: `${root}/${version}`,
    links: { latest: root, draft: `${root}/draft`, app: `${base}/o/${encodeURIComponent(project.slug)}`, versionBase: root },
    requirements: publishedRequirements(project, isDraft ? undefined : version),
    persistentId: persistentIdRules(project, base),
    generatedAt: clock.iso(),
  };
}

/**
 * The site's own address. PUBLIC_URL wins when it is set, so a forged
 * X-Forwarded-Host can't change the links on a page; otherwise (local
 * development behind the Vite proxy) it comes from the request.
 */
/** The page written into a release as index.html (downloads link to the files beside it). */
export async function releasePageHtml(project: OntologyProject, release: Release, graph: Awaited<ReturnType<typeof ontologyStore.at>>): Promise<string> {
  return renderOntologyPage(await pageInput(project, release.version, config.publicUrl, { relativeDownloads: true, release, graph }));
}

function origin(req: Request) {
  return process.env.PUBLIC_URL ? config.publicUrl : `${req.protocol}://${req.host}`;
}

function notFound(res: Response, message: string, home?: string) {
  res
    .status(404)
    .type('html')
    .send(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Not found</title><style>body{font:16px/1.6 system-ui,sans-serif;max-width:640px;margin:15vh auto;padding:0 16px;color:#14181f;background:#fff}@media (prefers-color-scheme:dark){body{color:#e7eaf0;background:#0f1218}a{color:#aab6ff}}</style></head><body><h1>Not found</h1><p>${escapeHtml(message)}</p>${home ? `<p><a href="${escapeHtml(home)}">Go to the latest version</a></p>` : ''}</body></html>`,
    );
}

async function serve(req: Request, res: Response) {
  // Public data: any web application may import it, as it can a fork (routes/forkResolver.ts).
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Expose-Headers', 'Link, Content-Type');
  const slugSeg = String(req.params.slug);
  const versionSeg = req.params.version === undefined ? undefined : String(req.params.version);
  // An extension can be on the last segment: /def/x.ttl or /def/x/1.0.0.ttl
  const last = splitExtension(versionSeg ?? slugSeg);
  const slug = versionSeg === undefined ? last.base : slugSeg;
  const requested = versionSeg === undefined ? undefined : last.base;

  const project = findProject(slug);
  if (!project) return notFound(res, `There is no ontology called “${slug}”.`);
  const base = origin(req);
  const root = `${base}${PUBLIC_BASE}/${encodeURIComponent(project.slug)}`;

  let version: string;
  const latest = latestVersion(project);
  if (requested === undefined || requested === 'latest') version = latest ?? 'draft';
  else if (requested === 'draft' || requested === 'working') version = 'draft';
  else if (ontologyStore.versions(project).includes(requested)) version = requested;
  else {
    // Slash namespaces put terms under the ontology IRI (…/volunteering/Volunteer):
    // send those to the term's anchor on the latest page.
    const graph = await ontologyStore.at(project, latest ?? 'working');
    const term = graph.term(`${project.namespace}${requested}`) ?? graph.term(`${project.ontologyIRI.replace(/[#/]$/, '')}/${requested}`);
    if (term && !last.format) return res.redirect(303, `${root}#${encodeURIComponent(requested)}`);
    return notFound(res, `${project.title} has no version “${requested}”.`, root);
  }

  let format = last.format;
  if (!format) {
    const best = req.accepts(Object.keys(NEGOTIABLE));
    if (!best) {
      res.status(406).type('text/plain').send(`Not acceptable. Available: ${Object.keys(NEGOTIABLE).join(', ')}, or add an extension such as .ttl`);
      return;
    }
    format = NEGOTIABLE[best];
  }

  res.vary('Accept');
  res.set('Cache-Control', version === 'draft' ? 'no-cache' : 'public, max-age=300');
  const self = `${root}/${version}`;
  res.set(
    'Link',
    [
      ...DOWNLOAD_ORDER.map((f) => `<${self}.${FORMAT_INFO[f].extension}>; rel="alternate"; type="${FORMAT_INFO[f].mediaType}"`),
      `<${self}>; rel="canonical"`,
    ].join(', '),
  );

  if (format === 'html') {
    const input = await pageInput(project, version, base);
    res.type('html').send(renderOntologyPage(input));
    return;
  }
  const graph = await ontologyStore.at(project, version === 'draft' ? 'working' : version);
  const info = FORMAT_INFO[format];
  res.type(`${info.mediaType}; charset=utf-8`);
  res.set('Content-Disposition', `inline; filename="${project.slug}-${version}.${info.extension}"`);
  res.send(await serialize(graph, format));
}

export function publicRouter(): Router {
  const r = Router();
  r.get(`${PUBLIC_BASE}/:slug{/:version}`, async (req, res, next) => {
    try {
      await serve(req, res);
    } catch (err) {
      next(err);
    }
  });
  return r;
}
