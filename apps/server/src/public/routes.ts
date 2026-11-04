import fs from 'node:fs';
import path from 'node:path';
import { Router, type Request, type Response } from 'express';
import { DATA_MEDIA_TYPES, FORMAT_INFO, serialize } from '@concord/core';
import type { OutputFormat } from '@concord/core/types';
import type { OntologyProject, Release } from '@concord/shared';
import { clock } from '../clock.js';
import { config } from '../config.js';
import { list } from '../db.js';
import { findProject } from '../services/ontologies.js';
import { ontologyStore } from '../services/ontologyStore.js';
import { escapeHtml } from './markdown.js';
import { PAGE_GENERATOR, renderOntologyPage, type OntologyPageInput } from './render.js';
import { publishedRequirements, requirementsFor, type PublishedRequirements } from './requirements.js';
import { fragment, termAnchors } from './anchors.js';
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
 * Asking for the SHACL profile (Accept-Profile: <http://www.w3.org/ns/shacl#>,
 * text/turtle;profile="http://www.w3.org/ns/shacl#", or ?_profile=shacl) gets
 * the SHACL shapes. POST validates data against them: see validate.ts.
 * Persistent IRIs (w3id.org) redirect here, see w3id.ts.
 */

/** Formats offered for download and by content negotiation, in display order. */
const DOWNLOAD_ORDER: OutputFormat[] = ['turtle', 'jsonld', 'rdfxml', 'ntriples', 'manchester', 'linkml', 'shacl'];

/**
 * Media types answered by content negotiation: exactly the types we produce and
 * send back, with no aliases (SHACL and LinkML are by extension only). HTML is
 * first, so a bare Accept or *\/* gets the page.
 */
const NEGOTIABLE: Record<string, OutputFormat | 'html'> = {
  'text/html': 'html',
  'text/turtle': 'turtle',
  'application/ld+json': 'jsonld',
  'application/rdf+xml': 'rdfxml',
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

export const SHACL_PROFILE = 'http://www.w3.org/ns/shacl#';
const SHACL_PROFILE_RE = /^<?http:\/\/www\.w3\.org\/ns\/shacl#?>?$/;

/**
 * Whether the request asks for the SHACL profile of the ontology (W3C Content
 * Negotiation by Profile): an Accept-Profile header, a profile parameter on an
 * Accept media type, or the _profile query parameter. q=0 means "not this".
 */
export function wantsShaclProfile(req: Request): boolean {
  const named = (token: string) => SHACL_PROFILE_RE.test(token.trim()) || token.trim().toLowerCase() === 'shacl';
  const query = req.query._profile;
  if (typeof query === 'string' && query.split(',').some(named)) return true;
  const listed = (header: string | undefined, pick: (part: string) => string | undefined) =>
    (header ?? '').split(',').some((part) => {
      const token = pick(part);
      return token !== undefined && named(token) && !/;\s*q\s*=\s*0(\.0*)?\s*(;|$)/i.test(part);
    });
  if (listed(req.get('Accept-Profile'), (part) => part.split(';')[0])) return true;
  return listed(req.get('Accept'), (part) => /;\s*profile\s*=\s*"?([^";,]+)"?/i.exec(part)?.[1]);
}

/**
 * Whether Accept allows a representation: a media type with parameters, such
 * as text/turtle with profile="http://www.w3.org/ns/shacl#". A range matches
 * when its type matches and each of its parameters (other than q) equals the
 * representation's; profile values match by IRI, with or without <>. The most
 * specific matching range decides (RFC 9110 12.5.1): a range with parameters
 * beats the bare type, which beats type/*, which beats *\/*. So
 * "text/turtle;q=0, *\/*" refuses Turtle, and
 * 'text/turtle;profile="…shacl#";q=0, text/turtle' refuses the SHACL profile.
 */
export function acceptsRepresentation(header: string | undefined, type: string, params: Record<string, string> = {}): boolean {
  return acceptMatch(header, type, params).q > 0;
}

/**
 * How Accept rates a representation: the quality of the most specific range
 * that matches it, and where that range is in the header (for ties). No
 * header accepts everything at q=1.
 */
