/**
 * Namespaces, well-known vocabularies and IRI helpers.
 */
import { Parser } from 'n3';

export const NS = {
  owl: 'http://www.w3.org/2002/07/owl#',
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
  xsd: 'http://www.w3.org/2001/XMLSchema#',
  skos: 'http://www.w3.org/2004/02/skos/core#',
  dcterms: 'http://purl.org/dc/terms/',
  dc: 'http://purl.org/dc/elements/1.1/',
  vann: 'http://purl.org/vocab/vann/',
  prov: 'http://www.w3.org/ns/prov#',
  sh: 'http://www.w3.org/ns/shacl#',
  schema: 'https://schema.org/',
  foaf: 'http://xmlns.com/foaf/0.1/',
  obo: 'http://purl.obolibrary.org/obo/',
  // Additions beyond the API.md minimum: common metadata vocabularies.
  dcat: 'http://www.w3.org/ns/dcat#',
  bibo: 'http://purl.org/ontology/bibo/',
  xml: 'http://www.w3.org/XML/1998/namespace',
} as const;

export const XSD: Record<string, string> = Object.fromEntries(
  [
    'string', 'normalizedString', 'token', 'language', 'boolean', 'decimal', 'integer',
    'nonNegativeInteger', 'positiveInteger', 'nonPositiveInteger', 'negativeInteger',
    'long', 'int', 'short', 'byte', 'unsignedLong', 'unsignedInt', 'unsignedShort', 'unsignedByte',
    'float', 'double', 'date', 'dateTime', 'dateTimeStamp', 'time', 'duration', 'gYear', 'gYearMonth',
    'anyURI', 'hexBinary', 'base64Binary',
  ].map((n) => [n, NS.xsd + n]),
);

/**
 * A namespace prefix that is safe everywhere it is written: a Turtle and
 * SPARQL prefix name (starting with a letter, never ending in a dot), and a
 * JSON-LD term that is not a keyword (`@import`, `@context`) and has no colon.
 * Anything else from editable metadata is refused or ignored, so it can't
 * change what a serialisation means or make JSON-LD processing load a context.
 */
export const isSafePrefix = (p: string): boolean =>
  /^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*$/.test(p) &&
  // A term named like an Object method (hasOwnProperty, constructor) breaks the JSON-LD processor.
  !(p in Object.prototype);

// Node's require, looked up only when Oxigraph is first needed. No static import of node:module,
// so the module also loads in a browser (the in-browser reasoner imports it through graph.ts).
type NodeModule = { createRequire(url: string): (id: string) => unknown };
/** Thrown outside Node (in a browser), where there is no Oxigraph by design: namespaces fail closed, quietly. */
export class OxigraphNotInNode extends Error {
  constructor() {
    super('Oxigraph is only available in Node');
  }
}
const nodeRequire = (id: string): unknown => {
  const mod = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process?.getBuiltinModule?.('node:module') as NodeModule | undefined;
  if (!mod) throw new OxigraphNotInNode();
  return mod.createRequire(import.meta.url)(id);
};
type Oxigraph = { parse(input: string, options: { format: string }): Array<{ subject: { value: string }; object: { value: string } }> };
let oxigraph: Oxigraph | undefined;
let loadOxigraph = (): Oxigraph => nodeRequire('oxigraph') as Oxigraph;
let loadFailureReported = false;

/** For tests: how many namespace verdicts are cached, and their total length. */
export function namespaceCacheForTests(): { entries: number; chars: number } {
  return { entries: verdicts.size, chars: verdictChars };
}

/** For tests: replaces how Oxigraph is loaded, and forgets the loaded copy (cached verdicts are kept). */
export function setOxigraphLoaderForTests(load: () => Oxigraph): void {
  loadOxigraph = load;
  oxigraph = undefined;
}

