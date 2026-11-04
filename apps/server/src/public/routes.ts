import fs from 'node:fs';
import path from 'node:path';
import { Router, type Request, type Response } from 'express';
import { expandIRI, FORMAT_INFO, generatedProvenanceTitles, rewriteLiterals, scrubGeneratedProvenance, serialize, type OntologyGraph } from '@concord/core';
import type { OutputFormat } from '@concord/core/types';
import type { ChangeRequest, OntologyProject, Release, User } from '@concord/shared';
import { clock } from '../clock.js';
import { config } from '../config.js';
import { get, list, put } from '../db.js';
import { allSecrets, publishableNotes, redactText, secretsFor, secretsOf } from '../services/redact.js';
import { releaseSecrets } from '../services/releases.js';
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
 *   /def/<slug>/<version>.ttl   a specific serialisation (also .jsonld, .owl, .nt, .omn, .linkml.yaml, .shacl.ttl, .html)
 *
 * Browsers get the HTML page; anything asking for RDF gets RDF (Vary: Accept).
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
const CLEANUP_VERSION = 'privacy clean-up 4';

/** When a request was merged: what order its renames happened in. */
const mergedAt = (cr: ChangeRequest) => cr.timeline.find((e) => e.type === 'status' && /^merged/.test(e.message ?? ''))?.at ?? cr.statusSince ?? '';

/**
 * Every name each request's terms have had. Terms are followed through later
 * renames, and a new term is a new term even when it reuses a name an earlier
 * one gave up (OldRecord renamed to NewRecord, then a new OldRecord renamed to
 * OtherRecord: the first request's term is OldRecord and NewRecord).
 */
function termHistory(crs: ChangeRequest[], g: OntologyGraph) {
  const current = new Map<string, Set<string>>();
  const identity = (iri: string) => {
    let id = current.get(iri);
    if (!id) current.set(iri, (id = new Set([iri])));
    return id;
  };
  const touched = new Map<string, Set<string>[]>();
  const created = new Map<string, Set<string>[]>();
  const ordered = [...crs].sort((a, b) => mergedAt(a).localeCompare(mergedAt(b)) || a.number - b.number);
  for (const cr of ordered) {
    const t: Set<string>[] = [];
    const c: Set<string>[] = [];
    for (const op of cr.ops) {
      const r = op as Record<string, unknown>;
      if (op.op === 'renameTerm') {
        const from = expandIRI(op.iri, g.prefixes);
        const to = g.namespace + op.newLocalName;
        const id = identity(from);
        current.delete(from);
        id.add(to);
        current.set(to, id);
        t.push(id);
      } else if (typeof r.localName === 'string') {
        const iri = g.namespace + r.localName;
        const id = new Set([iri]);
        current.set(iri, id);
        t.push(id);
        c.push(id);
      } else if (typeof r.iri === 'string') t.push(identity(expandIRI(r.iri, g.prefixes)));
      else if (typeof r.classIri === 'string') t.push(identity(expandIRI(r.classIri, g.prefixes)));
    }
    touched.set(cr.id, t);
    created.set(cr.id, c);
  }
  const names = (ids: Set<string>[] | undefined) => [...new Set((ids ?? []).flatMap((id) => [...id]))];
  return {
    /** Every name of the terms a request added or changed. */
    touched: (cr: ChangeRequest) => names(touched.get(cr.id)),
    /** Every name of the terms a request added (the only ones merges credited their author on). */
    created: (cr: ChangeRequest) => names(created.get(cr.id)),
  };
}

/**
 * What the clean-up learned from generated provenance it has since removed:
 * the use case titles each term recorded. Kept (privately) so a run that
 * stopped half way can still finish cleaning everything else.
 */
interface CleanupInputs {
  id: string;
  terms: Record<string, string[]>;
}
const cleanupInputsKey = (project: OntologyProject) => `privacy-cleanup:${project.id}`;

