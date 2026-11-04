import fs from 'node:fs';
import path from 'node:path';
import { Router, type Request, type Response } from 'express';
import { bumpVersion, FORMAT_INFO, npmPackage, serialize, toShacl, toShaclc, toWrapperClasses, withWrapperImport, WRAPPER_CDN } from '@concord/core';
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
 *   /def/<slug>/<version>.ttl   a specific serialisation (also .jsonld, .owl, .nt, .omn, .linkml.yaml, .shacl.ttl, .shaclc, .html)
 *   /def/<slug>/<version>.js    JavaScript classes for every SHACL node shape (@rdfjs/wrapper), to import from a browser
 *                               (?deps=bare imports "@rdfjs/wrapper" by name instead of from a CDN); also .ts and .d.ts
 *   /def/<slug>/<version>.tgz   the same classes as an npm package: npm install <this URL>
 *   /def/<slug>/<version>.shaclc  standard SHACL compact syntax (?syntax=extended keeps shape names)
 *
 * Browsers get the HTML page; anything asking for RDF (or JavaScript, or
 * SHACLC) gets that (Vary: Accept). Responses allow any origin, so an app on
 * another site can fetch the ontology or import its classes.
 * Persistent IRIs (w3id.org) redirect here, see w3id.ts.
 */

/** Formats offered for download and by content negotiation, in display order. */
const DOWNLOAD_ORDER: OutputFormat[] = ['turtle', 'jsonld', 'rdfxml', 'ntriples', 'manchester', 'linkml', 'shacl', 'shaclc', 'javascript', 'typescript'];

/** What a /def URL can return: a serialisation, the HTML page, type declarations or an npm package. */
export type PublicFormat = OutputFormat | 'html' | 'dts' | 'npm';

const EXTRA_INFO: Record<'dts' | 'npm', { label: string; mediaType: string; extension: string }> = {
  dts: { label: 'TypeScript declarations', mediaType: 'application/typescript', extension: 'd.ts' },
  npm: { label: 'npm package', mediaType: 'application/gzip', extension: 'tgz' },
};

/**
 * Media types answered by content negotiation: exactly the types we produce and
 * send back, with no aliases (SHACL, LinkML, the declarations and the npm
 * package are by extension only). HTML is first, so a bare Accept or *\/* gets
 * the page.
 */
export const NEGOTIABLE: Record<string, PublicFormat> = {
  'text/html': 'html',
  'text/turtle': 'turtle',
  'application/ld+json': 'jsonld',
  'application/rdf+xml': 'rdfxml',
  'application/n-triples': 'ntriples',
  'text/owl-manchester': 'manchester',
  'text/shaclc': 'shaclc',
  'text/javascript': 'javascript',
  'application/typescript': 'typescript',
};

/** File extensions, longest first so ".shacl.ttl" wins over ".ttl". */
const EXTENSIONS: [string, PublicFormat][] = [
  ['linkml.yaml', 'linkml'],
  ['shacl.ttl', 'shacl'],
  ['shaclc', 'shaclc'],
  ['d.ts', 'dts'],
  ['ts', 'typescript'],
  ['mjs', 'javascript'],
  ['js', 'javascript'],
  ['tgz', 'npm'],
  ['jsonld', 'jsonld'],
  ['html', 'html'],
  ['ttl', 'turtle'],
  ['owl', 'rdfxml'],
  ['rdf', 'rdfxml'],
  ['omn', 'manchester'],
  ['nt', 'ntriples'],
];

export function splitExtension(segment: string): { base: string; format?: PublicFormat } {
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
  const mod = await toWrapperClasses(graph, { name: project.slug });
  const withGetter = mod.classes.filter((c) => c.datasetGetter);
  const example = withGetter.find((c) => c.properties.length > 1 && !c.extends) ?? withGetter[0];
  return {
    project,
    code: {
      moduleUrl: `${root}/${version}.js`,
      packageUrl: `${root}/${version}.tgz`,
      packageName: `${project.slug}-ontology`,
      datasetClass: mod.datasetClass,
      exampleClass: example?.name,
      exampleGetter: example?.datasetGetter,
      exampleProperty: example?.properties[0]?.name,
    },
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
    const anchor = term && termAnchors(graph.view(), project.namespace).get(term.iri);
    if (anchor && !last.format) return res.redirect(303, `${root}#${fragment(anchor)}`);
    return notFound(res, `${project.title} has no version “${requested}”.`, root);
  }

  const format = last.format ?? negotiate(req, res);
  if (!format) return;
  if (format === 'html') {
    publicHeaders(res, `${root}/${version}`, version === 'draft');
    const input = await pageInput(project, version, base);
    res.type('html').send(renderOntologyPage(input));
    return;
  }
  const graph = await ontologyStore.at(project, version === 'draft' ? 'working' : version);
  await sendFormat(req, res, {
    project,
    graph,
    format,
    version,
    self: `${root}/${version}`,
    mutable: version === 'draft',
    // The draft is ahead of the latest release: 1.0.0 → 1.1.0-draft.
    packageVersion: version === 'draft' ? `${latest ? bumpVersion(latest, 'minor') : '0.1.0'}-draft` : version,
  });
}