export function acceptMatch(header: string | undefined, type: string, params: Record<string, string> = {}): { q: number; position: number } {
  if (!header?.trim()) return { q: 1, position: 0 };
  const want = type.toLowerCase();
  const [major] = want.split('/');
  const norm = (k: string, v: string) => (k === 'profile' ? v.replace(/^<|>$/g, '') : v.toLowerCase());
  let best: { specificity: number; q: number; position: number } | undefined;
  header.split(',').forEach((part, position) => {
    const [rangeRaw, ...paramParts] = part.split(';');
    const range = rangeRaw.trim().toLowerCase();
    let q = 1;
    const rangeParams: [string, string][] = [];
    for (const p of paramParts) {
      const eq = p.indexOf('=');
      if (eq < 0) continue;
      const key = p.slice(0, eq).trim().toLowerCase();
      const value = p.slice(eq + 1).trim().replace(/^"|"$/g, '');
      if (key === 'q') q = Number(value);
      else rangeParams.push([key, value]);
    }
    let specificity = range === want ? 3 : range === `${major}/*` ? 2 : range === '*/*' ? 1 : 0;
    if (!specificity) return;
    if (rangeParams.length) {
      const matches = rangeParams.every(([k, v]) => params[k] !== undefined && norm(k, params[k]) === norm(k, v));
      if (!matches) return;
      specificity += 3 + rangeParams.length;
    }
    if (!Number.isFinite(q)) q = 0;
    if (!best || specificity > best.specificity || (specificity === best.specificity && q > best.q)) best = { specificity, q, position };
  });
  return best ? { q: best.q, position: best.position } : { q: 0, position: Infinity };
}

function splitExtension(segment: string): { base: string; format?: OutputFormat | 'html' } {
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
  opts: { relativeDownloads?: boolean; release?: Release; graph?: Awaited<ReturnType<typeof ontologyStore.at>>; requirements?: PublishedRequirements } = {},
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
    requirements: isDraft ? publishedRequirements(project) : requirementsFor(opts.requirements ?? requirementsSnapshot(project, version)),
    persistentId: persistentIdRules(project, base),
    generatedAt: clock.iso(),
  };
}

export const REQUIREMENTS_SNAPSHOT = 'requirements.json';

/** The public use cases and requirements stored with a release, if it has a readable copy. */
function requirementsSnapshot(project: OntologyProject, version: string): PublishedRequirements | undefined {
  const file = path.join(ontologyStore.dir(project), 'releases', version, REQUIREMENTS_SNAPSHOT);
  try {
    return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as PublishedRequirements) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Files that publish a release's public page: index.html (downloads link to
 * the files beside it) and a snapshot of its public use cases and
 * requirements, so later edits never rewrite the published version.
 */
export async function releasePageFiles(
  project: OntologyProject,
  release: Release,
  graph: Awaited<ReturnType<typeof ontologyStore.at>>,
  requirements: PublishedRequirements = releaseRequirements(project, release.version),
): Promise<Record<string, string>> {
  const html = renderOntologyPage(await pageInput(project, release.version, config.publicUrl, { relativeDownloads: true, release, graph, requirements }));
  return { 'index.html': html, [REQUIREMENTS_SNAPSHOT]: snapshotFile(requirements) };
}

/** The public use cases and requirements to freeze into a release published now. */
export const releaseRequirements = (project: OntologyProject, version: string) => publishedRequirements(project, version);
export const snapshotFile = (requirements: PublishedRequirements) => `${JSON.stringify(requirements, null, 2)}\n`;

/**
 * Brings every published release's stored page up to date with the current
 * renderer, once per renderer version (PAGE_VERSION). Security and privacy
 * fixes to the page then reach copies written before them, and releases from
 * before snapshots existed get one, so their pages stop following live data.
 * An existing readable snapshot is kept as it is. Changes are committed to the
 * ontology's repository, so they go out with its next push to GitHub.
 */
export async function refreshReleasePages(): Promise<void> {
  for (const project of list<OntologyProject>('ontologies')) {
    try {
      const versions = new Set(ontologyStore.versions(project));
      const changed: Record<string, Record<string, string>> = {};
      for (const release of publishedReleases(project.id).filter((r) => versions.has(r.version))) {
        const dir = path.join(ontologyStore.dir(project), 'releases', release.version);
        const page = path.join(dir, 'index.html');
        const current = fs.existsSync(page) && fs.readFileSync(page, 'utf8').includes(PAGE_GENERATOR);
        const snapshot = requirementsSnapshot(project, release.version);
        if (current && snapshot) continue;
        const requirements = snapshot && Array.isArray(snapshot.useCases) ? snapshot : releaseRequirements(project, release.version);
        const files = await releasePageFiles(project, release, await ontologyStore.at(project, release.version), requirements);
        // Never rewrite a readable snapshot, only the page rendered from it.
        if (snapshot) delete files[REQUIREMENTS_SNAPSHOT];
        changed[release.version] = files;
      }
      if (Object.keys(changed).length) {
        ontologyStore.updateReleaseFiles(project, changed, `Regenerate public pages (${Object.keys(changed).join(', ')}) with ${PAGE_GENERATOR}`);
        console.log(`[public] refreshed ${project.slug} release pages: ${Object.keys(changed).join(', ')}`);
      }
    } catch (err) {
      console.warn(`[public] could not refresh ${project.slug} release pages: ${(err as Error).message}`);
    }
  }
}

