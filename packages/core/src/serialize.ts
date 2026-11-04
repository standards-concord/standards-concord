/**
 * Serialisation to all supported output formats, including a small
 * deterministic RDF/XML writer (striped syntax, one node element per subject).
 */
import type { Store, Term, Literal, Quad } from 'n3';
import type { OutputFormat } from './types.js';
import { NS, RDF_TYPE, isSafeNamespace, isSafePrefix } from './ns.js';
import { canonical, nn, readList } from './rdf.js';
import { writeNTriples } from './turtle.js';
import type { OntologyGraph } from './graph.js';
import { toManchester } from './manchester.js';
import { toLinkML } from './linkml.js';
import { toShacl, toShaclc } from './shacl.js';
import { toWrapperClasses, withWrapperImport } from './codegen.js';
import { noRemoteDocuments } from './jsonld-loader.js';

export const FORMAT_INFO: Record<OutputFormat, { label: string; mediaType: string; extension: string }> = {
  turtle: { label: 'Turtle', mediaType: 'text/turtle', extension: 'ttl' },
  ntriples: { label: 'N-Triples', mediaType: 'application/n-triples', extension: 'nt' },
  rdfxml: { label: 'RDF/XML', mediaType: 'application/rdf+xml', extension: 'owl' },
  jsonld: { label: 'JSON-LD', mediaType: 'application/ld+json', extension: 'jsonld' },
  manchester: { label: 'Manchester syntax', mediaType: 'text/owl-manchester', extension: 'omn' },
  linkml: { label: 'LinkML (YAML)', mediaType: 'application/x-yaml', extension: 'linkml.yaml' },
  shacl: { label: 'SHACL shapes (Turtle)', mediaType: 'text/turtle', extension: 'shacl.ttl' },
  shaclc: { label: 'SHACL compact syntax', mediaType: 'text/shaclc', extension: 'shaclc' },
  typescript: { label: 'TypeScript classes', mediaType: 'application/typescript', extension: 'ts' },
  javascript: { label: 'JavaScript classes', mediaType: 'text/javascript', extension: 'js' },
};

/**
 * `name` names the generated classes' dataset wrapper (the project slug, so
 * the app and the public module export the same names); without it the name
 * comes from the ontology IRI.
 */
export async function serialize(graph: OntologyGraph, format: OutputFormat, opts: { name?: string } = {}): Promise<string> {
  switch (format) {
    case 'turtle': return graph.toTurtle();
    case 'ntriples': return writeNTriples(graph.store);
    case 'rdfxml': return writeRdfXml(graph.store, graph.prefixes, graph.ontologyIRI);
    case 'jsonld': return writeJsonLd(graph);
    case 'manchester': return toManchester(graph);
    case 'linkml': return toLinkML(graph);
    case 'shacl': return toShacl(graph);
    case 'shaclc': return toShaclc(graph);
    case 'typescript': return (await toWrapperClasses(graph, { name: opts.name })).ts;
    // Ready for a browser: @rdfjs/wrapper comes from a CDN (the npm package uses the bare import).
    case 'javascript': return withWrapperImport((await toWrapperClasses(graph, { name: opts.name })).js);
    default: throw new Error(`unsupported format ${format as string}`);
  }
}

/* ------------------------------------------------------------------------ */
/* JSON-LD                                                                   */
/* ------------------------------------------------------------------------ */

async function writeJsonLd(graph: OntologyGraph): Promise<string> {
  const jsonld = (await import('jsonld')).default;
  const nquads = writeNTriples(graph.store);
  const expanded = await jsonld.fromRDF(nquads as any, { format: 'application/n-quads', useNativeTypes: false });
  const used = new Set<string>();
  for (const q of graph.store.getQuads(null, null, null, null)) for (const t of [q.subject, q.predicate, q.object, (q.object as any).datatype]) if (t?.value) used.add(t.value);
  const context: Record<string, string> = {};
  for (const [p, ns] of Object.entries(graph.prefixes).sort(([a], [b]) => a.localeCompare(b))) {
    // Only safe prefixes: a keyword such as @import would make a JSON-LD processor load a context.
    if (p && isSafePrefix(p) && isSafeNamespace(ns) && [...used].some((u) => u.startsWith(ns))) context[p] = ns;
  }
  const compacted = await jsonld.compact(expanded, context as any, { documentLoader: noRemoteDocuments as any });
  return JSON.stringify(sortKeys(compacted), null, 2) + '\n';
}

