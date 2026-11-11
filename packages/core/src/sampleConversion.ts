/** Offline conversion of the checked-in Solid vocabularies. Never rewrites an upstream file. */
import { DataFactory, Parser, Store } from 'n3';
import type { Term } from '@rdfjs/types';
import { NS, OWL2_DATATYPES, STANDARD_PREFIXES } from './ns.js';
import { writeTurtle } from './turtle.js';

const { namedNode: n, literal: l, quad, defaultGraph } = DataFactory;
const type = NS.rdf + 'type';
const cls = NS.owl + 'Class', obj = NS.owl + 'ObjectProperty', data = NS.owl + 'DatatypeProperty', ann = NS.owl + 'AnnotationProperty';
export interface ConversionSample {
  title: string; description: string; prefix: string; namespace: string; source: string; publisher: string;
  licence: { name: string; url: string }; upstreamCopy: string; changes: string;
}

/** Only the workflow copy uses N3's obsolete @keywords/default-name syntax. Tokenise so strings stay verbatim. */
function workflowTurtle(text: string): string {
  return text.replace(/^@keywords[^\n]*\n/m, '').replace(
    /"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\])*"(?:@[\w-]+)?|'(?:\\.|[^'\\])*'|<[^>]*>|#[^\n]*|(?:[\w-]*:[\w.-]*)|@[\w-]+|\b[A-Za-z][\w-]*\b/g,
    (token) => /^[A-Za-z][\w-]*$/.test(token) && !['a', 'true', 'false'].includes(token) ? `:${token}` : token,
  );
}

export function parseSampleSource(upstream: string, sample: ConversionSample): Store {
  const parser = new Parser({ baseIRI: sample.source, format: sample.upstreamCopy.endsWith('.nq') ? 'N-Quads' : 'text/turtle', blankNodePrefix: 'sample' });
  return new Store(parser.parse(sample.upstreamCopy === 'wf.ttl' ? workflowTurtle(upstream) : upstream));
}