/**
 * The site's own address. PUBLIC_URL wins when it is set, so a forged
 * X-Forwarded-Host can't change the links on a page; otherwise (local
 * development behind the Vite proxy) it comes from the request.
 */
function origin(req: Request) {
  return process.env.PUBLIC_URL ? config.publicUrl : `${req.protocol}://${req.host}`;
}

function notFound(res: Response, message: string, home?: string) {
  res
    .status(404)
    .set('Cache-Control', 'no-store')
    .type('html')
    .send(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Not found</title><style>body{font:16px/1.6 system-ui,sans-serif;max-width:640px;margin:15vh auto;padding:0 16px;color:#14181f;background:#fff}@media (prefers-color-scheme:dark){body{color:#e7eaf0;background:#0f1218}a{color:#aab6ff}}</style></head><body><h1>Not found</h1><p>${escapeHtml(message)}</p>${home ? `<p><a href="${escapeHtml(home)}">Go to the latest version</a></p>` : ''}</body></html>`,
    );
}

async function serve(req: Request, res: Response) {
  const slugSeg = String(req.params.slug);
  const versionSeg = req.params.version === undefined ? undefined : String(req.params.version);
  // An extension can be on the last segment: /def/x.ttl or /def/x/1.0.0.ttl
  const last = splitExtension(versionSeg ?? slugSeg);
  const slug = versionSeg === undefined ? last.base : slugSeg;
  const requested = versionSeg === undefined ? undefined : last.base;
  // Public data: any site may read it (no credentials), including the headers that describe it.
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Expose-Headers', 'Link, Content-Profile, Content-Disposition, Accept-Post');

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
    const anchor = term && termAnchors(graph.view(), project.namespace).get(term.iri);
    if (anchor && !last.format) return res.redirect(303, `${root}#${fragment(anchor)}`);
    return notFound(res, `${project.title} has no version “${requested}”.`, root);
  }

  let format = last.format;
  let profiled = false;
  // Data can be POSTed here to validate it (validate.ts).
  res.set('Accept-Post', DATA_MEDIA_TYPES.join(', '));
  if (!format && wantsShaclProfile(req)) {
    res.vary('Accept');
    res.vary('Accept-Profile');
    if (!acceptsRepresentation(req.get('Accept'), 'text/turtle', { profile: SHACL_PROFILE, charset: 'utf-8' })) {
      res.status(406).set('Cache-Control', 'no-store').type('text/plain').send('The SHACL profile is available as text/turtle.');
      return;
    }
    res.set('Content-Profile', `<${SHACL_PROFILE}>`);
    profiled = true;
    format = 'shacl';
  }
  if (!format) {
    // The answer depends on Accept, including when it is a refusal.
    res.vary('Accept');
    res.vary('Accept-Profile');
    const best = req.accepts(Object.keys(NEGOTIABLE));
    if (!best) {
      res
        .status(406)
        .set('Cache-Control', 'no-store')
        .type('text/plain')
        .send(`Not acceptable. Available: ${Object.keys(NEGOTIABLE).join(', ')}, or add an extension such as .ttl`);
      return;
    }
    format = NEGOTIABLE[best];
  }

  res.set('Cache-Control', version === 'draft' ? 'no-cache' : 'public, max-age=300');
  const self = `${root}/${version}`;
  res.set(
    'Link',
    [
      `<${self}.html>; rel="alternate"; type="text/html"`,
      ...DOWNLOAD_ORDER.map((f) => `<${self}.${FORMAT_INFO[f].extension}>; rel="alternate"; type="${FORMAT_INFO[f].mediaType}"${f === 'shacl' ? `; profile="${SHACL_PROFILE}"` : ''}`),
      `<${self}>; rel="canonical"`,
      // Content Negotiation by Profile: name the profile this response conforms to.
      ...(profiled ? [`<${SHACL_PROFILE}>; rel="profile"`] : []),
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