/** Sorts object keys and node arrays for stable output (never reorders @list members). */
function sortKeys(x: unknown, parentKey = ''): unknown {
  if (Array.isArray(x)) {
    const items = x.map((i) => sortKeys(i));
    if (parentKey === '@list') return items;
    return items.every((i) => i && typeof i === 'object' && '@id' in (i as object))
      ? items.sort((a: any, b: any) => String(a['@id']).localeCompare(String(b['@id'])))
      : items;
  }
  if (x && typeof x === 'object') {
    const keys = Object.keys(x as object).sort((a, b) => (a.startsWith('@') === b.startsWith('@') ? a.localeCompare(b) : a.startsWith('@') ? -1 : 1));
    return Object.fromEntries(keys.map((k) => [k, sortKeys((x as any)[k], k)]));
  }
  return x;
}

/* ------------------------------------------------------------------------ */
/* RDF/XML                                                                   */
/* ------------------------------------------------------------------------ */

const NCNAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

const xmlEscape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\r/g, '&#13;');

/**
 * Writes RDF/XML. Subjects are node elements typed with their first rdf:type
 * (when it has a QName), single-use blank nodes are nested, lists of resources
 * use rdf:parseType="Collection", other blank nodes get rdf:nodeID.
 */
export function writeRdfXml(store: Store, prefixes: Record<string, string>, ontologyIRI?: string): string {
  const quads = store.getQuads(null, null, null, null) as Quad[];
  const nsDecl = new Map<string, string>([['rdf', NS.rdf]]); // prefix -> namespace
  const byNs = new Map<string, string>([[NS.rdf, 'rdf']]);
  for (const [p, ns] of Object.entries(prefixes)) {
    if (p && NCNAME.test(p) && !p.toLowerCase().startsWith('xml') && !byNs.has(ns)) byNs.set(ns, p);
  }
  let gen = 0;
  const qn = (iri: string): string | null => {
    // Split so the local part is a valid NCName.
    const m = /[A-Za-z_][A-Za-z0-9_.-]*$/.exec(iri);
    if (!m) return null;
    let ns = iri.slice(0, m.index);
    let local = m[0];
    // Prefer a declared namespace that covers more of the IRI.
    for (const [cand] of byNs) if (iri.startsWith(cand) && NCNAME.test(iri.slice(cand.length)) && cand.length > ns.length) { ns = cand; local = iri.slice(cand.length); }
    if (!ns || !local) return null;
    let p = byNs.get(ns);
    if (!p) {
      p = `ns${gen++}`;
      byNs.set(ns, p);
    }
    nsDecl.set(p, ns);
    return `${p}:${local}`;
  };

  const refCount = new Map<string, number>();
  for (const q of quads) if (q.object.termType === 'BlankNode') refCount.set(q.object.value, (refCount.get(q.object.value) ?? 0) + 1);
  const nodeIds = new Map<string, string>();
  const nodeId = (b: string) => {
    if (!nodeIds.has(b)) nodeIds.set(b, `n${nodeIds.size}`);
    return nodeIds.get(b)!;
  };
  const nested = new Set<string>();
  const ind = (n: number) => '  '.repeat(n);
  const sortQuads = (qs: Quad[]) =>
    [...qs].sort((a, b) => a.predicate.value.localeCompare(b.predicate.value) || canonical(store, a.object as Term).localeCompare(canonical(store, b.object as Term)));

  const nodeElement = (s: Term, depth: number, withAbout: boolean): string => {
    const qs = sortQuads(store.getQuads(s, null, null, null) as Quad[]);
    const typeQ = qs.find((q) => q.predicate.value === RDF_TYPE && q.object.termType === 'NamedNode' && qn(q.object.value));
    const tag = typeQ ? qn(typeQ.object.value)! : 'rdf:Description';
    let attrs = '';
    if (withAbout) {
      if (s.termType === 'NamedNode') attrs = ` rdf:about="${xmlEscape(s.value)}"`;
      else attrs = ` rdf:nodeID="${nodeId(s.value)}"`;
    }
    const props = qs.filter((q) => q !== typeQ).map((q) => propertyElement(q, depth + 1));
    if (!props.length) return `${ind(depth)}<${tag}${attrs}/>`;
    return `${ind(depth)}<${tag}${attrs}>\n${props.join('\n')}\n${ind(depth)}</${tag}>`;
  };

  const propertyElement = (q: Quad, depth: number): string => {
    const p = qn(q.predicate.value);
    if (!p) throw new Error(`cannot write predicate <${q.predicate.value}> in RDF/XML (no NCName local part)`);
    const o = q.object as Term;
    if (o.termType === 'NamedNode') return `${ind(depth)}<${p} rdf:resource="${xmlEscape(o.value)}"/>`;
    if (o.termType === 'Literal') {
      const l = o as Literal;
      const attr = l.language ? ` xml:lang="${l.language}"` : l.datatype && l.datatype.value !== NS.xsd + 'string' ? ` rdf:datatype="${xmlEscape(l.datatype.value)}"` : '';
      return `${ind(depth)}<${p}${attr}>${xmlEscape(l.value)}</${p}>`;
    }
    // Blank node object.
    if ((refCount.get(o.value) ?? 0) === 1) {
      const items = readList(store, o);
      if (items && items.every((i) => i.termType !== 'Literal') && listNodesClean(o)) {
        nested.add(o.value);
        markList(o);
        const inner = items.map((i) => (i.termType === 'NamedNode'
          ? `${ind(depth + 1)}<rdf:Description rdf:about="${xmlEscape(i.value)}"/>`
          : nestBlank(i, depth + 1)));
        return `${ind(depth)}<${p} rdf:parseType="Collection">\n${inner.join('\n')}\n${ind(depth)}</${p}>`;
      }
      return `${ind(depth)}<${p}>\n${nestBlank(o, depth + 1)}\n${ind(depth)}</${p}>`;
    }
    return `${ind(depth)}<${p} rdf:nodeID="${nodeId(o.value)}"/>`;
  };

  const nestBlank = (b: Term, depth: number): string => {
    if ((refCount.get(b.value) ?? 0) > 1) return `${ind(depth)}<rdf:Description rdf:nodeID="${nodeId(b.value)}"/>`;
    nested.add(b.value);
    return nodeElement(b, depth, false);
  };
  const listNodesClean = (head: Term): boolean => {
    let n: Term = head;
    while (n.termType === 'BlankNode') {
      if (store.countQuads(n, null, null, null) !== 2 || (refCount.get(n.value) ?? 0) !== 1) return false;
      n = store.getObjects(n, nn(NS.rdf + 'rest'), null)[0];
    }
    return true;
  };
  const markList = (head: Term) => {
    let n: Term = head;
    while (n.termType === 'BlankNode') {
      nested.add(n.value);
      n = store.getObjects(n, nn(NS.rdf + 'rest'), null)[0];
    }
  };

  // Ontology first, then named subjects sorted, then root blank nodes and shared blank nodes.
  const named = [...new Set(quads.filter((q) => q.subject.termType === 'NamedNode').map((q) => q.subject.value))]
    .sort((a, b) => (a === ontologyIRI ? -1 : b === ontologyIRI ? 1 : a < b ? -1 : a > b ? 1 : 0));
  const body: string[] = named.map((s) => nodeElement(nn(s), 1, true));
  const blankSubjects = [...new Set(quads.filter((q) => q.subject.termType === 'BlankNode').map((q) => q.subject))]
    .filter((b, i, arr) => arr.findIndex((x) => x.value === b.value) === i)
    .sort((a, b) => canonical(store, a as Term).localeCompare(canonical(store, b as Term)));
  // Single-use blank nodes are always nested inside their referrer; emit roots and shared nodes here.
  for (const b of blankSubjects) {
    const refs = refCount.get(b.value) ?? 0;
    if (refs === 1 || nested.has(b.value)) continue;
    body.push(nodeElement(b as Term, 1, refs > 0));
  }

  const xmlns = [...nsDecl.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([p, ns]) => `\n    xmlns:${p}="${xmlEscape(ns)}"`).join('');
  return `<?xml version="1.0" encoding="utf-8"?>\n<rdf:RDF${xmlns}>\n${body.join('\n\n')}\n</rdf:RDF>\n`;
}