export function convertSample(upstream: string, sample: ConversionSample): string {
  const parsed = parseSampleSource(upstream, sample).getQuads(null, null, null, null);
  const metadataNodes = new Map<string, ReturnType<typeof n>>();
  const skolem = (term: Term) => {
    if (term.termType !== 'BlankNode' || !['solid', 'ldp'].includes(sample.prefix)) return term;
    // N3's anonymous labels use a process-wide counter. Assign by encounter order in this source instead.
    if (!metadataNodes.has(term.value)) metadataNodes.set(term.value, n(`urn:concord:sample:${sample.prefix}:metadata-${metadataNodes.size + 1}`));
    return metadataNodes.get(term.value)!;
  };
  const raw = new Store(parsed.map((q) => quad(skolem(q.subject) as typeof q.subject, q.predicate, skolem(q.object) as typeof q.object)));
  const s = new Store();
  const kinds = new Map<string, Set<string>>();
  const addKind = (term: Term, kind: string) => {
    if (kind === cls && [NS.rdf, NS.rdfs, NS.owl].some((ns) => term.value.startsWith(ns))) return;
    if (term.termType !== 'NamedNode' || term.value.startsWith(NS.xsd) || [NS.rdfs + 'Literal', NS.owl + 'Thing', NS.owl + 'Nothing'].includes(term.value)) return;
    if (!kinds.has(term.value)) kinds.set(term.value, new Set());
    kinds.get(term.value)!.add(kind);
  };
  const isDatatype = (t: Term) => t.value.startsWith(NS.xsd) || t.value === NS.rdfs + 'Literal' || raw.countQuads(t, n(type), n(NS.rdfs + 'Datatype'), null) > 0;
  const classPreds = ['subClassOf', 'domain', 'disjointWith', 'equivalentClass'].map((p) => (p === 'subClassOf' || p === 'domain' ? NS.rdfs : NS.owl) + p);
  const propPreds = [NS.rdfs + 'subPropertyOf', NS.owl + 'equivalentProperty', NS.owl + 'inverseOf'];
  for (const q of raw) {
    if (q.predicate.value === type) {
      if ([cls, NS.rdfs + 'Class'].includes(q.object.value)) addKind(q.subject, cls);
      if ([obj, data, ann, NS.rdfs + 'Datatype'].includes(q.object.value)) addKind(q.subject, q.object.value);
      if (q.object.value === NS.rdf + 'Property') addKind(q.subject, 'property');
      if (!q.object.value.startsWith(NS.owl) && !q.object.value.startsWith(NS.rdf) && !q.object.value.startsWith(NS.rdfs)) addKind(q.object, cls);
    }
    if (classPreds.includes(q.predicate.value)) {
      if (q.predicate.value !== NS.rdfs + 'domain') addKind(q.subject, cls);
      addKind(q.object, cls);
    }
    if (q.predicate.value === NS.rdfs + 'range') {
      addKind(q.subject, 'property');
      if (!isDatatype(q.object)) addKind(q.object, cls);
    }
    if (q.predicate.value === NS.rdfs + 'domain') addKind(q.subject, 'property');
    if (propPreds.includes(q.predicate.value)) { addKind(q.subject, 'property'); addKind(q.object, 'property'); }
    if (q.predicate.value === NS.owl + 'onProperty') addKind(q.object, 'property');
    if ([NS.owl + 'someValuesFrom', NS.owl + 'allValuesFrom', NS.owl + 'onClass', NS.rdf + 'first'].includes(q.predicate.value) && !isDatatype(q.object)) {
      // RDF lists serve forms as well as class expressions: only class members are inferred below.
      if (q.predicate.value !== NS.rdf + 'first') addKind(q.object, cls);
    }
  }
  for (const p of ['label', 'comment', 'seeAlso', 'isDefinedBy']) addKind(n(NS.rdfs + p), ann);
  // Type every named class in a class-expression list (including otherwise undeclared external classes).
  for (const q of raw) if (['unionOf', 'intersectionOf', 'disjointUnionOf'].some((p) => q.predicate.value === NS.owl + p)) {
    addKind(q.subject, cls);
    let node: Term = q.object; const seen = new Set<string>();
    while (node.value !== NS.rdf + 'nil' && !seen.has(node.value)) {
      seen.add(node.value);
      for (const m of raw.getObjects(node, n(NS.rdf + 'first'), null)) addKind(m, cls);
      const rest: Term | undefined = raw.getObjects(node, n(NS.rdf + 'rest'), null)[0]; if (!rest) break; node = rest;
    }
  }
  // Metadata predicates are annotations. Schema properties retain their explicit kind; otherwise infer from ranges.
  for (const q of raw) if (![NS.rdf, NS.rdfs, NS.owl, NS.xsd].some((ns) => q.predicate.value.startsWith(ns))) addKind(q.predicate, 'property');
  for (const [iri, ks] of kinds) if (ks.has('property') || ks.has(obj) || ks.has(data) || ks.has(ann)) {
    const ranges = raw.getObjects(n(iri), n(NS.rdfs + 'range'), null);
    const usage = raw.getObjects(null, n(iri), null);
    const meta = [NS.dc, NS.dcterms, NS.vann, NS.prov, NS.skos, 'http://www.w3.org/2003/06/sw-vocab-status/ns#'].some((ns) => iri.startsWith(ns));
    const mixedValues = usage.some((t) => t.termType !== 'Literal') && (ks.has(data) || ranges.some(isDatatype));
    const metamodel = usage.some((t) => [NS.rdf + 'Property', NS.rdfs + 'Class', obj, data].includes(t.value)) || [...ranges, ...raw.getObjects(n(iri), n(NS.rdfs + 'domain'), null)].some((t) => [NS.rdfs + 'Class', NS.rdf + 'Class', NS.rdf + 'Property', NS.owl + 'Class', obj, data, NS.rdf + 'List', NS.rdf + 'Collection'].includes(t.value));
    let kind = ks.has(ann) || meta || metamodel || mixedValues || (ks.has(obj) && ks.has(data)) ? ann : ks.has(data) ? data : ks.has(obj) ? obj : ranges.length ? (ranges.every(isDatatype) ? data : obj) : ann;
    if (!meta && !metamodel && !ks.has(ann) && !ranges.length && !ks.has(obj) && !ks.has(data) && usage.length && usage.every((t) => t.termType !== 'Literal') && !ks.has(cls)) kind = obj;
    ks.delete('property'); ks.delete(obj); ks.delete(data); ks.delete(ann); ks.add(kind);
  }
  if (sample.prefix === 'ui') {
    for (const iri of ['parts', 'part', 'case', 'from', 'property', 'for', 'category', 'dependingOn']) {
      const ks = kinds.get(sample.namespace + iri); if (ks) { ks.delete(obj); ks.delete(data); ks.add(ann); }
    }
  }
  // Property hierarchies must use the same kind. Ambiguous families become annotations, preserving their IRIs.
  for (let changed = true; changed;) {
    changed = false;
    for (const q of raw) if (propPreds.includes(q.predicate.value) && q.subject.termType === 'NamedNode' && q.object.termType === 'NamedNode') {
      const a = kinds.get(q.subject.value)!, b = kinds.get(q.object.value)!;
      const ak = [obj, data, ann].find((k) => a.has(k)), bk = [obj, data, ann].find((k) => b.has(k));
      if (ak !== bk) for (const ks of [a, b]) if (!ks.has(ann)) { ks.delete(obj); ks.delete(data); ks.add(ann); changed = true; }
    }
  }
  // RDF collections used as application data have no OWL axiom consuming them. Omit those embedded forms;
  // keep every named vocabulary term and the original descriptions, with the complete forms in upstream/.
  const axiomLists = new Set<string>();
  for (const q of raw) if (['unionOf', 'intersectionOf', 'disjointUnionOf'].some((p) => q.predicate.value === NS.owl + p)) {
    let node: Term = q.object;
    while (!axiomLists.has(node.value) && node.value !== NS.rdf + 'nil') {
      axiomLists.add(node.value);
      const rest: Term | undefined = raw.getObjects(node, n(NS.rdf + 'rest'), null)[0]; if (!rest) break; node = rest;
    }
  }
  const applicationLists = new Set(raw.getSubjects(n(NS.rdf + 'first'), null, null).filter((t) => !axiomLists.has(t.value)).map((t) => t.value));
  const headers = new Set([sample.source, ...raw.getSubjects(n(type), n(NS.owl + 'Ontology'), null).map((t) => t.value)]);
  for (const q of raw) {
    const p = q.predicate.value, ks = kinds.get(q.subject.value);
    if (applicationLists.has(q.subject.value) || applicationLists.has(q.object.value)) continue;
    if (p === type && [cls, NS.rdfs + 'Class', obj, data, ann, NS.rdf + 'Property', NS.rdfs + 'Datatype', NS.owl + 'Ontology'].includes(q.object.value)) continue;
    if (p === type && q.object.value === NS.owl + 'Individual') { s.addQuad(q.subject, n(type), n(NS.owl + 'NamedIndividual')); continue; }
    if (p === type && q.object.value === NS.owl + 'InverseFunctionalProperty' && ks?.has(data)) continue;
    if ([...classPreds, NS.rdfs + 'range'].includes(p) && q.object.termType === 'NamedNode' && [NS.rdf, NS.rdfs, NS.owl].some((ns) => q.object.value.startsWith(ns)) && ![NS.owl + 'Thing', NS.owl + 'Nothing', NS.rdfs + 'Literal'].includes(q.object.value)) continue;
    if (p === NS.owl + 'imports') continue; // The offline sample declares its references locally.
    if (ks?.has(ann) && [NS.rdfs + 'domain', NS.rdfs + 'range', ...propPreds].includes(p)) continue;
    if (p === type && q.object.value.endsWith('Property') && ks?.has(ann)) continue;
    if (p === NS.owl + 'inverseOf' && q.object.termType === 'BlankNode') continue;
    // ui:Color's named facet node is invalid in the OWL RDF mapping; keep its description, widen its value space.
    if (sample.prefix === 'ui' && [NS.owl + 'onDatatype', NS.owl + 'withRestrictions', NS.xsd + 'pattern'].includes(p)) continue;
    let object = q.object;
    if (object.termType === 'Literal' && !OWL2_DATATYPES.has(object.datatype.value)) object = l(object.value);
    if (p === NS.rdfs + 'range' && ks?.has(data) && object.termType === 'NamedNode' && (!isDatatype(object) || (!OWL2_DATATYPES.has(object.value) && object.value !== NS.rdfs + 'Literal'))) object = n(NS.rdfs + 'Literal');
    const subject = headers.has(q.subject.value) ? n(sample.source) : q.subject;
    s.addQuad(quad(subject, q.predicate, object, defaultGraph()));
  }
  for (const [iri, ks] of kinds) for (const kind of ks) s.addQuad(n(iri), n(type), n(kind));
  if (sample.prefix === 'ui') s.addQuad(n(sample.namespace + 'Color'), n(NS.owl + 'equivalentClass'), n(NS.xsd + 'string'));
  s.addQuad(n(sample.source), n(type), n(NS.owl + 'Ontology'));
  for (const [p, value] of [
    [NS.dcterms + 'title', l(sample.title, 'en')],
    [NS.dcterms + 'description', l(sample.description, 'en')],
    [NS.dcterms + 'source', n(sample.source)], [NS.prov + 'wasDerivedFrom', n(sample.source)],
    [NS.dcterms + 'license', n(sample.licence.url)], [NS.dcterms + 'rights', l(`Original vocabulary published by ${sample.publisher}.`) ],
    [NS.rdfs + 'comment', l(`Concord sample copy for trying Concord. ${sample.changes}`, 'en')],
    [NS.vann + 'preferredNamespacePrefix', l(sample.prefix)], [NS.vann + 'preferredNamespaceUri', n(sample.namespace)],
  ] as const) { s.addQuad(n(sample.source), n(p), value); if (![NS.rdfs, NS.owl].some((ns) => p.startsWith(ns))) s.addQuad(n(p), n(type), n(ann)); }
  // Remove anonymous form fragments whose only incoming edge was an omitted application list.
  const reached = new Set<string>();
  const visit = (term: Term) => {
    if (term.termType !== 'BlankNode' || reached.has(term.value)) return;
    reached.add(term.value);
    for (const q of s.getQuads(term, null, null, null)) visit(q.object);
  };
  for (const q of s) if (q.subject.termType === 'NamedNode') visit(q.object);
  for (const q of s.getQuads(null, null, null, null)) if (q.subject.termType === 'BlankNode' && !reached.has(q.subject.value)) s.removeQuad(q);
  for (const q of raw) for (const term of [q.subject, q.predicate, q.object]) if (term.termType === 'NamedNode' && term.value.startsWith(sample.namespace) && !s.countQuads(term, n(type), null, null)) s.addQuad(term, n(type), n(NS.owl + 'NamedIndividual'));
  // Widen unsupported members of datatype unions without leaving an orphan expression.
  for (const q of s.getQuads(null, n(NS.rdf + 'first'), null, null)) if (q.object.value.startsWith(NS.xsd) && !OWL2_DATATYPES.has(q.object.value)) { s.removeQuad(q); s.addQuad(q.subject, q.predicate, n(NS.rdfs + 'Literal')); }
  // Preserve original labels; supply browse labels only where the source has none.
  for (const [iri, ks] of kinds) if (iri.startsWith(sample.namespace) && [cls, obj, data].some((k) => ks.has(k)) && !s.countQuads(n(iri), n(NS.rdfs + 'label'), null, null)) {
    const original = raw.getObjects(n(iri), n(sample.namespace + 'label'), null).find((t) => t.termType === 'Literal');
    s.addQuad(n(iri), n(NS.rdfs + 'label'), original ?? l(iri.slice(sample.namespace.length), 'en'));
  }
  return `# Concord sample copy for trying Concord: ${sample.title}\n# Source: ${sample.source}\n# Publisher: ${sample.publisher}\n# Licence: ${sample.licence.name} <${sample.licence.url}>\n# Upstream copy: upstream/${sample.upstreamCopy} (see upstream/SOURCES.md)\n# Changes: ${sample.changes}\n\n` + writeTurtle(s, { ...STANDARD_PREFIXES, [sample.prefix]: sample.namespace }, { ontologyIRI: sample.source });
}
