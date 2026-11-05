/**
 * OntologyGraph: an OWL ontology held as RDF in an N3.js Store, plus the
 * read-only `OntologyView` projection used for display, diffing and linting.
 */
import { Parser, Store } from 'n3';
import type { Quad, Term, Literal } from 'n3';
import type {
  ClassView, IndividualView, IRI, OntologyMetadata, OntologyView, PropertyCharacteristic,
  PropertyView, Restriction, TermAnnotations, TermView,
} from './types.js';
import { NS, RDF_TYPE, STANDARD_PREFIXES, isSafeNamespace, isSafePrefix, localName, today } from './ns.js';
import {
  cloneStore, firstObject, hasType, langLit, manchesterExpr, namedNode, nn, objects, readList,
  subjects, typedLit, quad, defaultGraph,
} from './rdf.js';
import { writeTurtle } from './turtle.js';
import { REMOTE_REFUSED, noRemoteDocuments } from './jsonld-loader.js';

export const CHARACTERISTIC_TYPES: Record<PropertyCharacteristic, string> = {
  functional: NS.owl + 'FunctionalProperty',
  inverseFunctional: NS.owl + 'InverseFunctionalProperty',
  transitive: NS.owl + 'TransitiveProperty',
  symmetric: NS.owl + 'SymmetricProperty',
  asymmetric: NS.owl + 'AsymmetricProperty',
  reflexive: NS.owl + 'ReflexiveProperty',
  irreflexive: NS.owl + 'IrreflexiveProperty',
};

export const MAPPING_PROPERTIES = [
  NS.skos + 'exactMatch', NS.skos + 'closeMatch', NS.skos + 'broadMatch', NS.skos + 'narrowMatch',
  NS.skos + 'relatedMatch', NS.rdfs + 'seeAlso',
];

/** Annotation predicates projected into TermAnnotations (everything else on a term is "other"). */
export const P = {
  label: NS.rdfs + 'label',
  comment: NS.rdfs + 'comment',
  definition: NS.skos + 'definition',
  iaoDefinition: NS.obo + 'IAO_0000115',
  altLabel: NS.skos + 'altLabel',
  example: NS.skos + 'example',
  editorialNote: NS.skos + 'editorialNote',
  historyNote: NS.skos + 'historyNote',
  source: NS.dcterms + 'source',
  isDefinedBy: NS.rdfs + 'isDefinedBy',
  deprecated: NS.owl + 'deprecated',
  replacedBy: NS.dcterms + 'isReplacedBy',
  iaoReplacedBy: NS.obo + 'IAO_0100001',
  subClassOf: NS.rdfs + 'subClassOf',
  equivalentClass: NS.owl + 'equivalentClass',
  disjointWith: NS.owl + 'disjointWith',
  domain: NS.rdfs + 'domain',
  range: NS.rdfs + 'range',
  subPropertyOf: NS.rdfs + 'subPropertyOf',
  inverseOf: NS.owl + 'inverseOf',
  members: NS.owl + 'members',
  created: NS.dcterms + 'created',
  contributor: NS.dcterms + 'contributor',
} as const;

export const T = {
  Ontology: NS.owl + 'Ontology',
  Class: NS.owl + 'Class',
  RdfsClass: NS.rdfs + 'Class',
  ObjectProperty: NS.owl + 'ObjectProperty',
  DatatypeProperty: NS.owl + 'DatatypeProperty',
  AnnotationProperty: NS.owl + 'AnnotationProperty',
  NamedIndividual: NS.owl + 'NamedIndividual',
  Restriction: NS.owl + 'Restriction',
  AllDisjointClasses: NS.owl + 'AllDisjointClasses',
  Datatype: NS.rdfs + 'Datatype',
  Thing: NS.owl + 'Thing',
  Nothing: NS.owl + 'Nothing',
} as const;

export interface EmptyOntologyOptions {
  iri: string;
  namespace: string;
  prefix: string;
  title: string;
  description?: string;
  creators?: string[];
  license?: string;
  /** Addition: dcat:keyword values. */
  keywords?: string[];
}