/** The format an Accept header asks for, or undefined after answering 406. */
export function negotiate(req: Request, res: Response): PublicFormat | undefined {
  // The answer depends on Accept, including when it is a refusal.
  res.vary('Accept');
  const best = req.accepts(Object.keys(NEGOTIABLE));
  if (!best) {
    res
      .status(406)
      .set('Cache-Control', 'no-store')
      .type('text/plain')
      .send(`Not acceptable. Available: ${Object.keys(NEGOTIABLE).join(', ')}, or add an extension such as .ttl or .js`);
    return undefined;
  }
  return NEGOTIABLE[best];
}

function publicHeaders(res: Response, self: string, mutable: boolean) {
  res.vary('Accept');
  // Public data: any site may fetch it, or import the generated classes from it.
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Expose-Headers', 'Link, Content-Disposition');
  res.set('Cache-Control', mutable ? 'no-cache' : 'public, max-age=300');
  res.set(
    'Link',
    [
      `<${self}.html>; rel="alternate"; type="text/html"`,
      ...DOWNLOAD_ORDER.map((f) => `<${self}.${FORMAT_INFO[f].extension}>; rel="alternate"; type="${FORMAT_INFO[f].mediaType}"`),
      `<${self}>; rel="canonical"`,
    ].join(', '),
  );
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export interface SendFormatOptions {
  project: OntologyProject;
  graph: Awaited<ReturnType<typeof ontologyStore.at>>;
  format: Exclude<PublicFormat, 'html'>;
  /** '1.0.0', 'draft' or e.g. 'forks/activity-tracking': used in file names. */
  version: string;
  /** The canonical URL of this version, without an extension. */
  self: string;
  /** Drafts and forks change, so they aren't cached. */
  mutable: boolean;
  /** Semver version for the npm package (falls back to owl:versionInfo, then 0.0.0). */
  packageVersion?: string;
}

/**
 * Sends one version of an ontology in any non-HTML format: an RDF
 * serialisation, SHACLC, the generated JavaScript or TypeScript classes, their
 * declarations, or an npm package of them. Shared by every /def route (releases,
 * the draft and forks) so each offers the same formats.
 */
export async function sendFormat(req: Request, res: Response, o: SendFormatOptions): Promise<void> {
  publicHeaders(res, o.self, o.mutable);
  const fileBase = `${o.project.slug}-${o.version.replace(/[^A-Za-z0-9._-]+/g, '-')}`;
  if (o.format === 'javascript' || o.format === 'typescript' || o.format === 'dts' || o.format === 'npm') {
    const mod = await toWrapperClasses(o.graph, { name: o.project.slug, sourceUrl: o.self });
    if (o.format === 'npm') {
      const info = o.graph.view().metadata.versionInfo;
      const version = [o.packageVersion, info].find((v) => v && SEMVER.test(v)) ?? '0.0.0';
      const tgz = npmPackage(mod, {
        name: `${o.project.slug}-ontology`,
        version,
        description: `Classes for ${o.project.title}, generated from its SHACL shapes`,
        homepage: o.self,
        shapes: await toShacl(o.graph),
      });
      res.type(EXTRA_INFO.npm.mediaType);
      res.set('Content-Disposition', `attachment; filename="${fileBase}.tgz"`);
      res.send(tgz);
      return;
    }
    const text =
      o.format === 'typescript' ? mod.ts : o.format === 'dts' ? mod.dts : req.query.deps === 'bare' ? mod.js : withWrapperImport(mod.js, WRAPPER_CDN);
    const info = o.format === 'dts' ? EXTRA_INFO.dts : FORMAT_INFO[o.format];
    res.type(`${info.mediaType}; charset=utf-8`);
    // Deno and other URL importers find the declarations here.
    if (o.format === 'javascript') res.set('X-TypeScript-Types', `${o.self}.d.ts`);
    res.set('Content-Disposition', `inline; filename="${fileBase}.${info.extension}"`);
    res.send(text);
    return;
  }
  const info = FORMAT_INFO[o.format];
  // ?syntax=extended keeps shape names and labels, in shaclc-write's extended SHACLC.
  const text = o.format === 'shaclc' && req.query.syntax === 'extended' ? await toShaclc(o.graph, { extended: true }) : await serialize(o.graph, o.format, { name: o.project.slug });
  res.type(`${info.mediaType}; charset=utf-8`);
  res.set('Content-Disposition', `inline; filename="${fileBase}.${info.extension}"`);
  res.send(text);
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
