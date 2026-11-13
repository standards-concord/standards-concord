/**
 * Deterministic, human-friendly Turtle writer.
 *
 * Output is designed to be committed to git: prefixes (only those used) first,
 * then the ontology header, then sections (classes, object properties, datatype
 * properties, annotation properties, individuals, other, general axioms), each
 * sorted by IRI. Blank nodes referenced once are inlined with `[ ]`, RDF lists
 * with `( )`; anything else gets a stable `_:bN` label derived from its structure.
 */
import type { Store, Term, Literal, Quad } from 'n3';
import { NS, RDF_TYPE, qname } from './ns.js';
import { RDF_FIRST, RDF_REST, RDF_NIL, blankNode, canonical, escapeString, namedNode, objects, readList } from './rdf.js';

const PREDICATE_ORDER = [
  RDF_TYPE,
  // ontology header
  NS.owl + 'versionIRI', NS.owl + 'versionInfo', NS.owl + 'priorVersion', NS.owl + 'backwardCompatibleWith',
  NS.owl + 'incompatibleWith', NS.owl + 'imports', NS.dcterms + 'title', NS.dcterms + 'description',
  // restrictions
  NS.owl + 'onProperty',
  // term annotations
  NS.rdfs + 'label', NS.skos + 'prefLabel', NS.skos + 'altLabel', NS.skos + 'definition', NS.obo + 'IAO_0000115',
  NS.rdfs + 'comment', NS.skos + 'example', NS.skos + 'editorialNote', NS.skos + 'historyNote', NS.dcterms + 'source',
  NS.owl + 'deprecated', NS.dcterms + 'isReplacedBy',
  // logical axioms
  NS.rdfs + 'subClassOf', NS.owl + 'equivalentClass', NS.owl + 'disjointWith', NS.rdfs + 'subPropertyOf',
  NS.owl + 'inverseOf', NS.rdfs + 'domain', NS.rdfs + 'range',
  // provenance last
  NS.rdfs + 'isDefinedBy', NS.dcterms + 'created', NS.dcterms + 'contributor',
];
// Declaration types are written first in `a ...` lists.
const TYPE_ORDER = [NS.owl + 'Ontology', NS.owl + 'Class', NS.owl + 'ObjectProperty', NS.owl + 'DatatypeProperty', NS.owl + 'AnnotationProperty', NS.owl + 'NamedIndividual', NS.owl + 'Restriction'];
const ORDER_INDEX = new Map(PREDICATE_ORDER.map((p, i) => [p, i]));

const SECTIONS: [string, string[]][] = [
  ['Classes', [NS.owl + 'Class', NS.rdfs + 'Class']],
  ['Object properties', [NS.owl + 'ObjectProperty', NS.owl + 'TransitiveProperty', NS.owl + 'SymmetricProperty',
    NS.owl + 'AsymmetricProperty', NS.owl + 'ReflexiveProperty', NS.owl + 'IrreflexiveProperty', NS.owl + 'InverseFunctionalProperty']],
  ['Datatype properties', [NS.owl + 'DatatypeProperty']],
  ['Annotation properties', [NS.owl + 'AnnotationProperty']],
  ['Datatypes', [NS.rdfs + 'Datatype']],
  ['Individuals', [NS.owl + 'NamedIndividual']],
  ['Shapes', [NS.sh + 'NodeShape', NS.sh + 'PropertyShape']],
];

export interface TurtleOptions {
  ontologyIRI?: string;
  /** Section comments (default true). */
  sectionComments?: boolean;
}