const DEFAULT_LICENSE = 'https://creativecommons.org/licenses/by/4.0/';

/** IRI-valued metadata (license/creator) is stored as an IRI when it looks like one. */
export function looksLikeIRI(s: string): boolean {
  return /^(https?|urn|ftp):/i.test(s.trim()) && !/\s/.test(s.trim());
}

export class OntologyGraph {
  readonly store: Store;
  readonly prefixes: Record<string, string>;

  constructor(store: Store, prefixes: Record<string, string> = {}) {
    this.store = store;
    this.prefixes = { ...STANDARD_PREFIXES, ...prefixes };
    // Make sure the preferred prefix is usable for output.
    const pref = this.literalOf(this.ontologyIRI, NS.vann + 'preferredNamespacePrefix');
    // Only a well-formed prefix: one from editable metadata such as "@import" must never reach a JSON-LD context.
    if (pref && isSafePrefix(pref) && !(pref in this.prefixes) && this.namespace && isSafeNamespace(this.namespace)) this.prefixes[pref] = this.namespace;
  }

  /* ---------------------------------------------------------------------- */
  /* Construction                                                            */
  /* ---------------------------------------------------------------------- */

  /** Parses Turtle (or RDF/XML when the text looks like XML). */
  static async fromTurtle(turtle: string, baseIRI?: string): Promise<OntologyGraph> {
    const head = turtle.trimStart();
    if (head.startsWith('<?xml') || head.startsWith('<rdf:RDF')) return parseRdfXml(turtle, baseIRI);
    return parseN3(turtle, 'Turtle', baseIRI);
  }

  static async parse(text: string, format: 'turtle' | 'rdfxml' | 'jsonld' | 'ntriples'): Promise<OntologyGraph> {
    switch (format) {
      case 'turtle': return OntologyGraph.fromTurtle(text);
      case 'ntriples': return parseN3(text, 'N-Triples');
      case 'rdfxml': return parseRdfXml(text);
      case 'jsonld': return parseJsonLd(JSON.parse(text));
      default: throw new Error(`Unsupported input format: ${format as string}`);
    }
  }

  /** A new ontology with a FAIR header (title, description, license, creators, versioning, vann). */
  static empty(opts: EmptyOntologyOptions): OntologyGraph {
    const store = new Store();
    const o = nn(opts.iri);
    const add = (p: string, obj: Term) => store.addQuad(o, nn(p), obj as any);
    const date = today();
    add(RDF_TYPE, nn(T.Ontology));
    add(NS.dcterms + 'title', langLit(opts.title));
    if (opts.description) add(NS.dcterms + 'description', langLit(opts.description));
    add(NS.dcterms + 'license', nn(opts.license ?? DEFAULT_LICENSE));
    for (const c of opts.creators ?? []) add(NS.dcterms + 'creator', looksLikeIRI(c) ? nn(c) : typedLit(c, NS.xsd + 'string'));
    add(NS.dcterms + 'created', typedLit(date, NS.xsd + 'date'));
    add(NS.dcterms + 'modified', typedLit(date, NS.xsd + 'date'));
    add(NS.owl + 'versionInfo', typedLit('0.1.0', NS.xsd + 'string'));
    add(NS.owl + 'versionIRI', nn(`${opts.iri.replace(/[#/]$/, '')}/0.1.0`));
    add(NS.vann + 'preferredNamespacePrefix', typedLit(opts.prefix, NS.xsd + 'string'));
    add(NS.vann + 'preferredNamespaceUri', typedLit(opts.namespace, NS.xsd + 'anyURI'));
    for (const k of opts.keywords ?? []) add(NS.dcat + 'keyword', langLit(k));
    const who = (opts.creators ?? []).filter((c) => !looksLikeIRI(c)).join(', ');
    add(NS.dcterms + 'bibliographicCitation',
      typedLit(`${who ? who + '. ' : ''}${opts.title}. Version 0.1.0. ${opts.iri}`, NS.xsd + 'string'));
    declareAnnotationProperties(store, [
      NS.dcterms + 'title', NS.dcterms + 'description', NS.dcterms + 'license', NS.dcterms + 'creator',
      NS.dcterms + 'created', NS.dcterms + 'modified', NS.dcterms + 'bibliographicCitation',
      NS.vann + 'preferredNamespacePrefix', NS.vann + 'preferredNamespaceUri', NS.skos + 'definition',
      ...(opts.keywords?.length ? [NS.dcat + 'keyword'] : []),
    ]);
    return new OntologyGraph(store, { [opts.prefix]: opts.namespace });
  }

