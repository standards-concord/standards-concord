/**
 * FAIR assessment of an ontology, modelled on the FOOPS! checks (Garijo, Corcho &
 * Poveda-Villalón 2021) and the FAIR vocabulary best practices.
 *
 * Scoring follows FOOPS!: each principle (Findable, Accessible, Interoperable,
 * Reusable) gets the share of its checks that pass, and the overall score is the
 * mean of the four, so a principle with many checks doesn't outweigh one with few.
 * Checks that need the network (does the IRI resolve?) use the caller's
 * FairContext; without it they are reported as not checked and left out.
 */
import type { FairCheck, FairContext, FairPrinciple, FairReport } from './types.js';
import { NS, isWellKnown } from './ns.js';
import { objects } from './rdf.js';
import type { OntologyGraph } from './graph.js';

const PERSISTENT_HOSTS = [
  'w3id.org', 'purl.org', 'purl.obolibrary.org', 'doi.org', 'dx.doi.org', 'n2t.net', 'identifiers.org',
  'purl.archive.org', 'data.europa.eu', 'www.w3.org', 'schema.org',
];
/** "1 keyword", "4 keywords": these messages used to say "4 keyword(s)". */
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

const KNOWN_LICENSES = /creativecommons\.org|opensource\.org|spdx\.org|opendatacommons\.org|nationalarchives\.gov\.uk\/doc\/open-government-licence/i;