/** Characters that could break out of the IRI in the Turtle check itself, or that JSON-LD refuses (any Unicode space). */
const PRE_FILTER = /[\s\u0000-\u001f\u007f-\u009f<>"{}|\\^`]/u;

/** Longest namespace checked; longer ones are refused without being parsed or cached. */
const MAX_NAMESPACE = 4096;
const verdicts = new Map<string, boolean>();
let verdictChars = 0;
/** The cache is emptied when it would hold more than this many characters of namespaces in all. */
const MAX_CACHED_CHARS = 1_000_000;

/**
 * A namespace IRI safe to write as a Turtle prefix and a JSON-LD context
 * entry. Rather than restate the IRI grammar, it asks the parsers that read
 * our output: a one-triple Turtle document declaring the namespace as a
 * prefix and using it must be read back, to the same IRIs, by both N3 and
 * Oxigraph (which checks RFC 3987 strictly, hosts and code points included).
 * A cheap filter first refuses spaces (Unicode ones too, which JSON-LD
 * refuses), controls and the characters that end an IRI in Turtle. Starting
 * with a scheme, it can never be a JSON-LD keyword such as `@import`.
 *
 * Verdicts are cached, within a bound on the characters held; namespaces over
 * 4,096 characters are refused before the cache. If Oxigraph can't be loaded
 * the namespace is refused (failing closed) but not cached, and the failure
 * is reported once, so a later call can succeed.
 */
export function isSafeNamespace(iri: string): boolean {
  if (iri.length > MAX_NAMESPACE) return false;
  const known = verdicts.get(iri);
  if (known !== undefined) return known;
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:./s.test(iri) || PRE_FILTER.test(iri)) return remember(iri, false);
  const verdict = parsersAgree(iri);
  return verdict === 'unavailable' ? false : remember(iri, verdict);
}

function remember(iri: string, ok: boolean): boolean {
  if (verdicts.size >= 10_000 || verdictChars + iri.length > MAX_CACHED_CHARS) {
    verdicts.clear();
    verdictChars = 0;
  }
  // A copy, not the string itself: a parser's substring would keep its whole source document alive in the cache.
  // (Buffer only exists in Node; a browser has no such parser source to keep alive.)
  verdicts.set(typeof Buffer === 'undefined' ? iri : Buffer.from(iri, 'utf8').toString('utf8'), ok);
  verdictChars += iri.length;
  return ok;
}

function parsersAgree(iri: string): boolean | 'unavailable' {
  const doc = `@prefix ns: <${iri}> .\nns:Thing <urn:concord:check> <${iri}> .\n`;
  const same = (quads: Array<{ subject: { value: string }; object: { value: string } }>) =>
    quads.length === 1 && quads[0].subject.value === iri + 'Thing' && quads[0].object.value === iri;
  try {
    if (!same(new Parser({ format: 'text/turtle' }).parse(doc))) return false;
  } catch {
    return false;
  }
  if (!oxigraph) {
    try {
      oxigraph = loadOxigraph();
    } catch (err) {
      // In a browser this is expected (nothing there writes Turtle or JSON-LD for others to read), so
      // it isn't reported as an error; on the server it means the check is broken.
      if (!loadFailureReported && !(err instanceof OxigraphNotInNode)) console.error(`Namespace checks are refusing every namespace: Oxigraph could not be loaded (${(err as Error).message}).`);
      loadFailureReported = true;
      return 'unavailable';
    }
  }
  try {
    return same(oxigraph.parse(doc, { format: 'text/turtle' }));
  } catch {
    return false;
  }
}

export const RDF_TYPE = NS.rdf + 'type';
export const RDF_LANGSTRING = NS.rdf + 'langString';
export const RDFS_LITERAL = NS.rdfs + 'Literal';

/** Prefixes added to every graph so output is readable even if the source omitted them. */
export const STANDARD_PREFIXES: Record<string, string> = {
  owl: NS.owl, rdf: NS.rdf, rdfs: NS.rdfs, xsd: NS.xsd, skos: NS.skos, dcterms: NS.dcterms,
  dc: NS.dc, vann: NS.vann, prov: NS.prov, sh: NS.sh, schema: NS.schema, foaf: NS.foaf,
  dcat: NS.dcat, bibo: NS.bibo, obo: NS.obo,
};

/**
 * Vocabularies whose terms may be referenced without a local declaration
 * (see the "undeclared-term" lint rule). schema.org is accepted on both schemes.
 */
export const WELL_KNOWN_NAMESPACES: string[] = [
  NS.rdf, NS.rdfs, NS.owl, NS.xsd, NS.skos, NS.dcterms, NS.dc, NS.prov, NS.schema,
  'http://schema.org/', NS.foaf, NS.vann, NS.dcat, NS.sh, NS.bibo,
];

export function isWellKnown(iri: string): boolean {
  return WELL_KNOWN_NAMESPACES.some((ns) => iri.startsWith(ns));
}