  clone(): OntologyGraph {
    return new OntologyGraph(cloneStore(this.store), this.prefixes);
  }

  /* ---------------------------------------------------------------------- */
  /* Basic accessors                                                         */
  /* ---------------------------------------------------------------------- */

  get size(): number {
    return this.store.size;
  }

  get ontologyIRI(): string {
    const onts = subjects(this.store, RDF_TYPE, T.Ontology).filter((t) => t.termType === 'NamedNode').map((t) => t.value).sort();
    return onts[0] ?? '';
  }

  get namespace(): string {
    const iri = this.ontologyIRI;
    const declared = iri ? this.literalOf(iri, NS.vann + 'preferredNamespaceUri') : undefined;
    if (declared) return declared;
    if (!iri) return '';
    if (/[#/]$/.test(iri)) return iri;
    // A declared prefix for "<iri>#" or "<iri>/" wins over the default hash namespace.
    for (const sep of ['#', '/']) if (Object.values(this.prefixes).includes(iri + sep)) return iri + sep;
    return iri + '#';
  }

  toTurtle(): Promise<string> {
    return Promise.resolve(writeTurtle(this.store, this.prefixes, { ontologyIRI: this.ontologyIRI }));
  }

  /** First literal value of a predicate (or IRI value), preferring @en. */
  literalOf(s: string, p: string): string | undefined {
    if (!s) return undefined;
    return pickPreferred(objects(this.store, s, p));
  }

  /** The declared kinds of an IRI in this graph. */
  kindsOf(iri: string): Set<TermView['kind']> {
    const kinds = new Set<TermView['kind']>();
    const types = objects(this.store, iri, RDF_TYPE).map((t) => t.value);
    for (const t of types) {
      if (t === T.Class || t === T.RdfsClass) kinds.add('class');
      else if (t === T.ObjectProperty || (Object.values(CHARACTERISTIC_TYPES).includes(t) && t !== CHARACTERISTIC_TYPES.functional)) kinds.add('objectProperty');
      else if (t === T.DatatypeProperty) kinds.add('datatypeProperty');
      else if (t === T.AnnotationProperty) kinds.add('annotationProperty');
      else if (t === T.NamedIndividual) kinds.add('individual');
    }
    if (!kinds.has('individual') && types.some((t) => this.isClassIri(t))) kinds.add('individual');
    return kinds;
  }

  /** True when the IRI is declared (has any rdf:type) in this graph. */
  isDeclared(iri: string): boolean {
    return this.store.countQuads(nn(iri), nn(RDF_TYPE), null, null) > 0;
  }

  isClassIri(iri: string): boolean {
    return hasType(this.store, iri, T.Class) || hasType(this.store, iri, T.RdfsClass);
  }

  /* ---------------------------------------------------------------------- */
  /* View projection                                                         */
  /* ---------------------------------------------------------------------- */

  view(): OntologyView {
    const named = (type: string) =>
      subjects(this.store, RDF_TYPE, type).filter((t) => t.termType === 'NamedNode').map((t) => t.value);
    const uniqSorted = (xs: string[]) => [...new Set(xs)].sort();
    const ont = this.ontologyIRI;

    const classIris = uniqSorted([...named(T.Class), ...named(T.RdfsClass)].filter((i) => i !== T.Thing && i !== T.Nothing));
    const objIris = uniqSorted([
      ...named(T.ObjectProperty),
      ...Object.entries(CHARACTERISTIC_TYPES).filter(([k]) => k !== 'functional').flatMap(([, t]) => named(t)),
    ]);
    const dtIris = uniqSorted(named(T.DatatypeProperty));
    const apIris = uniqSorted(named(T.AnnotationProperty));
    const classSet = new Set(classIris);
    const indIris = uniqSorted([
      ...named(T.NamedIndividual),
      ...this.store.getQuads(null, nn(RDF_TYPE), null, null)
        .filter((q) => q.subject.termType === 'NamedNode' && classSet.has(q.object.value))
        .map((q) => q.subject.value),
    ]).filter((i) => i !== ont);

    return {
      metadata: this.metadata(),
      classes: classIris.map((i) => this.classView(i)),
      objectProperties: objIris.map((i) => this.propertyView(i, 'objectProperty')),
      datatypeProperties: dtIris.map((i) => this.propertyView(i, 'datatypeProperty')),
      annotationProperties: apIris.map((i) => this.propertyView(i, 'annotationProperty')),
      individuals: indIris.map((i) => this.individualView(i)),
      prefixes: { ...this.prefixes },
      tripleCount: this.size,
    };
  }

  term(iri: string): TermView | undefined {
    const kinds = this.kindsOf(iri);
    if (kinds.has('class')) return this.classView(iri);
    if (kinds.has('objectProperty')) return this.propertyView(iri, 'objectProperty');
    if (kinds.has('datatypeProperty')) return this.propertyView(iri, 'datatypeProperty');
    if (kinds.has('annotationProperty')) return this.propertyView(iri, 'annotationProperty');
    if (kinds.has('individual')) return this.individualView(iri);
    return undefined;
  }

  /** Ranked fuzzy search over labels, alt labels, local names and definitions. */
  search(query: string, limit = 20): TermView[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const tokens = q.split(/\s+/);
    const v = this.view();
    const all: TermView[] = [...v.classes, ...v.objectProperties, ...v.datatypeProperties, ...v.annotationProperties, ...v.individuals];
    const scored: [number, TermView][] = [];
    for (const t of all) {
      const label = (t.label ?? '').toLowerCase();
      const ln = localName(t.iri).toLowerCase();
      const alts = (t.altLabels ?? []).map((a) => a.toLowerCase());
      const def = (t.definition ?? '').toLowerCase();
      let score = 0;
      if (label === q || ln === q.replace(/\s+/g, '')) score = 100;
      else if (alts.includes(q)) score = 90;
      else if (label.startsWith(q) || ln.startsWith(q.replace(/\s+/g, ''))) score = 80;
      else if (label.includes(q) || ln.includes(q.replace(/\s+/g, ''))) score = 70;
      else if (alts.some((a) => a.includes(q))) score = 60;
      else {
        const hay = [label, ln, ...alts].join(' ');
        const hits = tokens.filter((tok) => hay.includes(tok)).length;
        const defHits = tokens.filter((tok) => def.includes(tok)).length;
        if (hits === tokens.length) score = 50;
        else if (hits + defHits >= tokens.length) score = 30 + hits;
        else if (hits > 0 || defHits > 0) score = 10 + hits * 2 + defHits;
        else if (isSubsequence(q.replace(/\s+/g, ''), ln)) score = 5;
      }
      if (score > 0) scored.push([score - (t.deprecated ? 20 : 0), t]);
    }
    return scored.sort((a, b) => b[0] - a[0] || a[1].iri.localeCompare(b[1].iri)).slice(0, limit).map((x) => x[1]);
  }

  metadata(): OntologyMetadata {
    const iri = this.ontologyIRI;
    const lit = (p: string) => this.literalOf(iri, p);
    const all = (p: string) => (iri ? objects(this.store, iri, p).map((t) => this.agentName(t)) : []).sort();
    return clean({
      iri,
      versionIRI: lit(NS.owl + 'versionIRI'),
      versionInfo: lit(NS.owl + 'versionInfo'),
      priorVersion: lit(NS.owl + 'priorVersion'),
      backwardCompatibleWith: iri ? objects(this.store, iri, NS.owl + 'backwardCompatibleWith').map((t) => t.value).sort() : [],
      incompatibleWith: iri ? objects(this.store, iri, NS.owl + 'incompatibleWith').map((t) => t.value).sort() : [],
      title: lit(NS.dcterms + 'title') ?? lit(NS.dc + 'title') ?? lit(P.label),
      description: lit(NS.dcterms + 'description') ?? lit(NS.dc + 'description') ?? lit(P.comment),
      license: lit(NS.dcterms + 'license') ?? lit(NS.dc + 'rights') ?? lit(NS.dcterms + 'rights'),
      creators: [...all(NS.dcterms + 'creator'), ...all(NS.dc + 'creator')],
      contributors: [...all(NS.dcterms + 'contributor'), ...all(NS.dc + 'contributor')],
      publisher: lit(NS.dcterms + 'publisher') ?? lit(NS.dc + 'publisher'),
      created: lit(NS.dcterms + 'created'),
      modified: lit(NS.dcterms + 'modified'),
      issued: lit(NS.dcterms + 'issued'),
      preferredPrefix: lit(NS.vann + 'preferredNamespacePrefix'),
      preferredNamespace: lit(NS.vann + 'preferredNamespaceUri'),
      imports: iri ? objects(this.store, iri, NS.owl + 'imports').map((t) => t.value).sort() : [],
    }) as OntologyMetadata;
  }

  private agentName(t: Term): string {
    if (t.termType === 'BlankNode') {
      return pickPreferred([...objects(this.store, t, NS.foaf + 'name'), ...objects(this.store, t, NS.schema + 'name'), ...objects(this.store, t, P.label)]) ?? '';
    }
    return t.value;
  }

  private annotations(iri: string): TermAnnotations & { deprecated?: boolean; replacedBy?: IRI } {
    const s = this.store;
    const vals = (p: string) => sortedValues(objects(s, iri, p).filter(isEnOrPlain));
    const mappings: Record<IRI, IRI[]> = {};
    for (const p of MAPPING_PROPERTIES) {
      const v = objects(s, iri, p).filter((t) => t.termType === 'NamedNode').map((t) => t.value).sort();
      if (v.length) mappings[p] = v;
    }
    const dep = objects(s, iri, P.deprecated).some((t) => t.value === 'true' || t.value === '1');
    return clean({
      label: pickPreferred(objects(s, iri, P.label)),
      definition: pickPreferred([...objects(s, iri, P.definition), ...objects(s, iri, P.iaoDefinition)]),
      comment: pickPreferred(objects(s, iri, P.comment)),
      altLabels: vals(P.altLabel),
      examples: vals(P.example),
      editorialNote: pickPreferred(objects(s, iri, P.editorialNote)),
      source: sortedValues(objects(s, iri, P.source)),
      mappings: Object.keys(mappings).length ? mappings : undefined,
      deprecated: dep || undefined,
      replacedBy: (firstObject(s, iri, P.replacedBy) ?? firstObject(s, iri, P.iaoReplacedBy))?.value,
    });
  }

  classView(iri: string): ClassView {
    const s = this.store;
    const superClasses: IRI[] = [];
    const restrictions: Restriction[] = [];
    const superExprs: string[] = [];
    const conjuncts: NonNullable<ClassView['superClassConjuncts']> = [];
    for (const o of objects(s, iri, P.subClassOf)) {
      if (o.termType === 'NamedNode') superClasses.push(o.value);
      else if (o.termType === 'BlankNode') {
        const r = this.restrictionOf(o);
        if (r) restrictions.push(r);
        else {
          const expression = manchesterExpr(s, o, this.prefixes);
          superExprs.push(expression);
          const parts = this.conjunctsOf(o);
          if (parts) conjuncts.push({ expression, ...parts });
        }
      }
    }
    const eq = [...objects(s, iri, P.equivalentClass), ...subjects(s, P.equivalentClass, iri)];
    const disjoint = new Set<string>([
      ...objects(s, iri, P.disjointWith), ...subjects(s, P.disjointWith, iri),
    ].filter((t) => t.termType === 'NamedNode').map((t) => t.value));
    for (const ax of subjects(s, RDF_TYPE, T.AllDisjointClasses)) {
      const members = objects(s, ax, P.members).flatMap((h) => readList(s, h) ?? []).map((t) => t.value);
      if (members.includes(iri)) members.forEach((m) => m !== iri && disjoint.add(m));
    }
    disjoint.delete(iri);
    return clean({
      iri,
      kind: 'class' as const,
      ...this.annotations(iri),
      superClasses: [...new Set(superClasses)].sort(),
      equivalentClasses: [...new Set(eq.filter((t) => t.termType === 'NamedNode' && t.value !== iri).map((t) => t.value))].sort(),
      disjointWith: [...disjoint].sort(),
      restrictions: restrictions.sort((a, b) => restrictionKey(a).localeCompare(restrictionKey(b))),
      superClassExpressions: superExprs.length ? superExprs.sort() : undefined,
      superClassConjuncts: conjuncts.length ? conjuncts.sort((a, b) => a.expression.localeCompare(b.expression)) : undefined,
      equivalentExpressions: nonEmpty(eq.filter((t) => t.termType === 'BlankNode').map((t) => manchesterExpr(s, t, this.prefixes)).sort()),
    }) as ClassView;
  }

  /**
   * The parts of an anonymous intersection (`A and (p min 2)`), when every part is a named
   * class, a simple restriction or another such intersection. A subclass of an intersection
   * is a subclass of each part, so these can be summarised like ordinary axioms.
   */
  conjunctsOf(node: Term): { classes: IRI[]; restrictions: Restriction[] } | undefined {
    const head = firstObject(this.store, node, NS.owl + 'intersectionOf');
    const members = head && readList(this.store, head);
    if (!members?.length) return undefined;
    const out = { classes: [] as IRI[], restrictions: [] as Restriction[] };
    for (const m of members) {
      if (m.termType === 'NamedNode') out.classes.push(m.value);
      else if (m.termType === 'BlankNode') {
        const r = this.restrictionOf(m);
        if (r) {
          out.restrictions.push(r);
          continue;
        }
        const inner = this.conjunctsOf(m);
        if (!inner) return undefined;
        out.classes.push(...inner.classes);
        out.restrictions.push(...inner.restrictions);
      } else return undefined;
    }
    return out;
  }

  /** Parses an owl:Restriction blank node into the simple `Restriction` form. */
  restrictionOf(node: Term): Restriction | undefined {
    const s = this.store;
    const one = (p: string) => firstObject(s, node, NS.owl + p);
    const prop = one('onProperty');
    if (!prop || prop.termType !== 'NamedNode') return undefined;
    const r: Restriction = { property: prop.value, kind: 'some' };
    const setFiller = (f: Term | undefined) => {
      if (!f) return;
      if (f.termType === 'NamedNode') r.filler = f.value;
      else r.fillerExpression = manchesterExpr(s, f, this.prefixes);
    };
    if (one('someValuesFrom')) { r.kind = 'some'; setFiller(one('someValuesFrom')); }
    else if (one('allValuesFrom')) { r.kind = 'only'; setFiller(one('allValuesFrom')); }
    else if (one('hasValue')) {
      r.kind = 'value';
      const v = one('hasValue')!;
      if (v.termType === 'Literal') r.literal = v.value;
      else r.filler = v.value;
    } else {
      const cards: [string, Restriction['kind']][] = [
        ['minCardinality', 'min'], ['maxCardinality', 'max'], ['cardinality', 'exactly'],
        ['minQualifiedCardinality', 'min'], ['maxQualifiedCardinality', 'max'], ['qualifiedCardinality', 'exactly'],
      ];
      const hit = cards.find(([p]) => one(p));
      if (!hit) return undefined;
      r.kind = hit[1];
      r.cardinality = Number(one(hit[0])!.value);
      setFiller(one('onClass') ?? one('onDataRange'));
    }
    return clean(r) as Restriction;
  }

  propertyView(iri: string, kind: PropertyView['kind']): PropertyView {
    const s = this.store;
    const types = objects(s, iri, RDF_TYPE).map((t) => t.value);
    const named = (ts: Term[]) => [...new Set(ts.filter((t) => t.termType === 'NamedNode').map((t) => t.value))].sort();
    const inv = [...objects(s, iri, P.inverseOf), ...subjects(s, P.inverseOf, iri)].find((t) => t.termType === 'NamedNode' && t.value !== iri);
    const dom = objects(s, iri, P.domain);
    const rng = objects(s, iri, P.range);
    return clean({
      iri,
      kind,
      ...this.annotations(iri),
      domain: named(dom),
      range: named(rng),
      domainExpressions: nonEmpty(dom.filter((t) => t.termType === 'BlankNode').map((t) => manchesterExpr(s, t, this.prefixes)).sort()),
      rangeExpressions: nonEmpty(rng.filter((t) => t.termType === 'BlankNode').map((t) => manchesterExpr(s, t, this.prefixes)).sort()),
      superProperties: named(objects(s, iri, P.subPropertyOf)),
      inverseOf: inv?.value,
      characteristics: (Object.entries(CHARACTERISTIC_TYPES) as [PropertyCharacteristic, string][])
        .filter(([, t]) => types.includes(t)).map(([c]) => c),
    }) as PropertyView;
  }

  individualView(iri: string): IndividualView {
    const s = this.store;
    const facts: Record<IRI, string[]> = {};
    for (const q of s.getQuads(nn(iri), null, null, null)) {
      const p = q.predicate.value;
      if (p === RDF_TYPE || ANNOTATION_PREDICATES.has(p) || hasType(s, p, T.AnnotationProperty)) continue;
      (facts[p] ??= []).push(q.object.value);
    }
    for (const k of Object.keys(facts)) facts[k].sort();
    return clean({
      iri,
      kind: 'individual' as const,
      ...this.annotations(iri),
      types: objects(s, iri, RDF_TYPE).filter((t) => t.termType === 'NamedNode' && t.value !== T.NamedIndividual).map((t) => t.value).sort(),
      facts,
    }) as IndividualView;
  }
}

/** Annotation predicates that never count as individual "facts". */
export const ANNOTATION_PREDICATES = new Set<string>([
  P.label, P.comment, P.definition, P.iaoDefinition, P.altLabel, P.example, P.editorialNote, P.historyNote,
  P.source, P.isDefinedBy, P.deprecated, P.replacedBy, P.iaoReplacedBy, P.created, P.contributor,
  NS.skos + 'prefLabel', NS.skos + 'note', NS.skos + 'scopeNote', NS.skos + 'changeNote', NS.dcterms + 'modified',
  NS.dcterms + 'creator', ...MAPPING_PROPERTIES,
]);

/** Adds `p a owl:AnnotationProperty` for the given predicates (OWL 2 DL requires declarations). */
export function declareAnnotationProperties(store: Store, preds: string[]): void {
  for (const p of preds) {
    if (p.startsWith(NS.rdfs) || p.startsWith(NS.owl) || p.startsWith(NS.rdf)) continue; // built-ins need no declaration
    if (store.countQuads(nn(p), nn(RDF_TYPE), null, null) === 0) store.addQuad(nn(p), nn(RDF_TYPE), nn(T.AnnotationProperty));
  }
}

/* ------------------------------------------------------------------------ */
/* Helpers                                                                   */
/* ------------------------------------------------------------------------ */

export function restrictionKey(r: Restriction): string {
  return [r.property, r.kind, r.filler ?? r.fillerExpression ?? '', r.cardinality ?? '', r.literal ?? ''].join(' ');
}

function isEnOrPlain(t: Term): boolean {
  return t.termType !== 'Literal' || !(t as Literal).language || (t as Literal).language.startsWith('en');
}

/** Picks one value deterministically: @en literal, then untagged, then any (sorted). */
export function pickPreferred(ts: Term[]): string | undefined {
  if (!ts.length) return undefined;
  const rank = (t: Term) => {
    if (t.termType !== 'Literal') return 1;
    const l = (t as Literal).language;
    return l === 'en' ? 0 : l.startsWith('en') ? 0.5 : !l ? 1 : 2;
  };
  return [...ts].sort((a, b) => rank(a) - rank(b) || a.value.localeCompare(b.value))[0].value;
}

function sortedValues(ts: Term[]): string[] | undefined {
  const v = [...new Set(ts.map((t) => t.value))].sort();
  return v.length ? v : undefined;
}

function nonEmpty<T>(xs: T[]): T[] | undefined {
  return xs.length ? xs : undefined;
}

/** Drops undefined fields so views compare and serialise cleanly. */
function clean<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
  return o;
}

function isSubsequence(needle: string, hay: string): boolean {
  let i = 0;
  for (const ch of hay) if (ch === needle[i]) i++;
  return i === needle.length && needle.length > 2;
}

/* ------------------------------------------------------------------------ */
/* Parsing                                                                   */
/* ------------------------------------------------------------------------ */

function toDefaultGraph(quads: Quad[]): Store {
  const store = new Store();
  for (const q of quads) store.addQuad(quad(q.subject, q.predicate, q.object, defaultGraph()) as Quad);
  return store;
}

async function parseN3(text: string, format: 'Turtle' | 'N-Triples' | 'N-Quads', baseIRI?: string): Promise<OntologyGraph> {
  const prefixes: Record<string, string> = {};
  const parser = new Parser({ format, baseIRI });
  const quads = parser.parse(text, null, (prefix, iri) => {
    prefixes[prefix] = typeof iri === 'string' ? iri : iri.value;
  });
  return new OntologyGraph(toDefaultGraph(quads), prefixes);
}

async function parseRdfXml(text: string, baseIRI?: string): Promise<OntologyGraph> {
  const { RdfXmlParser } = await import('rdfxml-streaming-parser');
  const quads: Quad[] = await new Promise((resolve, reject) => {
    const out: Quad[] = [];
    const parser = new RdfXmlParser({ baseIRI: baseIRI ?? '' });
    parser.on('data', (q: Quad) => out.push(q));
    parser.on('error', reject);
    parser.on('end', () => resolve(out));
    parser.write(text);
    parser.end();
  });
  const prefixes: Record<string, string> = {};
  for (const m of text.matchAll(/xmlns:([A-Za-z_][\w.-]*)\s*=\s*"([^"]*)"/g)) {
    if (m[1] !== 'rdf' || m[2] === NS.rdf) prefixes[m[1]] = m[2];
  }
  return new OntologyGraph(toDefaultGraph(quads), prefixes);
}

async function parseJsonLd(doc: any): Promise<OntologyGraph> {
  const jsonld = (await import('jsonld')).default;
  // Never fetch remote contexts or @import: a document must not make the server request URLs.
  const nquads = (await jsonld.toRDF(doc, { format: 'application/n-quads', documentLoader: noRemoteDocuments as any }).catch((err: any) => {
    // jsonld wraps the loader's refusal in a generic dereferencing error: say plainly what happened.
    for (let e = err; e; e = e.details?.cause ?? e.cause) if (String(e.message).startsWith(REMOTE_REFUSED)) throw new Error(e.message);
    throw err;
  })) as unknown as string;
  const g = await parseN3(nquads, 'N-Quads');
  const prefixes: Record<string, string> = {};
  const ctxs = ([] as unknown[]).concat(doc?.['@context'] ?? []);
  for (const c of ctxs) {
    if (c && typeof c === 'object') {
      for (const [k, v] of Object.entries(c as Record<string, unknown>)) {
        if (typeof v === 'string' && !k.startsWith('@') && /[#/:]$/.test(v)) prefixes[k] = v;
      }
    }
  }
  return new OntologyGraph(g.store, prefixes);
}

// Re-exported for modules that need to build terms against the graph.
export { namedNode };