/** Whether a stored snapshot holds only what may be published: nothing for a real ontology yet, the fixed fictional use cases for the demo. */
export function publishableSnapshot(project: OntologyProject, version: string, data: PublishedRequirements): PublishedRequirements | undefined {
  if (!project.demo) return !data.useCases.length && !data.document ? undefined : { useCases: [], snapshotMissing: true };
  const canonical = validSnapshot(JSON.parse(snapshotFile(releaseRequirements(project, version))));
  return JSON.stringify(canonical) === JSON.stringify(data) ? undefined : releaseRequirements(project, version);
}

/**
 * Removes what older versions of Concord could publish from private use
 * cases and the people behind changes, from the working draft, every release
 * on disk (RDF in every format, notes and use case snapshots) and every
 * release record, drafts included:
 *   - generated provenance (scrubGeneratedProvenance); a term's contributor
 *     only where a merged request by that person touched the term,
 *   - the titles and authors of the use cases each synthesised request came
 *     from, in the terms it added or changed (followed through later renames),
 *     and the titles generated provenance itself recorded, in those terms,
 *   - the same in release notes (record, RELEASE_NOTES.md, CHANGELOG.md),
 *   - release snapshots that hold anything but what may be published.
 * Every serialisation is regenerated from the cleaned graph and compared with
 * what's on disk, so a run interrupted half way is finished by the next.
 * Each release is handled on its own. Returns whether everything was checked
 * and written: only then is the clean-up recorded as done.
 */
