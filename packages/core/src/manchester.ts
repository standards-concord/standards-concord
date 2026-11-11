/**
 * OWL 2 Manchester syntax writer (frames per entity; general axioms at the end).
 */
import type { Literal, Term } from 'n3';
import { NS, RDF_TYPE } from './ns.js';
import { manchesterExpr, nn, objects, readList, renderLiteral, renderName, subjects } from './rdf.js';
import { ANNOTATION_PREDICATES, MAPPING_PROPERTIES, P, T } from './graph.js';
import type { OntologyGraph } from './graph.js';

const CHARACTERISTIC_NAMES: Record<string, string> = {
  functional: 'Functional', inverseFunctional: 'InverseFunctional', transitive: 'Transitive', symmetric: 'Symmetric',
  asymmetric: 'Asymmetric', reflexive: 'Reflexive', irreflexive: 'Irreflexive',
};

export function toManchester(graph: OntologyGraph): string {
  const s = graph.store;
  const prefixes = graph.prefixes;
  const name = (iri: string) => renderName(iri, prefixes);
  const expr = (t: Term) => manchesterExpr(s, t, prefixes);
  const v = graph.view();
  const used = new Set<string>();
  const track = (out: string) => {
    for (const m of out.matchAll(/(?<![<\w])([A-Za-z][\w.-]*|):[A-Za-z0-9_]/g)) used.add(m[1]);
    return out;
  };

  const annotationsOf = (iri: string, skip: Set<string> = new Set()): string[] => {
    const out: string[] = [];
    for (const q of s.getQuads(nn(iri), null, null, null)) {
      const p = q.predicate.value;
      const isAnn = ANNOTATION_PREDICATES.has(p) || objects(s, p, RDF_TYPE).some((t) => t.value === T.AnnotationProperty) || MAPPING_PROPERTIES.includes(p);
      if (!isAnn || skip.has(p)) continue;
      const o = q.object as Term;
      const val = o.termType === 'Literal' ? renderLiteral(o as Literal, prefixes) : o.termType === 'NamedNode' ? name(o.value) : null;
      if (val) out.push(`${name(p)} ${val}`);
    }
    return out.sort();
  };
  const section = (label: string, items: string[], indent = '    ') =>
    items.length ? [`${indent}${label}: ${items.length > 1 ? '\n' + items.map((i) => indent + '    ' + i).join(',\n') : items[0]}`] : [];

  const frames: string[] = [];
  // Ontology header
  const ont = graph.ontologyIRI;
  const m = v.metadata;
  const header: string[] = [`Ontology: <${ont}>${m.versionIRI ? ` <${m.versionIRI}>` : ''}`];
  for (const imp of m.imports) header.push(`Import: <${imp}>`);
  if (ont) header.push(...section('Annotations', annotationsOf(ont, new Set([NS.owl + 'imports', NS.owl + 'versionIRI'])).concat(
    objects(s, ont, NS.owl + 'versionInfo').map((o) => `owl:versionInfo ${renderLiteral(o as Literal, prefixes)}`),
    objects(s, ont, NS.owl + 'priorVersion').map((o) => `owl:priorVersion ${name(o.value)}`),
    objects(s, ont, NS.owl + 'backwardCompatibleWith').map((o) => `owl:backwardCompatibleWith ${name(o.value)}`),
    objects(s, ont, NS.owl + 'incompatibleWith').map((o) => `owl:incompatibleWith ${name(o.value)}`),
  ).sort(), ''));
  frames.push(header.join('\n'));
  // Vocabulary declarations are hidden from UI views, but remain part of the OWL document.
  const frameTypes: Record<string, string> = { [T.Class]: 'Class', [T.ObjectProperty]: 'ObjectProperty', [T.DatatypeProperty]: 'DataProperty', [T.AnnotationProperty]: 'AnnotationProperty' };
  for (const q of s.getQuads(null, nn(RDF_TYPE), null, null)) {
    if (q.subject.termType === 'NamedNode' && q.subject.value.startsWith(NS.skos) && frameTypes[q.object.value]) frames.push(`${frameTypes[q.object.value]}: ${name(q.subject.value)}`);
  }


  for (const p of v.annotationProperties) frames.push([`AnnotationProperty: ${name(p.iri)}`, ...section('Annotations', annotationsOf(p.iri))].join('\n'));
  const datatypes = subjects(s, RDF_TYPE, T.Datatype).filter((t) => t.termType === 'NamedNode').map((t) => t.value).sort();
  for (const d of datatypes) {
    const eq = objects(s, d, P.equivalentClass).map(expr);
    frames.push([`Datatype: ${name(d)}`, ...section('Annotations', annotationsOf(d)), ...section('EquivalentTo', eq)].join('\n'));
  }

  for (const p of v.objectProperties) {
    frames.push([
      `ObjectProperty: ${name(p.iri)}`,
      ...section('Annotations', annotationsOf(p.iri)),
      ...section('Domain', objects(s, p.iri, P.domain).map(expr)),
      ...section('Range', objects(s, p.iri, P.range).map(expr)),
      ...section('Characteristics', p.characteristics.map((c) => CHARACTERISTIC_NAMES[c])),
      ...section('SubPropertyOf', p.superProperties.map(name)),
      ...section('InverseOf', objects(s, p.iri, P.inverseOf).map(expr)),
    ].join('\n'));
  }
  for (const p of v.datatypeProperties) {
    frames.push([
      `DataProperty: ${name(p.iri)}`,
      ...section('Annotations', annotationsOf(p.iri)),
      ...section('Domain', objects(s, p.iri, P.domain).map(expr)),
      ...section('Range', objects(s, p.iri, P.range).map(expr)),
      ...section('Characteristics', p.characteristics.includes('functional') ? ['Functional'] : []),
      ...section('SubPropertyOf', p.superProperties.map(name)),
    ].join('\n'));
  }
  for (const k of v.classes) {
    frames.push([
      `Class: ${name(k.iri)}`,
      ...section('Annotations', annotationsOf(k.iri)),
      ...section('EquivalentTo', objects(s, k.iri, P.equivalentClass).map(expr).sort()),
      ...section('SubClassOf', objects(s, k.iri, P.subClassOf).map(expr).sort()),
      ...section('DisjointWith', objects(s, k.iri, P.disjointWith).filter((t) => t.termType === 'NamedNode').map((t) => name(t.value)).sort()),
    ].join('\n'));
  }
  for (const i of [...v.individuals, ...v.concepts.map((t) => graph.individualView(t.iri)), ...v.conceptSchemes.map((t) => graph.individualView(t.iri))]) {
    const facts: string[] = [];
    for (const p of Object.keys(i.facts)) {
      for (const o of objects(s, i.iri, p)) {
        facts.push(`${name(p)} ${o.termType === 'Literal' ? renderLiteral(o as Literal, prefixes) : name(o.value)}`);
      }
    }
    frames.push([
      `Individual: ${name(i.iri)}`,
      ...section('Annotations', annotationsOf(i.iri)),
      ...section('Types', i.types.map(name)),
      ...section('Facts', facts.sort()),
    ].join('\n'));
  }
  // General axioms
  const general: string[] = [];
  for (const ax of subjects(s, RDF_TYPE, T.AllDisjointClasses)) {
    const members = objects(s, ax, P.members).flatMap((h) => readList(s, h) ?? []).map(expr);
    general.push(`DisjointClasses: \n    ${members.join(',\n    ')}`);
  }
  for (const ax of subjects(s, RDF_TYPE, NS.owl + 'AllDifferent')) {
    const members = [...objects(s, ax, P.members), ...objects(s, ax, NS.owl + 'distinctMembers')].flatMap((h) => readList(s, h) ?? []).map(expr);
    general.push(`DifferentIndividuals: \n    ${members.join(',\n    ')}`);
  }
  frames.push(...general.sort());

  const body = frames.map(track).join('\n\n');
  const prefixLines = Object.entries(prefixes)
    .filter(([p]) => used.has(p))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([p, ns]) => `Prefix: ${p}: <${ns}>`);
  return prefixLines.join('\n') + '\n\n' + body + '\n';
}
