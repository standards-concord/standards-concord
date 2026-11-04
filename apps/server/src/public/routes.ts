import fs from 'node:fs';
import path from 'node:path';
import { Router, type Request, type Response } from 'express';
import { DataFactory, type Literal, type Quad } from 'n3';
import { bumpVersion, FORMAT_INFO, generatedProvenanceTitles, npmPackage, scrubGeneratedProvenance, serialize, toShacl, toShaclc, toWrapperClasses, withWrapperImport, WRAPPER_CDN, type OntologyGraph } from '@concord/core';
import type { OutputFormat } from '@concord/core/types';
import type { ChangeRequest, OntologyProject, Release, UseCase, WithheldStatement } from '@concord/shared';
import { clock } from '../clock.js';
import { config } from '../config.js';
import { get, HttpError, list, put, remove } from '../db.js';
import { newId } from '../ids.js';
import { findSecrets, foldName, secretsFor, withholdLines, words } from '../services/redact.js';
import { getUser } from '../services/users.js';
import { findProject } from '../services/ontologies.js';
import { ONTOLOGY_FILE, ontologyStore } from '../services/ontologyStore.js';
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
    links: { latest: root, draft: `${root}/draft`, app: `${base}/o/${encodeURIComponent(project.slug)}`, versionBase: root, report: `${root}/-/report`, site: base },
    requirements: isDraft ? publishedRequirements(project) : requirementsFor(opts.requirements ?? requirementsSnapshot(project, version)),
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
export const releaseRequirements = (project: OntologyProject, version: string) => publishedRequirements(project, version);
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
 * renderer, and removes provenance that older versions wrote into the RDF.
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
    const cleanupKey = `cleanup:${project.slug}`;
    if (state[cleanupKey] !== CLEANUP_VERSION) {
      try {
        const { complete } = await remediateProvenance(project);
        // Pages are rendered again after every clean-up run, whatever it changed.
        delete state[project.slug];
        // Runs once: an incomplete clean-up is tried again at the next start.
        if (complete) state[cleanupKey] = CLEANUP_VERSION;
      } catch (err) {
        console.warn(`[public] could not clean ${project.slug}: ${(err as Error).message}`);
      }
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
        if (snapshot.state === 'ok') requirements = snapshot.data;
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

/** Bump when the clean-up below changes, so it runs once more on every ontology. */
const CLEANUP_VERSION = 'privacy clean-up 5';

/**
 * What the clean-up has learned, kept privately so a run that stops half way
 * (or a later run) still knows it: the use case titles generated provenance
 * recorded, the names in credits it withheld, and the formats it had to take
 * down and must regenerate.
 */
interface CleanupState {
  id: string;
  titles: string[];
  names: string[];
  pendingFormats: Record<string, string[]>;
}
const cleanupStateKey = (project: OntologyProject) => `privacy-cleanup:${project.id}`;

const SOURCE = 'http://purl.org/dc/terms/source';
const P_CONTRIBUTOR = 'http://purl.org/dc/terms/contributor';
const CREDIT_PREDICATES = new Set([P_CONTRIBUTOR, 'http://purl.org/dc/terms/creator', 'http://purl.org/dc/elements/1.1/creator', 'http://purl.org/dc/elements/1.1/contributor']);

/** Whether a stored snapshot holds only what may be published: nothing for a real ontology yet, the fixed fictional use cases for the demo. */
export function publishableSnapshot(project: OntologyProject, version: string, data: PublishedRequirements): PublishedRequirements | undefined {
  if (!project.demo) return !data.useCases.length && !data.document ? undefined : { useCases: [], snapshotMissing: true };
  const canonical = validSnapshot(JSON.parse(snapshotFile(releaseRequirements(project, version))));
  return JSON.stringify(canonical) === JSON.stringify(data) ? undefined : releaseRequirements(project, version);
}

/**
 * Takes out of every published ontology (the working draft and each release
 * on disk, every format, notes and snapshots) what older versions of Concord
 * could publish from private use cases and the people behind changes. Nothing
 * is rewritten: a statement that may reveal something is withheld whole (kept
 * privately as a WithheldStatement, so an owner or steward can put it back).
 *
 *   1. Everything is read and learned before anything is changed: the titles
 *      generated provenance recorded, and the credits merges wrote. Credits a
 *      merge wrote are recognised by the term itself: a literal
 *      dcterms:contributor on a term whose dcterms:source names the request
 *      that created it ("<slug>#<n>") and that request's author (or a request
 *      or author that no longer exists), or on a term generated from use
 *      cases. The names in them are then treated as private too.
 *   2. Generated provenance is removed (it's in fixed forms), those credits
 *      are withheld, and so is any other text on any term that names a use
 *      case title or one of those people, however it's written. Credits no
 *      merge wrote were given on purpose, and stay.
 *   3. Every format of every release is regenerated from the cleaned graph; one
 *      that can't be is taken down and tried again on every run until it can.
 *   4. Release notes and the changelog lose any line that names one.
 * Returns whether everything was checked and written: only then is the
 * clean-up recorded as done.
 */
async function remediateProvenance(project: OntologyProject): Promise<{ complete: boolean }> {
  const crs = list<ChangeRequest>('changeRequests', project.id);
  const byNumber = new Map(crs.map((c) => [c.number, c]));
  const dir = ontologyStore.dir(project);
  let complete = true;
  const state: CleanupState = { titles: [], names: [], pendingFormats: {}, ...get<CleanupState>('kv', cleanupStateKey(project)), id: cleanupStateKey(project) };
  const warn = (what: string, err: unknown) => {
    complete = false;
    console.warn(`[public] could not ${what} for ${project.slug}: ${(err as Error).message}`);
  };

  // 1. Read every graph, and learn from all of them before changing any.
  const graphs: { version: string; graph: OntologyGraph }[] = [];
  try {
    graphs.push({ version: 'working', graph: (await ontologyStore.working(project)).clone() });
  } catch (err) {
    warn('read the working draft', err);
  }
  ontologyStore.forgetReleases(project);
  const versions = ontologyStore.versions(project);
  for (const version of versions) {
    try {
      graphs.push({ version, graph: (await ontologyStore.at(project, version)).clone() });
    } catch (err) {
      warn(`read release ${version}`, err);
    }
  }
  const sourceRef = new RegExp(`^${project.slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}#(\\d+)$`);
  /** The literal credits on a term that a merge (not a person) wrote. */
  const generatedCredits = (g: OntologyGraph, subject: string, generatedProvenance: boolean) => {
    const credits = g.store.getQuads(DataFactory.namedNode(subject), DataFactory.namedNode(P_CONTRIBUTOR), null, null).filter((q) => q.object.termType === 'Literal');
    if (!credits.length) return [];
    if (generatedProvenance) return credits;
    const refs = g.store
      .getQuads(DataFactory.namedNode(subject), DataFactory.namedNode(SOURCE), null, null)
      .map((q) => sourceRef.exec(q.object.value)?.[1])
      .filter((n): n is string => !!n);
    return credits.filter((q) =>
      refs.some((n) => {
        const cr = byNumber.get(Number(n));
        const author = cr && getUser(cr.authorId);
        return !author || author.name.normalize('NFKC').trim() === q.object.value.normalize('NFKC').trim();
      }),
    );
  };
  const tainted = new Map<OntologyGraph, Set<string>>();
  const generated = new Map<OntologyGraph, Set<string>>();
  for (const { graph } of graphs) {
    const provenance = generatedProvenanceTitles(graph);
    generated.set(graph, new Set(provenance.keys()));
    const marked = new Set(provenance.keys());
    for (const titles of provenance.values()) state.titles.push(...titles);
    for (const subject of new Set(graph.store.getSubjects(null, null, null).filter((t) => t.termType === 'NamedNode').map((t) => t.value))) {
      if (subject === graph.ontologyIRI) continue;
      const credits = generatedCredits(graph, subject, marked.has(subject));
      if (credits.length) marked.add(subject);
      state.names.push(...credits.map((q) => q.object.value));
    }
    tainted.set(graph, marked);
  }
  state.titles = [...new Set(state.titles)];
  state.names = [...new Set(state.names)];
  put('kv', state);

  // What may not be published: every title the ontology's use cases have had, those learned above, and
  // the names of the people who wrote the use cases or were credited by a merge. A title that is also
  // the ontology's own vocabulary (a term named "Volunteering" in a volunteering ontology) reveals nothing.
  const vocabulary = new Set<string>();
  const working = graphs.find((x) => x.version === 'working')?.graph;
  if (working) {
    const view = working.view();
    for (const t of [...view.classes, ...view.objectProperties, ...view.datatypeProperties, ...view.individuals]) {
      if (tainted.get(working)?.has(t.iri)) continue;
      for (const name of [t.label ?? '', t.iri.replace(/^.*[#/]/, '')]) {
        vocabulary.add(foldName(name));
        for (const w of words(name)) vocabulary.add(foldName(w));
      }
    }
  }
  const all = secretsFor(list<UseCase>('useCases', project.id), { titles: state.titles, people: state.names });
  const secrets = { ...all, titles: all.titles.filter((t) => !vocabulary.has(foldName(t.words.join('')))) };

  // 2. Clean each graph.
  const withheld: WithheldStatement[] = [];
  const withhold = (version: string, g: OntologyGraph, q: Quad, reason: WithheldStatement['reason']) => {
    g.store.removeQuad(q);
    const o = q.object as Literal;
    withheld.push({
      id: newId('whd'),
      ontologyId: project.id,
      version,
      subject: q.subject.value,
      predicate: q.predicate.value,
      object: { value: o.value, language: o.language || undefined, datatype: o.language ? undefined : o.datatype?.value },
      reason,
      at: clock.iso(),
    });
  };
  const clean = (version: string, g: OntologyGraph) => {
    let n = 0;
    const credits = new Set<Quad>();
    for (const subject of tainted.get(g) ?? []) for (const q of generatedCredits(g, subject, !!generated.get(g)?.has(subject))) credits.add(q);
    for (const q of credits) {
      withhold(version, g, q, 'credit');
      n++;
    }
    n += scrubGeneratedProvenance(g);
    for (const q of g.store.getQuads(null, null, null, null)) {
      if (q.subject.termType !== 'NamedNode' || q.subject.value === g.ontologyIRI || q.object.termType !== 'Literal') continue;
      // A credit no merge wrote was given on purpose, and stays.
      if (CREDIT_PREDICATES.has(q.predicate.value)) continue;
      const found = findSecrets(q.object.value, secrets);
      if (!found.length) continue;
      withhold(version, g, q, found[0]);
      n++;
    }
    return n;
  };

  const files: Record<string, Record<string, string | null>> = {};
  for (const { version, graph } of graphs) {
    try {
      const changed = clean(version, graph);
      if (version === 'working') {
        if (changed) await ontologyStore.commitWorking(project, graph, 'Withhold contributor names and use case titles from annotations', { name: 'Concord' });
        continue;
      }
      const out: Record<string, string | null> = {};
      if (changed) out[ONTOLOGY_FILE] = await graph.toTurtle();
      // 3. Every other format, from the cleaned graph: those on disk, and any taken down before.
      const pending = new Set(state.pendingFormats[version] ?? []);
      for (const format of Object.keys(FORMAT_INFO) as OutputFormat[]) {
        if (format === 'turtle') continue;
        const name = `ontology.${FORMAT_INFO[format].extension}`;
        const file = path.join(dir, 'releases', version, name);
        const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
        if (current === undefined && !pending.has(name)) continue;
        try {
          const fresh = await serialize(graph, format, { name: project.slug });
          if (fresh !== current) out[name] = fresh;
          pending.delete(name);
        } catch (err) {
          // It can't be checked or replaced: take it down rather than keep publishing what it may hold, and try again next time.
          if (current !== undefined) out[name] = null;
          pending.add(name);
          warn(`regenerate ${version} as ${format} (taken down until it can be)`, err);
        }
      }
      if (pending.size) state.pendingFormats[version] = [...pending];
      else delete state.pendingFormats[version];
      const snapshot = readSnapshot(project, version);
      if (snapshot.state === 'ok') {
        const replacement = publishableSnapshot(project, version, snapshot.data);
        if (replacement) out[REQUIREMENTS_SNAPSHOT] = snapshotFile(replacement);
      }
      if (Object.keys(out).length) files[version] = out;
    } catch (err) {
      warn(`clean ${version}`, err);
    }
  }

  // 4. Notes: a line naming a title or a person is left out.
  for (const release of list<Release>('releases', project.id)) {
    try {
      const notes = withholdLines(release.notes, secrets);
      if (notes !== release.notes) {
        release.notes = notes;
        put('releases', release, release.ontologyId);
      }
      const file = path.join(dir, 'releases', release.version, 'RELEASE_NOTES.md');
      if (versions.includes(release.version) && fs.existsSync(file)) {
        const before = fs.readFileSync(file, 'utf8');
        const after = withholdLines(before, secrets);
        if (after !== before) files[release.version] = { ...files[release.version], 'RELEASE_NOTES.md': after };
      }
    } catch (err) {
      warn(`clean the notes of ${release.version}`, err);
    }
  }
  if (Object.keys(files).length) {
    try {
      ontologyStore.updateReleaseFiles(project, files, `Withhold contributor names and use case titles from releases (${Object.keys(files).join(', ')})`);
    } catch (err) {
      warn('write releases', err);
    }
    ontologyStore.forgetReleases(project);
  }
  try {
    const changelog = path.join(dir, 'CHANGELOG.md');
    if (fs.existsSync(changelog)) {
      const before = fs.readFileSync(changelog, 'utf8');
      const after = withholdLines(before, secrets);
      if (after !== before) ontologyStore.updateRepoFile(project, 'CHANGELOG.md', after, 'Withhold use case titles from the changelog');
    }
  } catch (err) {
    warn('clean the changelog', err);
  }
  for (const w of withheld) put('withheld', w, project.id);
  put('kv', state);
  if (Object.keys(state.pendingFormats).length) complete = false;
  return { complete };
}

/** Statements withheld from an ontology's public views, waiting for an owner or steward. */
export const listWithheld = (ontologyId: string) => list<WithheldStatement>('withheld', ontologyId).sort((a, b) => a.version.localeCompare(b.version) || a.subject.localeCompare(b.subject));

/** Puts a withheld statement back where it was taken from (an owner or steward decided it's fine to publish). */
export async function restoreWithheld(project: OntologyProject, id: string): Promise<void> {
  const w = get<WithheldStatement>('withheld', id);
  if (!w || w.ontologyId !== project.id) throw new HttpError(404, 'Nothing withheld with that id');
  const object = DataFactory.literal(w.object.value, w.object.language || (w.object.datatype ? DataFactory.namedNode(w.object.datatype) : undefined));
  const quad = DataFactory.quad(DataFactory.namedNode(w.subject), DataFactory.namedNode(w.predicate), object);
  if (w.version === 'working') {
    const g = (await ontologyStore.working(project)).clone();
    g.store.addQuad(quad);
    await ontologyStore.commitWorking(project, g, 'Restore a statement the privacy clean-up withheld', { name: 'Concord' });
  } else {
    ontologyStore.forgetReleases(project);
    const g = (await ontologyStore.at(project, w.version)).clone();
    g.store.addQuad(quad);
    const out: Record<string, string> = { [ONTOLOGY_FILE]: await g.toTurtle() };
    for (const format of Object.keys(FORMAT_INFO) as OutputFormat[]) {
      const name = `ontology.${FORMAT_INFO[format].extension}`;
      if (format !== 'turtle' && fs.existsSync(path.join(ontologyStore.dir(project), 'releases', w.version, name))) out[name] = await serialize(g, format, { name: project.slug });
    }
    ontologyStore.updateReleaseFiles(project, { [w.version]: out }, `Restore a statement the privacy clean-up withheld from ${w.version}`);
    ontologyStore.forgetReleases(project);
    // Its page is rendered again at the next refresh.
    const pages = readPageState();
    delete pages[project.slug];
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(pageStateFile(), `${JSON.stringify(pages, null, 2)}\n`);
  }
  remove('withheld', id);
}

/** Keeps a statement withheld for good (it's forgotten here). */
export function dismissWithheld(project: OntologyProject, id: string) {
  const w = get<WithheldStatement>('withheld', id);
  if (w && w.ontologyId === project.id) remove('withheld', id);
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
