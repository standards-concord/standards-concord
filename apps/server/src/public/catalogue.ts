import { DataFactory, Writer } from 'n3';
import type { OntologyProject } from '@concord/shared';
import { list } from '../db.js';
import { ownTermsView } from './anchors.js';
import { isHeld, readOntology } from './holds.js';
import { escapeHtml as esc } from './markdown.js';
import { latestVersion, publishedRelease } from './published.js';
import { formatDate, publicPage } from './shell.js';
import { PUBLIC_BASE } from './w3id.js';

const TITLE = 'Standards on Concord';
const DESCRIPTION = 'Open data standards written and governed in the open. Each has a permanent address, a human-readable page and machine-readable files.';

export interface CatalogueEntry {
  title: string;
  description: string;
  url: string;
  domain?: string;
  version?: string;
  publishedAt?: string;
  held: boolean;
  counts?: { classes: number; properties: number };
}

/** Keep whole words within the description's first 240 characters. */
export function catalogueDescription(text: string): string {
  if (text.length <= 240) return text;
  const start = text.slice(0, 240);
  return (/\s/.test(text[240]) ? start : start.replace(/\S*$/, '')).trimEnd();
}

/** Only ontology records, never the separate forks or federations collections. Use the public page's version and approval gate. */
export async function catalogueEntries(base: string): Promise<CatalogueEntry[]> {
  const projects = (await list<OntologyProject>('ontologies')).sort((a, b) => a.title.localeCompare(b.title, 'en-GB') || a.slug.localeCompare(b.slug));
  return Promise.all(projects.map(async (project) => {
    const version = await latestVersion(project) ?? 'draft';
    const entry: CatalogueEntry = {
      title: project.title,
      description: catalogueDescription(project.description),
      url: `${base}${PUBLIC_BASE}/${encodeURIComponent(project.slug)}`,
      domain: project.domain,
      held: await isHeld(project, version),
    };
    // Decide before reading any graph. In particular, never count a held working draft.
    if (entry.held) return entry;
    const graph = await readOntology(project, version, undefined);
    const view = ownTermsView(graph.view({ includeVocabularyDeclarations: true }), project.namespace, project.ontologyIRI);
    return {
      ...entry,
      version,
      publishedAt: version === 'draft' ? undefined : (await publishedRelease(project.id, version))?.publishedAt ?? view.metadata.issued,
      counts: { classes: view.classes.length, properties: view.objectProperties.length + view.datatypeProperties.length + view.annotationProperties.length },
    };
  }));
}

/** hasPart suits DefinedTermSet: a standard is a vocabulary, rather than a schema.org Dataset. */
export function catalogueJsonLd(entries: CatalogueEntry[], url: string) {
  return {
    '@context': { '@vocab': 'https://schema.org/' },
    '@type': 'DataCatalog',
    '@id': url,
    name: TITLE,
    description: DESCRIPTION,
    url,
    hasPart: entries.map((entry) => ({
      '@type': 'DefinedTermSet',
      '@id': entry.url,
      name: entry.title,
      description: entry.description,
      url: entry.url,
      version: entry.version,
    })),
  };
}

export async function catalogueTurtle(entries: CatalogueEntry[], url: string): Promise<string> {
  const { namedNode: iri, literal, quad } = DataFactory;
  const namespaces = {
    dcat: 'http://www.w3.org/ns/dcat#',
    dcterms: 'http://purl.org/dc/terms/',
    owl: 'http://www.w3.org/2002/07/owl#',
    rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  };
  const writer = new Writer({ prefixes: namespaces });
  const root = iri(url);
  const type = iri(namespaces.rdf + 'type');
  writer.addQuad(root, type, iri(namespaces.dcat + 'Catalog'));
  writer.addQuad(root, iri(namespaces.dcterms + 'title'), literal(TITLE));
  writer.addQuad(root, iri(namespaces.dcterms + 'description'), literal(DESCRIPTION));
  for (const entry of entries) {
    const subject = iri(entry.url);
    writer.addQuad(root, iri(namespaces.dcat + 'resource'), subject);
    writer.addQuads([
      quad(subject, type, iri(namespaces.dcat + 'Resource')),
      quad(subject, iri(namespaces.dcterms + 'title'), literal(entry.title)),
      quad(subject, iri(namespaces.dcterms + 'description'), literal(entry.description)),
      quad(subject, iri(namespaces.dcat + 'landingPage'), subject),
    ]);
    if (entry.version) writer.addQuad(subject, iri(namespaces.owl + 'versionInfo'), literal(entry.version));
  }
  return new Promise((resolve, reject) => writer.end((error, result) => error ? reject(error) : resolve(result)));
}

export function renderCatalogue(entries: CatalogueEntry[], base: string): string {
  const url = `${base}${PUBLIC_BASE}`;
  return publicPage({
    title: TITLE,
    description: DESCRIPTION,
    url,
    alternates: [
      { mediaType: 'application/ld+json', href: `${url}.jsonld`, label: 'JSON-LD' },
      { mediaType: 'text/turtle', href: `${url}.ttl`, label: 'Turtle' },
    ],
    jsonLd: catalogueJsonLd(entries, url),
    header: `<p class="crumbs">Concord</p><h1>${TITLE}</h1><p>${DESCRIPTION}</p>`,
    main: entries.length ? `<ul class="catalogue" aria-label="Standards">${entries.map((entry) => {
      const version = entry.held ? 'Being reviewed' : entry.version === 'draft' ? 'Draft, no published version yet' : `Version ${entry.version}${entry.publishedAt ? `, ${formatDate(entry.publishedAt)}` : ''}`;
      const facts = [version, entry.domain, entry.counts ? `${entry.counts.classes} classes, ${entry.counts.properties} properties` : undefined].filter(Boolean);
      return `<li><h2><a href="${esc(entry.url)}">${esc(entry.title)}</a></h2>${entry.description ? `<p>${esc(entry.description)}</p>` : ''}<p class="muted">${facts.map((fact) => esc(fact!)).join(' · ')}</p></li>`;
    }).join('')}</ul>` : '<p>No standards have been published here yet.</p>',
    footer: `<p>Published with Concord · <a href="${esc(base)}/login">Sign in to Concord</a></p>`,
  });
}