/** Built-in datatypes (XSD + rdf:langString, rdf:PlainLiteral, rdfs:Literal, rdf:XMLLiteral...). */
export function isBuiltinDatatype(iri: string): boolean {
  if (iri.startsWith(NS.xsd)) return true;
  return [RDFS_LITERAL, RDF_LANGSTRING, NS.rdf + 'PlainLiteral', NS.rdf + 'XMLLiteral', NS.rdf + 'HTML',
    NS.rdf + 'JSON', NS.owl + 'real', NS.owl + 'rational'].includes(iri);
}

/**
 * The OWL 2 datatype map (OWL 2 Structural Specification §4). Other XSD types such as
 * xsd:date, xsd:time, xsd:gYear and xsd:duration are not part of OWL 2 DL, so DL reasoners
 * (sparq included) do not decide them.
 */
export const OWL2_DATATYPES = new Set<string>([
  NS.rdf + 'PlainLiteral', NS.rdf + 'XMLLiteral', NS.rdf + 'langString', NS.rdfs + 'Literal', NS.owl + 'real', NS.owl + 'rational',
  ...['decimal', 'integer', 'nonNegativeInteger', 'nonPositiveInteger', 'positiveInteger', 'negativeInteger', 'long', 'int',
    'short', 'byte', 'unsignedLong', 'unsignedInt', 'unsignedShort', 'unsignedByte', 'double', 'float', 'string',
    'normalizedString', 'token', 'language', 'Name', 'NCName', 'NMTOKEN', 'boolean', 'hexBinary', 'base64Binary', 'anyURI',
    'dateTime', 'dateTimeStamp'].map((n) => NS.xsd + n),
]);

// Turtle PN_LOCAL (simplified, ASCII-safe subset); RDF/XML needs an NCName.
const PN_LOCAL = /^[A-Za-z0-9_]([A-Za-z0-9_\-.]*[A-Za-z0-9_\-])?$/;
const PN_PREFIX = /^([A-Za-z]([A-Za-z0-9_\-.]*[A-Za-z0-9_\-])?)?$/;

/** Returns `prefix:local` when the IRI can be safely abbreviated, else null. */
export function qname(iri: string, prefixes: Record<string, string>): string | null {
  let best: [string, string] | null = null;
  for (const [p, ns] of Object.entries(prefixes)) {
    if (!ns || !iri.startsWith(ns) || !PN_PREFIX.test(p)) continue;
    const local = iri.slice(ns.length);
    if (local !== '' && !PN_LOCAL.test(local)) continue;
    // Prefer the longest namespace, then a named prefix over the empty one, then alphabetical.
    if (!best || ns.length > best[1].length || (ns.length === best[1].length && (best[0] === '' || (p !== '' && p < best[0])))) {
      best = [p, ns];
    }
  }
  return best ? `${best[0]}:${iri.slice(best[1].length)}` : null;
}

/** Abbreviates an IRI with the given prefixes; returns the full IRI if no prefix applies. */
export function compactIRI(iri: string, prefixes: Record<string, string>): string {
  return qname(iri, prefixes) ?? iri;
}

/** Expands a CURIE (`vol:Volunteer`), `<iri>` or an IRI. Unknown prefixes are returned unchanged. */
export function expandIRI(curieOrIri: string, prefixes: Record<string, string>): string {
  const s = curieOrIri.trim();
  if (s.startsWith('<') && s.endsWith('>')) return s.slice(1, -1);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || s.startsWith('urn:')) return s;
  const i = s.indexOf(':');
  if (i >= 0) {
    const p = s.slice(0, i);
    const ns = prefixes[p] ?? (STANDARD_PREFIXES as Record<string, string>)[p];
    if (ns !== undefined) return ns + s.slice(i + 1);
  }
  return s;
}

/** Local name after the last '#', '/' or ':'. */
export function localName(iri: string): string {
  const m = /[^#/:]*$/.exec(iri);
  return m ? m[0] : iri;
}

/** Namespace part of an IRI (everything up to and including the last '#' or '/'). */
export function namespaceOf(iri: string): string {
  return iri.slice(0, iri.length - localName(iri).length);
}

export { isValidLocalName } from './termRules.js';

/** Splits "VolunteeringOpportunity" / "hasSkill" into "volunteering opportunity" / "has skill". */
export function humanize(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase();
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}