async function remediateProvenance(project: OntologyProject): Promise<{ complete: boolean }> {
  const crs = list<ChangeRequest>('changeRequests', project.id).filter((c) => ['merged', 'released'].includes(c.status));
  const plans = crs.flatMap((cr) => {
    const secrets = secretsOf(cr);
    return secrets ? [{ cr, secrets }] : [];
  });
  const dir = ontologyStore.dir(project);
  let complete = true;
  const inputs: CleanupInputs = get<CleanupInputs>('kv', cleanupInputsKey(project)) ?? { id: cleanupInputsKey(project), terms: {} };
  const harvestedTitles = () => [...new Set(Object.values(inputs.terms).flat())];
  // Terms generated from use cases whose requests are gone don't say who asked: any member's name there is provenance.
  const userNames = list<User>('users').map((u) => u.name).filter(Boolean);
  const legacyPeople = () => secretsFor([], { people: Object.keys(inputs.terms).length ? userNames : [] });
  const norm = (name: string) => name.normalize('NFKC').trim().toLowerCase();
  const memberNames = new Set(userNames.map(norm));

  const scrub = (g: OntologyGraph) => {
    const history = termHistory(crs, g);
    // Remember what generated provenance recorded before removing it, so a retry still knows.
    let learned = false;
    for (const [subject, titles] of generatedProvenanceTitles(g)) {
      const before = inputs.terms[subject] ?? [];
      const after = [...new Set([...before, ...titles])];
      if (after.length !== before.length) {
        inputs.terms[subject] = after;
        learned = true;
      }
    }
    if (learned) put('kv', inputs);
    // Merges credited their author on the terms they added.
    const credited = new Map<string, Set<string>>();
    for (const cr of crs) {
      const name = getUser(cr.authorId)?.name;
      if (name) for (const iri of history.created(cr)) credited.set(iri, new Set([...(credited.get(iri) ?? []), norm(name)]));
    }
    const legacy = new Set(Object.keys(inputs.terms));
    let n = scrubGeneratedProvenance(g, {
      generatedContributor: (subject, name) => !!credited.get(subject)?.has(norm(name)) || (legacy.has(subject) && memberNames.has(norm(name))),
    });
    for (const { cr, secrets } of plans) n += rewriteLiterals(g, history.touched(cr), (v) => redactText(v, secrets));
    const people = legacyPeople();
    for (const [subject, titles] of Object.entries(inputs.terms)) {
      const secrets = allSecrets([secretsFor([], { titles }), people]);
      n += rewriteLiterals(g, [subject], (v) => redactText(v, secrets));
    }
    return n;
  };

  try {
    const draft = (await ontologyStore.working(project)).clone();
    if (scrub(draft)) {
      await ontologyStore.commitWorking(project, draft, 'Remove contributor names and use case titles from annotations', { name: 'Concord' });
      console.log(`[public] cleaned ${project.slug} working draft`);
    }
  } catch (err) {
    complete = false;
    console.warn(`[public] could not clean ${project.slug} working draft: ${(err as Error).message}`);
  }

  const changed: Record<string, Record<string, string | null>> = {};
  const read = (version: string, name: string) => {
    const file = path.join(dir, 'releases', version, name);
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
  };
  const versions = ontologyStore.versions(project);
  for (const version of versions) {
    try {
      const files: Record<string, string | null> = {};
      ontologyStore.forgetReleases(project);
      const graph = (await ontologyStore.at(project, version)).clone();
      if (scrub(graph)) files[ONTOLOGY_FILE] = await graph.toTurtle();
      // Every other serialisation, from the cleaned graph, wherever it differs from the file.
      for (const format of Object.keys(FORMAT_INFO) as OutputFormat[]) {
        const name = `ontology.${FORMAT_INFO[format].extension}`;
        const current = read(version, name);
        if (format === 'turtle' || current === undefined) continue;
        try {
          const fresh = await serialize(graph, format);
          if (fresh !== current) files[name] = fresh;
        } catch (err) {
          // The old file can't be checked or replaced: take it down rather than keep publishing what it may hold.
          files[name] = null;
          complete = false;
          console.warn(`[public] could not reserialise ${project.slug} ${version} as ${format}, so removed it: ${(err as Error).message}`);
        }
      }
      const snapshot = readSnapshot(project, version);
      if (snapshot.state === 'ok') {
        const replacement = publishableSnapshot(project, version, snapshot.data);
        if (replacement) files[REQUIREMENTS_SNAPSHOT] = snapshotFile(replacement);
      }
      if (Object.keys(files).length) changed[version] = files;
    } catch (err) {
      complete = false;
      console.warn(`[public] could not clean ${project.slug} ${version}: ${(err as Error).message}`);
    }
  }

  // Notes, once every graph has given up the titles its provenance recorded (this run or an earlier one).
  const harvestedSecrets = allSecrets([secretsFor([], { titles: harvestedTitles() }), legacyPeople()]);
  for (const release of list<Release>('releases', project.id)) {
    try {
      const secrets = allSecrets([releaseSecrets(release), harvestedSecrets]);
      const notes = publishableNotes(release.notes, secrets);
      if (notes !== release.notes) {
        release.notes = notes;
        put('releases', release, release.ontologyId);
      }
      const file = versions.includes(release.version) ? read(release.version, 'RELEASE_NOTES.md') : undefined;
      if (file !== undefined) {
        const clean = publishableNotes(file, secrets);
        if (clean !== file) changed[release.version] = { ...changed[release.version], 'RELEASE_NOTES.md': clean };
      }
    } catch (err) {
      complete = false;
      console.warn(`[public] could not clean ${project.slug} ${release.version} notes: ${(err as Error).message}`);
    }
  }
  if (Object.keys(changed).length) {
    try {
      ontologyStore.updateReleaseFiles(project, changed, `Remove contributor names and use case titles from releases (${Object.keys(changed).join(', ')})`);
      console.log(`[public] cleaned ${project.slug} releases: ${Object.keys(changed).join(', ')}`);
    } catch (err) {
      complete = false;
      console.warn(`[public] could not write ${project.slug} releases: ${(err as Error).message}`);
    }
    ontologyStore.forgetReleases(project);
  }
  try {
    const changelog = path.join(dir, 'CHANGELOG.md');
    if (fs.existsSync(changelog)) {
      const before = fs.readFileSync(changelog, 'utf8');
      const after = publishableNotes(before, allSecrets([...plans.map((p) => p.secrets), harvestedSecrets]));
      if (after !== before) ontologyStore.updateRepoFile(project, 'CHANGELOG.md', after, 'Remove use case titles from the changelog');
    }
  } catch (err) {
    complete = false;
    console.warn(`[public] could not clean ${project.slug} changelog: ${(err as Error).message}`);
  }
  return { complete };
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

  let format = last.format;
  if (!format) {
    // The answer depends on Accept, including when it is a refusal.
    res.vary('Accept');
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
