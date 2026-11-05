import fs from 'node:fs';
import path from 'node:path';
import { Router, type Request, type Response } from 'express';
import { bumpVersion, FORMAT_INFO, npmPackage, serialize, toShacl, toShaclc, toWrapperClasses, withWrapperImport, WRAPPER_CDN, type OntologyGraph } from '@concord/core';
import type { OutputFormat } from '@concord/core/types';
import type { OntologyProject, Release } from '@concord/shared';
import { clock } from '../clock.js';
import { config } from '../config.js';
import { list } from '../db.js';
import { findProject } from '../services/ontologies.js';
import { ontologyStore } from '../services/ontologyStore.js';
import { releaseForViewer } from '../services/releases.js';
import { holdLegacy, isHeld, readOntology } from './holds.js';
import { publishedReleases } from './published.js';
import { escapeHtml } from './markdown.js';
import { PAGE_GENERATOR, renderOntologyPage, type OntologyPageInput } from './render.js';
import { publishedRequirements, requirementsFor, validSnapshot, type PublishedRequirements } from './requirements.js';
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
const NEGOTIABLE: Record<string, PublicFormat> = {
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

function splitExtension(segment: string): { base: string; format?: PublicFormat } {
  for (const [ext, format] of EXTENSIONS) if (segment.endsWith(`.${ext}`) && segment.length > ext.length + 1) return { base: segment.slice(0, -ext.length - 1), format };
  return { base: segment };
}

export { publishedReleases } from './published.js';

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
    release: release && !isDraft ? { level: release.level, notes: releaseForViewer(release, undefined).notes, publishedAt: release.publishedAt, githubUrl: release.githubUrl } : undefined,
    releases: releases.map((r) => ({ version: r.version, level: r.level, publishedAt: r.publishedAt, href: `${root}/${r.version}` })),
    latestVersion: latest,
    downloads,
    pageUrl: `${root}/${version}`,
    links: { latest: root, draft: `${root}/draft`, app: `${base}/o/${encodeURIComponent(project.slug)}`, versionBase: root, report: `${root}/-/report`, site: base },
    requirements: isDraft ? publishedRequirements(project) : requirementsFor(project, opts.requirements ?? requirementsSnapshot(project, version)),
    persistentId: persistentIdRules(project, base),
    generatedAt: clock.iso(),
  };
}

export const REQUIREMENTS_SNAPSHOT = 'requirements.json';

type SnapshotRead = { state: 'ok'; data: PublishedRequirements } | { state: 'absent' } | { state: 'corrupt' };

/** The public use cases and requirements stored with a release: present and valid, absent, or unreadable. */
function readSnapshot(project: OntologyProject, version: string): SnapshotRead {
  const file = path.join(ontologyStore.dir(project), 'releases', version, REQUIREMENTS_SNAPSHOT);
  if (!fs.existsSync(file)) return { state: 'absent' };
  try {
    const data = validSnapshot(JSON.parse(fs.readFileSync(file, 'utf8')));
    return data ? { state: 'ok', data } : { state: 'corrupt' };
  } catch {
    return { state: 'corrupt' };
  }
}