export function writeTurtle(store: Store, prefixes: Record<string, string>, opts: TurtleOptions = {}): string {
  const used = new Set<string>();
  const quads = store.getQuads(null, null, null, null) as Quad[];

  // --- Blank node analysis --------------------------------------------------
  const refCount = new Map<string, number>();
  for (const q of quads) if (q.object.termType === 'BlankNode') refCount.set(q.object.value, (refCount.get(q.object.value) ?? 0) + 1);
  const bnodeSubjects = new Set(quads.filter((q) => q.subject.termType === 'BlankNode').map((q) => q.subject.value));
  const allBnodes = new Set([...bnodeSubjects, ...refCount.keys()]);

  const labeled = new Set<string>();
  const covered = new Set<string>();
  const visit = (t: Term) => {
    if (t.termType !== 'BlankNode' || covered.has(t.value)) return;
    covered.add(t.value);
    for (const q of store.getQuads(t, null, null, null)) {
      const o = q.object as Term;
      if (o.termType === 'BlankNode' && !labeled.has(o.value)) {
        if ((refCount.get(o.value) ?? 0) > 1) labeled.add(o.value);
        else visit(o);
      }
    }
  };
  const namedSubjects = [...new Set(quads.filter((q) => q.subject.termType === 'NamedNode').map((q) => q.subject.value))];
  for (const q of quads) {
    if (q.subject.termType === 'NamedNode' && q.object.termType === 'BlankNode') {
      if ((refCount.get(q.object.value) ?? 0) > 1) labeled.add(q.object.value);
      else visit(q.object as Term);
    }
  }
  const rootBnodes = [...allBnodes].filter((b) => !refCount.has(b));
  for (const b of rootBnodes) visit(blankNode(b));
  // Remaining (cyclic or multiply-referenced) blank nodes get labels.
  let changed = true;
  while (changed) {
    changed = false;
    for (const b of allBnodes) {
      if (!covered.has(b)) { labeled.add(b); visit(blankNode(b)); changed = true; }
    }
  }
  for (const b of labeled) covered.add(b);
  const bnodeTerm = (v: string): Term => blankNode(v);
  const labels = new Map<string, string>();
  [...labeled]
    .map((b) => [b, canonical(store, bnodeTerm(b))] as const)
    .sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]))
    .forEach(([b], i) => labels.set(b, `_:b${i}`));

  // A blank node is rendered as `( ... )` if it heads a clean list whose nodes are only referenced once.
  const isInlineList = (t: Term): Term[] | null => {
    const items = readList(store, t);
    if (!items) return null;
    let node: Term = t;
    while (!(node.termType === 'NamedNode' && node.value === RDF_NIL)) {
      if (labeled.has(node.value) || store.countQuads(node, null, null, null) !== 2) return null;
      node = objects(store, node, RDF_REST)[0];
    }
    return items;
  };

  // --- Term rendering -------------------------------------------------------
  const iri = (v: string): string => {
    const q = qname(v, prefixes);
    if (q) {
      used.add(q.slice(0, q.indexOf(':')));
      return q;
    }
    return `<${v.replace(/[\u0000- <>"{}|^`\\]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}>`;
  };
  const lit = (l: Literal): string => {
    const dt = l.datatype?.value;
    const v = l.value;
    let body: string;
    if (/[\n\r]/.test(v)) body = `"""${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"""`;
    else body = `"${escapeString(v)}"`;
    if (l.language) return `${body}@${l.language}`;
    if (!dt || dt === NS.xsd + 'string') return body;
    if (dt === NS.xsd + 'integer' && /^[+-]?\d+$/.test(v)) return v;
    if (dt === NS.xsd + 'boolean' && /^(true|false)$/.test(v)) return v;
    if (dt === NS.xsd + 'decimal' && /^[+-]?\d*\.\d+$/.test(v)) return v;
    return `${body}^^${dt === RDF_TYPE ? `<${dt}>` : iri(dt)}`;
  };

  const sortedPreds = (s: Term): [string, Term[]][] => {
    const byPred = new Map<string, Term[]>();
    for (const q of store.getQuads(s, null, null, null)) {
      const list = byPred.get(q.predicate.value) ?? [];
      list.push(q.object as Term);
      byPred.set(q.predicate.value, list);
    }
    return [...byPred.entries()].sort(([a], [b]) => {
      const ia = ORDER_INDEX.get(a) ?? 1000;
      const ib = ORDER_INDEX.get(b) ?? 1000;
      return ia - ib || a.localeCompare(b);
    });
  };

  const obj = (o: Term, ind: string): string => {
    if (o.termType === 'NamedNode') return iri(o.value);
    if (o.termType === 'Literal') return lit(o as Literal);
    if (o.termType === 'BlankNode') {
      if (labeled.has(o.value)) return labels.get(o.value)!;
      const items = isInlineList(o);
      if (items) {
        const rendered = items.map((i) => obj(i, ind + '    '));
        const oneLine = `( ${rendered.join(' ')} )`;
        if (oneLine.length <= 80 && !oneLine.includes('\n')) return oneLine;
        return `(\n${rendered.map((r) => ind + '    ' + r).join('\n')}\n${ind})`;
      }
      return `[ ${poList(o, ind + '    ')} ]`;
    }
    return o.value;
  };

  const keyCache = new Map<string, string>();
  const objKey = (o: Term) => {
    if (o.termType !== 'BlankNode') return canonical(store, o);
    let k = keyCache.get(o.value);
    if (k === undefined) keyCache.set(o.value, (k = canonical(store, o)));
    return k;
  };
  function poList(s: Term, ind: string): string {
    return sortedPreds(s)
      .map(([p, objs]) => {
        const typeRank = (t: Term) => (p === RDF_TYPE && TYPE_ORDER.includes(t.value) ? TYPE_ORDER.indexOf(t.value) : TYPE_ORDER.length);
        const sorted = [...objs].sort((a, b) => {
          // Declarations first for rdf:type; named objects before blank structures; then by canonical form.
          const ra = a.termType === 'BlankNode' ? 1 : 0;
          const rb = b.termType === 'BlankNode' ? 1 : 0;
          return typeRank(a) - typeRank(b) || ra - rb || objKey(a).localeCompare(objKey(b));
        });
        const rendered = sorted.map((o) => obj(o, ind + '    '));
        // Short lists of simple objects stay on one line.
        const oneLine = rendered.join(' , ');
        if (sorted.every((o) => o.termType !== 'BlankNode') && oneLine.length <= 72) return `${p === RDF_TYPE ? 'a' : iri(p)} ${oneLine}`;
        return `${p === RDF_TYPE ? 'a' : iri(p)} ${rendered.join(` ,\n${ind}    `)}`;
      })
      .join(` ;\n${ind}`);
  }
  const block = (s: Term): string => {
    const subj = s.termType === 'BlankNode' ? (labels.get(s.value) ?? null) : iri(s.value);
    if (subj === null) return `[ ${poList(s, '    ')} ] .`;
    return `${subj} ${poList(s, '    ')} .`;
  };

  // --- Sections -------------------------------------------------------------
  const typeOf = (s: string) => new Set(objects(store, s, RDF_TYPE).map((t) => t.value));
  const sectionOf = new Map<string, string>();
  const classIris = new Set(quads.filter((q) => q.predicate.value === RDF_TYPE && (q.object.value === NS.owl + 'Class' || q.object.value === NS.rdfs + 'Class')).map((q) => q.subject.value));
  for (const s of namedSubjects) {
    if (s === opts.ontologyIRI) continue;
    const types = typeOf(s);
    const sec = SECTIONS.find(([, ts]) => ts.some((t) => types.has(t)))?.[0]
      ?? ([...types].some((t) => classIris.has(t)) ? 'Individuals' : 'Other');
    sectionOf.set(s, sec);
  }

  const out: string[] = [];
  const header = opts.ontologyIRI && store.countQuads(namedNode(opts.ontologyIRI), null, null, null) > 0;
  const comment = opts.sectionComments !== false;
  const section = (title: string, blocks: string[]) => {
    if (!blocks.length) return;
    if (comment) out.push(`#################################################################\n### ${title}\n#################################################################`);
    out.push(...blocks);
  };
  if (header) section('Ontology', [block(namedNode(opts.ontologyIRI!))]);
  const byIri = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  for (const title of [...SECTIONS.map(([t]) => t), 'Other']) {
    const subs = [...sectionOf.entries()].filter(([, sec]) => sec === title).map(([s]) => s).sort(byIri);
    section(title, subs.map((s) => block(namedNode(s))));
  }
  // Root blank nodes (e.g. owl:AllDisjointClasses) and labeled blank nodes.
  const general = [
    ...rootBnodes.filter((b) => !labeled.has(b)),
    // A labeled blank node with no triples of its own is only ever an object.
    ...[...labeled].filter((b) => store.countQuads(blankNode(b), null, null, null) > 0),
  ].map((b) => {
    const t = bnodeTerm(b);
    return [canonical(store, t), block(t)] as const;
  }).sort((a, b) => a[0].localeCompare(b[0])).map(([, s]) => s);
  section('General axioms', general);

  const body = out.join('\n\n');
  const prefixLines = [...used]
    .filter((p) => prefixes[p] !== undefined)
    .sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)))
    .map((p) => `@prefix ${p}: <${prefixes[p]}> .`);
  return (prefixLines.length ? prefixLines.join('\n') + '\n\n' : '') + body + '\n';
}

