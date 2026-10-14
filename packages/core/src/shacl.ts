/**
 * Derives SHACL node shapes from the ontology: one sh:NodeShape per named class
 * (sh:targetClass), with property shapes from domain/range, restrictions and
 * functional characteristics. Qualified constraints are used where OWL semantics
 * require them (`p some F` does not mean every value is an F).
 */
import { Store } from 'n3';
import type { Term } from 'n3';
import type { Restriction } from './types.js';
import { NS, RDF_TYPE, localName } from './ns.js';
import { blankNode, literal, nn, objects, readList, typedLit } from './rdf.js';
import { isDatatype } from './changes.js';
import type { OntologyGraph } from './graph.js';
import { writeTurtle } from './turtle.js';

const SH = NS.sh;

interface PropShape {
  path: string;
  cls?: string;
  datatype?: string;
  minCount?: number;
  maxCount?: number;
  hasValue?: Term;
  qualified: { shape: { cls?: string; datatype?: string }; min?: number; max?: number }[];
}

export async function toShacl(graph: OntologyGraph): Promise<string> {
  const v = graph.view();
  const out = new Store();
  const ont = graph.ontologyIRI || graph.namespace.replace(/[#/]$/, '');
  const shapesNs = `${ont}/shapes#`;
  const pref = v.metadata.preferredPrefix ?? 'ont';
  const props = new Map([...v.objectProperties, ...v.datatypeProperties].map((p) => [p.iri, p]));
  const int = (n: number) => typedLit(String(n), NS.xsd + 'integer');
  const add = (s: Term, p: string, o: Term) => out.addQuad(s as any, nn(p), o as any);

  if (graph.ontologyIRI) {
    const sh = nn(`${ont}/shapes`);
    add(sh, RDF_TYPE, nn(NS.owl + 'Ontology'));
    add(sh, NS.rdfs + 'label', literal(`SHACL shapes derived from ${v.metadata.title ?? ont}`, 'en'));
    add(sh, NS.dcterms + 'source', nn(v.metadata.versionIRI ?? ont));
  }

  for (const k of v.classes) {
    if (k.deprecated || !k.iri.startsWith(graph.namespace)) continue;
    const shape = nn(`${shapesNs}${localName(k.iri)}Shape`);
    add(shape, RDF_TYPE, nn(SH + 'NodeShape'));
    add(shape, SH + 'targetClass', nn(k.iri));
    if (k.label) add(shape, SH + 'name', literal(k.label, 'en'));

    const shapes = new Map<string, PropShape>();
    const get = (p: string) => {
      if (!shapes.has(p)) shapes.set(p, { path: p, qualified: [] });
      return shapes.get(p)!;
    };
    // Properties whose (named) domain is this class: value type from the range.
    for (const p of props.values()) {
      if (p.deprecated || !domainMembers(graph, p.iri).includes(k.iri)) continue;
      const ps = get(p.iri);
      const r = p.range[0];
      if (r && p.range.length === 1) {
        if (isDatatype(graph, r)) ps.datatype = r;
        else ps.cls = r;
      }
      if (p.characteristics.includes('functional')) ps.maxCount = 1;
    }
    for (const r of k.restrictions) applyRestriction(graph, get(r.property), r, props.get(r.property)?.range ?? []);

    for (const ps of [...shapes.values()].sort((a, b) => a.path.localeCompare(b.path))) {
      const b = blankNode();
      add(shape, SH + 'property', b);
      add(b, SH + 'path', nn(ps.path));
      if (ps.datatype) add(b, SH + 'datatype', nn(ps.datatype));
      if (ps.cls) add(b, SH + 'class', nn(ps.cls));
      if (ps.minCount !== undefined) add(b, SH + 'minCount', int(ps.minCount));
      if (ps.maxCount !== undefined) add(b, SH + 'maxCount', int(ps.maxCount));
      if (ps.hasValue) add(b, SH + 'hasValue', ps.hasValue);
      for (const q of ps.qualified) {
        // Each qualified constraint needs its own property shape in SHACL.
        const qb = q === ps.qualified[0] ? b : blankNode();
        if (qb !== b) {
          add(shape, SH + 'property', qb);
          add(qb, SH + 'path', nn(ps.path));
        }
        const vs = blankNode();
        add(qb, SH + 'qualifiedValueShape', vs);
        if (q.shape.cls) add(vs, SH + 'class', nn(q.shape.cls));
        if (q.shape.datatype) add(vs, SH + 'datatype', nn(q.shape.datatype));
        if (q.min !== undefined) add(qb, SH + 'qualifiedMinCount', int(q.min));
        if (q.max !== undefined) add(qb, SH + 'qualifiedMaxCount', int(q.max));
      }
    }
  }
  const prefixes = { ...graph.prefixes, sh: SH, [`${pref}sh`]: shapesNs };
  return writeTurtle(out, prefixes, { ontologyIRI: graph.ontologyIRI ? `${ont}/shapes` : undefined });
}

function applyRestriction(graph: OntologyGraph, ps: PropShape, r: Restriction, range: string[]): void {
  const filler = r.filler && r.filler !== NS.owl + 'Thing' && r.filler !== NS.rdfs + 'Literal' ? r.filler : undefined;
  // A filler equal to the property's range adds no type constraint beyond the range.
  const sameAsRange = !filler || (range.length === 1 && range[0] === filler);
  const typed = filler ? (isDatatype(graph, filler) ? { datatype: filler } : { cls: filler }) : {};
  const n = r.cardinality ?? 0;
  switch (r.kind) {
    case 'some':
      if (sameAsRange) ps.minCount = Math.max(ps.minCount ?? 0, 1);
      else ps.qualified.push({ shape: typed, min: 1 });
      break;
    case 'only':
      if (filler) Object.assign(ps, typed);
      break;
    case 'value':
      ps.hasValue = r.literal !== undefined ? literal(r.literal) : nn(r.filler!);
      break;
    case 'min':
      if (sameAsRange) ps.minCount = Math.max(ps.minCount ?? 0, n);
      else ps.qualified.push({ shape: typed, min: n });
      break;
    case 'max':
      if (sameAsRange) ps.maxCount = Math.min(ps.maxCount ?? Infinity, n);
      else ps.qualified.push({ shape: typed, max: n });
      break;
    case 'exactly':
      if (sameAsRange) {
        ps.minCount = Math.max(ps.minCount ?? 0, n);
        ps.maxCount = Math.min(ps.maxCount ?? Infinity, n);
      } else ps.qualified.push({ shape: typed, min: n, max: n });
      break;
  }
}

/** Named domain classes of a property, including members of a union domain. */
function domainMembers(graph: OntologyGraph, p: string): string[] {
  const out: string[] = [];
  for (const d of objects(graph.store, p, NS.rdfs + 'domain')) {
    if (d.termType === 'NamedNode') out.push(d.value);
    else for (const head of objects(graph.store, d, NS.owl + 'unionOf')) for (const m of readList(graph.store, head) ?? []) out.push(m.value);
  }
  return out;
}