function requirementsSnapshot(project: OntologyProject, version: string): PublishedRequirements | undefined {
  const read = readSnapshot(project, version);
  return read.state === 'ok' ? read.data : undefined;
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
/** A release's public use cases and requirements: while it is being published its document is prepared but not yet frozen. */
export const releaseRequirements = (project: OntologyProject, version: string) => publishedRequirements(project, version, { releasing: true });
export const snapshotFile = (requirements: PublishedRequirements) => `${JSON.stringify(requirements, null, 2)}\n`;

/** Which renderer last wrote each ontology's release pages. Kept in the data directory, never in anything served. */
const pageStateFile = () => path.join(config.dataDir, 'public-pages.json');
function readPageState(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(pageStateFile(), 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}

/**
 * Brings every ontology's published release pages up to date with the current
 * renderer, and holds what older versions published without approval.
 *
 * Runs at startup. An ontology whose pages weren't written by this renderer
 * (PAGE_GENERATOR, tracked in the data directory, so page content can't fake
 * it) has every release page regenerated. Each release is handled on its own,
 * so one bad release can't block the others. Snapshots: a valid one is kept
 * as it is; an unreadable one is kept untouched and the page says the use
 * cases weren't recorded; a missing one is backfilled only for the demo (its
 * use cases are fixed content), and otherwise recorded as not available.
 *
 * Changes are committed to the ontology's repository and go out with its next
 * push to GitHub. Tags still point at the original commits.
 */
export async function refreshReleasePages(): Promise<void> {
  const state = readPageState();
  for (const project of list<OntologyProject>('ontologies')) {
    // What older versions published without anyone approving it is held until a steward does (holds.ts).
    try {
      holdLegacy(project);
    } catch (err) {
      console.warn(`[public] could not check ${project.slug}: ${(err as Error).message}`);
    }
    const versions = new Set(ontologyStore.versions(project));
    const releases = publishedReleases(project.id).filter((r) => versions.has(r.version));
    const pending = releases.filter((r) => state[project.slug] !== PAGE_GENERATOR || readSnapshot(project, r.version).state === 'absent' || !fs.existsSync(path.join(ontologyStore.dir(project), 'releases', r.version, 'index.html')));
    if (!pending.length) {
      state[project.slug] = PAGE_GENERATOR;
      continue;
    }
    const changed: Record<string, Record<string, string>> = {};
    let failed = 0;
    for (const release of pending) {
      try {
        const snapshot = readSnapshot(project, release.version);
        let requirements: PublishedRequirements;
        let writeSnapshot = false;
        // Rendered as served: without anything withdrawn since the snapshot was taken.
        if (snapshot.state === 'ok') requirements = requirementsFor(project, snapshot.data);
        else if (snapshot.state === 'corrupt') requirements = { useCases: [], snapshotMissing: true };
        else {
          requirements = project.demo ? releaseRequirements(project, release.version) : { useCases: [], snapshotMissing: true };
          writeSnapshot = true;
        }
        const files = await releasePageFiles(project, release, await ontologyStore.at(project, release.version), requirements);
        if (!writeSnapshot) delete files[REQUIREMENTS_SNAPSHOT];
        changed[release.version] = files;
      } catch (err) {
        failed++;
        console.warn(`[public] could not refresh ${project.slug} ${release.version}: ${(err as Error).message}`);
      }
    }
    try {
      if (Object.keys(changed).length) {
        ontologyStore.updateReleaseFiles(project, changed, `Regenerate public pages (${Object.keys(changed).join(', ')}) with ${PAGE_GENERATOR}`);
        console.log(`[public] refreshed ${project.slug} release pages: ${Object.keys(changed).join(', ')}`);
      }
      if (!failed) state[project.slug] = PAGE_GENERATOR;
    } catch (err) {
      console.warn(`[public] could not save ${project.slug} release pages: ${(err as Error).message}`);
    }
  }
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(pageStateFile(), `${JSON.stringify(state, null, 2)}\n`);
  } catch (err) {
    console.warn(`[public] could not record page state: ${(err as Error).message}`);
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

/** A version waiting for a steward to approve what it publishes (holds.ts): it says so, and serves none of it. */
function held(res: Response, project: OntologyProject, version: string, format: PublicFormat) {
  const what = version === 'draft' ? 'The working draft' : `Version ${version}`;
  const message = `${what} of ${project.title} is being reviewed before it is published again.`;
  res.status(503).set('Cache-Control', 'no-store').set('Retry-After', '86400');
  if (format !== 'html') return void res.type('text/plain').send(`${message}\n`);
  res
    .type('html')
    .send(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Being reviewed</title><style>body{font:16px/1.6 system-ui,sans-serif;max-width:640px;margin:15vh auto;padding:0 16px;color:#14181f;background:#fff}@media (prefers-color-scheme:dark){body{color:#e7eaf0;background:#0f1218}}</style></head><body><h1>Being reviewed</h1><p>${escapeHtml(message)}</p><p>Older versions of this site published changes without anyone approving them first, so a steward is checking it.</p></body></html>`,
    );
}

async function serve(req: Request, res: Response) {
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
    // Not from a version waiting for approval: even a redirect would say which names it has.
    if (isHeld(project, latest ?? 'draft')) return notFound(res, `${project.title} has no version “${requested}”.`, root);
    const graph = await readOntology(project, latest ?? 'draft', undefined);
    const term = graph.term(`${project.namespace}${requested}`) ?? graph.term(`${project.ontologyIRI.replace(/[#/]$/, '')}/${requested}`);
    const anchor = term && termAnchors(graph.view(), project.namespace).get(term.iri);
    if (anchor && !last.format) return res.redirect(303, `${root}#${fragment(anchor)}`);
    return notFound(res, `${project.title} has no version “${requested}”.`, root);
  }

  const format = last.format ?? negotiate(req, res);
  if (!format) return;
  // Published before anyone approved what goes public: nothing of it is served until a steward does.
  if (isHeld(project, version)) return held(res, project, version, format);
  const graph = await readOntology(project, version, undefined);
  if (format === 'html') {
    publicHeaders(res, `${root}/${version}`, version === 'draft');
    // The page quotes use cases: revalidated on every request (the ETag keeps that cheap), so a withdrawn one never outlives withdrawal in a cache.
    res.set('Cache-Control', 'no-cache');
    const input = await pageInput(project, version, base, { graph });
    res.type('html').send(renderOntologyPage(input));
    return;
  }
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