export function fairCheck(graph: OntologyGraph, ctx: FairContext = {}): FairReport {
  const m = graph.metadata();
  const iri = graph.ontologyIRI;
  const s = graph.store;
  const checks: FairCheck[] = [];
  const add = (id: string, principle: FairPrinciple, title: string, passed: boolean | undefined, message: string, reference: string) =>
    checks.push({ id, principle, title, passed: passed === true, status: passed === undefined ? 'not-checked' : passed ? 'pass' : 'fail', message, reference });

  let host = '';
  try { host = new URL(iri).host; } catch { /* not a URL */ }
  const persistent = PERSISTENT_HOSTS.includes(host) || iri.startsWith('urn:');
  add('F1-persistent-iri', 'F', 'Ontology IRI uses a persistent identifier service', persistent,
    persistent ? `${iri} is served by ${host || 'a URN scheme'}` : iri ? `${iri} is not under a permanent IRI service (w3id.org, purl.org, doi.org)` : 'no ontology IRI',
    'FOOPS! PURL1; FAIR F1');

  const vIri = m.versionIRI;
  add('F1-version-iri', 'F', 'Version IRI declared (and distinct from the ontology IRI)', !!vIri && vIri !== iri,
    vIri ? (vIri !== iri ? `owl:versionIRI ${vIri}` : 'owl:versionIRI equals the ontology IRI') : 'no owl:versionIRI',
    'FOOPS! VER1; FAIR F1');

  add('F2-title', 'F', 'Title', !!m.title, m.title ? `"${m.title}"` : 'no dcterms:title', 'FOOPS! OM1; FAIR F2');
  add('F2-description', 'F', 'Description', !!m.description, m.description ? 'dcterms:description present' : 'no dcterms:description', 'FOOPS! OM1; FAIR F2');

  const keywords = [NS.dcat + 'keyword', NS.schema + 'keywords', NS.dcterms + 'subject', NS.dc + 'subject']
    .flatMap((p) => (iri ? objects(s, iri, p) : []));
  add('F2-keywords', 'F', 'Keywords', keywords.length > 0, keywords.length ? count(keywords.length, 'keyword') : 'no dcat:keyword / schema:keywords / dcterms:subject',
    'FOOPS! OM2; FAIR F2');

  const prefixOk = !!m.preferredPrefix && !!m.preferredNamespace;
  add('F4-prefix-namespace', 'F', 'Preferred prefix and namespace declared', prefixOk,
    prefixOk ? `${m.preferredPrefix}: <${m.preferredNamespace}>` : 'missing vann:preferredNamespacePrefix and/or vann:preferredNamespaceUri',
    'FOOPS! FIND1; FAIR vocabulary BP 2');

  const http = /^https?:\/\//.test(iri);
  add('A1.1-open-protocol', 'A', 'Ontology IRI uses an open protocol (HTTP or HTTPS)', http,
    http ? `${iri} can be dereferenced over HTTP(S)` : iri ? `${iri} is not an HTTP(S) IRI, so it cannot be looked up on the web` : 'no ontology IRI',
    'FOOPS! HTTP1; FAIR A1.1');
  const res = http ? ctx.resolution : undefined;
  add('A1-rdf', 'A', 'Ontology IRI returns RDF (content negotiation)', res?.rdf,
    !http ? 'needs an HTTP(S) ontology IRI' : !res ? 'not checked: the IRI was not looked up' : res.rdf ? 'returns an RDF serialisation when asked for one' : `does not return RDF${res.detail ? ` (${res.detail})` : ''}; point the IRI's redirect at a published release`,
    'FOOPS! CN1, RDF1; FAIR A1');
  add('A1-html', 'A', 'Ontology IRI returns human-readable documentation', res?.html,
    !http ? 'needs an HTTP(S) ontology IRI' : !res ? 'not checked: the IRI was not looked up' : res.html ? 'returns HTML when asked by a browser' : 'does not return HTML documentation to browsers',
    'FOOPS! CN1 (HTML); FAIR A1');

  const metaPreds = iri ? [...new Set(s.getQuads(null, null, null, null).filter((q) => q.subject.value === iri).map((q) => q.predicate.value))].filter((p) => p !== NS.rdf + 'type') : [];
  const standard = metaPreds.filter(isWellKnown);
  const share = metaPreds.length ? standard.length / metaPreds.length : 0;
  add('I1-standard-metadata-vocabularies', 'I', 'Metadata uses standard vocabularies (DCTERMS, OWL, VANN, DCAT, schema.org...)', metaPreds.length > 0 && share >= 0.8,
    metaPreds.length ? `${standard.length}/${metaPreds.length} header properties are from standard vocabularies` : 'the ontology header has no metadata', 'FOOPS! VOC1; FAIR I1');

  const badImports = m.imports.filter((i) => !/^https?:\/\//.test(i));
  add('I2-imports', 'I', 'Imports use resolvable HTTP(S) IRIs', m.imports.length ? badImports.length === 0 : undefined,
    m.imports.length ? (badImports.length ? `non-HTTP imports: ${badImports.join(', ')}` : `${count(m.imports.length, 'import')}, all HTTP(S) (resolution not checked)`) : 'not applicable: no imports',
    'FOOPS! VOC2; FAIR I2');

  const licenseOk = !!m.license;
  add('R1.1-license', 'R', 'License declared', licenseOk,
    licenseOk ? `${m.license}${KNOWN_LICENSES.test(m.license!) ? '' : ' (not a well-known license IRI)'}` : 'no dcterms:license',
    'FOOPS! OM4.1/OM4.2; FAIR R1.1; OOPS! P41');

  add('R1.2-provenance-agents', 'R', 'Creators (and contributors) declared', m.creators.length > 0,
    m.creators.length ? `${count(m.creators.length, 'creator')}, ${count(m.contributors.length, 'contributor')}${m.publisher ? ', publisher ' + m.publisher : ''}` : 'no dcterms:creator',
    'FOOPS! OM5.1; FAIR R1.2');

  const dates = !!m.created && !!(m.modified || m.issued);
  add('R1.2-provenance-dates', 'R', 'Creation and modification/issue dates', dates,
    dates ? `created ${m.created}, modified ${m.modified ?? m.issued}` : `missing ${[!m.created && 'dcterms:created', !(m.modified || m.issued) && 'dcterms:modified'].filter(Boolean).join(' and ')}`,
    'FOOPS! OM5.2; FAIR R1.2');

  const cite = iri ? [...objects(s, iri, NS.dcterms + 'bibliographicCitation'), ...objects(s, iri, NS.bibo + 'doi'), ...objects(s, iri, NS.schema + 'citation')] : [];
  add('R1-citation', 'R', 'Citation information', cite.length > 0, cite.length ? 'dcterms:bibliographicCitation present' : 'no dcterms:bibliographicCitation (recommended)',
    'FOOPS! OM3; FAIR vocabulary BP 7');

  const v = graph.view();
  const ns = graph.namespace;
  const terms = [...v.classes, ...v.objectProperties, ...v.datatypeProperties, ...v.concepts, ...v.conceptSchemes].filter((t) => ns && t.iri.startsWith(ns) && !t.deprecated);
  const labelled = terms.filter((t) => t.label).length;
  const defined = terms.filter((t) => t.definition).length;
  const cov = terms.length ? Math.min(labelled, defined) / terms.length : 1;
  add('R1-term-documentation', 'R', 'Terms have labels and definitions (≥ 90%)', terms.length ? cov >= 0.9 : undefined,
    terms.length ? `${labelled}/${terms.length} labelled, ${defined}/${terms.length} defined` : 'not applicable: no terms yet', 'FOOPS! VOC3/VOC4; FAIR R1, I2');

  const byPrinciple = {} as FairReport['byPrinciple'];
  for (const pr of ['F', 'A', 'I', 'R'] as FairPrinciple[]) {
    const run = checks.filter((c) => c.principle === pr && c.status !== 'not-checked');
    const ok = run.filter((c) => c.passed).length;
    byPrinciple[pr] = { passed: ok, total: run.length, score: run.length ? ok / run.length : 1 };
  }
  const scored = Object.values(byPrinciple).filter((p) => p.total > 0);
  const score = scored.reduce((a, p) => a + p.score, 0) / (scored.length || 1);
  return { score: Math.round(score * 1000) / 1000, byPrinciple, checks };
}