/** Deterministic N-Triples: sorted lines, blank nodes relabelled by structure. */
export function writeNTriples(store: Store): string {
  const quads = store.getQuads(null, null, null, null) as Quad[];
  const bnodes = new Map<string, Term>();
  for (const q of quads) {
    if (q.subject.termType === 'BlankNode') bnodes.set(q.subject.value, q.subject as Term);
    if (q.object.termType === 'BlankNode') bnodes.set(q.object.value, q.object as Term);
  }
  const labels = new Map<string, string>();
  [...bnodes.values()]
    .map((b) => [b.value, canonical(store, b)] as const)
    .sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]))
    .forEach(([v], i) => labels.set(v, `b${i}`));
  const t = (x: Term): string => {
    if (x.termType === 'BlankNode') return `_:${labels.get(x.value)}`;
    if (x.termType === 'NamedNode') return `<${x.value}>`;
    const l = x as Literal;
    const base = `"${escapeString(l.value)}"`;
    if (l.language) return `${base}@${l.language}`;
    if (l.datatype && l.datatype.value !== NS.xsd + 'string') return `${base}^^<${l.datatype.value}>`;
    return base;
  };
  const lines = [...new Set(quads.map((q) => `${t(q.subject as Term)} ${t(q.predicate as Term)} ${t(q.object as Term)} .`))].sort();
  return lines.join('\n') + (lines.length ? '\n' : '');
}

export { RDF_FIRST };
