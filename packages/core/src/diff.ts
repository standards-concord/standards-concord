/**
 * Ontology diff: a term-level diff over the view projection plus a
 * blank-node-insensitive triple-level diff (restrictions and other anonymous
 * structures are compared by canonical form, not by blank node id).
 */
import type { Store, Term } from 'n3';
import type {
  ClassView, FieldChange, IndividualView, OntologyDiff, OntologyMetadata, PropertyView, Restriction, TermChange, TermView,
} from './types.js';
import { compactIRI } from './ns.js';
import { canonical } from './rdf.js';
import type { OntologyGraph } from './graph.js';

/** Stable string for a restriction, using full IRIs (also used by classification). */
export function restrictionString(r: Restriction): string {
  const filler = r.filler ? `<${r.filler}>` : r.fillerExpression ? `{${r.fillerExpression}}` : '';
  return [r.kind, `<${r.property}>`, r.cardinality ?? '', filler, r.literal !== undefined ? JSON.stringify(r.literal) : '']
    .filter((x) => x !== '').join(' ');
}

type FieldName = FieldChange['field'];

function fieldValues(t: TermView): Partial<Record<FieldName, string[]>> {
  const one = (v?: string) => (v === undefined ? [] : [v]);
  const base: Partial<Record<FieldName, string[]>> = {
    label: one(t.label),
    definition: one(t.definition),
    comment: one(t.comment),
    altLabels: t.altLabels ?? [],
    examples: t.examples ?? [],
    editorialNote: one(t.editorialNote),
    source: t.source ?? [],
    mappings: Object.entries(t.mappings ?? {}).flatMap(([p, vs]) => vs.map((v) => `<${p}> <${v}>`)),
    deprecated: t.deprecated ? ['true'] : [],
    replacedBy: one(t.replacedBy),
  };
  if (t.kind === 'class') {
    const c = t as ClassView;
    Object.assign(base, {
      superClasses: c.superClasses,
      equivalentClasses: c.equivalentClasses,
      disjointWith: c.disjointWith,
      restrictions: c.restrictions.map(restrictionString),
      superClassExpressions: c.superClassExpressions ?? [],
      equivalentExpressions: c.equivalentExpressions ?? [],
    });
  } else if (t.kind === 'individual') {
    const i = t as IndividualView;
    Object.assign(base, {
      types: i.types,
      facts: Object.entries(i.facts).flatMap(([p, vs]) => vs.map((v) => `<${p}> ${JSON.stringify(v)}`)),
    });
  } else {
    const p = t as PropertyView;
    Object.assign(base, {
      domain: [...p.domain, ...(p.domainExpressions ?? []).map((e) => `{${e}}`)],
      range: [...p.range, ...(p.rangeExpressions ?? []).map((e) => `{${e}}`)],
      superProperties: p.superProperties,
      inverseOf: one(p.inverseOf),
      characteristics: p.characteristics,
    });
  }
  return base;
}

function allTerms(g: OntologyGraph): Map<string, TermView> {
  const v = g.view();
  const m = new Map<string, TermView>();
  for (const t of [...v.classes, ...v.objectProperties, ...v.datatypeProperties, ...v.annotationProperties, ...v.individuals]) {
    m.set(`${t.kind} ${t.iri}`, t);
  }
  return m;
}

/** Human-readable rendering of a field value: compacts IRIs inside the string. */
function pretty(v: string, prefixes: Record<string, string>): string {
  if (/^[a-z][a-z0-9+.-]*:[^\s]*$/i.test(v) && !v.startsWith('<')) return compactIRI(v, prefixes);
  return v.replace(/<([^>\s]+)>/g, (_, iri: string) => compactIRI(iri, prefixes));
}

function compareFields(before: TermView | undefined, after: TermView | undefined): FieldChange[] {
  const a = before ? fieldValues(before) : {};
  const b = after ? fieldValues(after) : {};
  const out: FieldChange[] = [];
  const names = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<FieldName>;
  for (const f of names) {
    const av = new Set(a[f] ?? []);
    const bv = new Set(b[f] ?? []);
    const added = [...bv].filter((x) => !av.has(x)).sort();
    const removed = [...av].filter((x) => !bv.has(x)).sort();
    if (added.length || removed.length) out.push({ field: f, added, removed });
  }
  return out.sort((x, y) => x.field.localeCompare(y.field));
}

function describe(fields: FieldChange[], prefixes: Record<string, string>): string[] {
  return fields.map((f) => {
    const p = (xs: string[]) => xs.map((x) => pretty(x, prefixes));
    if (f.added.length <= 1 && f.removed.length <= 1 && (f.added.length || f.removed.length)) {
      const from = f.removed.length ? p(f.removed)[0] : '∅';
      const to = f.added.length ? p(f.added)[0] : '∅';
      return `${f.field}: ${from} → ${to}`;
    }
    return `${f.field}: ${[...p(f.added).map((x) => `+${x}`), ...p(f.removed).map((x) => `−${x}`)].join(', ')}`;
  });
}

const METADATA_FIELDS: (keyof OntologyMetadata)[] = [
  'iri', 'versionIRI', 'versionInfo', 'priorVersion', 'backwardCompatibleWith', 'incompatibleWith', 'title',
  'description', 'license', 'creators', 'contributors', 'publisher', 'created', 'modified', 'issued',
  'preferredPrefix', 'preferredNamespace', 'imports',
];

function metadataChange(before: OntologyGraph, after: OntologyGraph): TermChange | undefined {
  const a = before.metadata();
  const b = after.metadata();
  const fields: FieldChange[] = [];
  const details: string[] = [];
  for (const k of METADATA_FIELDS) {
    const av = ([] as string[]).concat((a[k] as string | string[] | undefined) ?? []);
    const bv = ([] as string[]).concat((b[k] as string | string[] | undefined) ?? []);
    const added = bv.filter((x) => !av.includes(x)).map((x) => `${k}: ${x}`);
    const removed = av.filter((x) => !bv.includes(x)).map((x) => `${k}: ${x}`);
    if (added.length || removed.length) {
      fields.push({ field: 'metadata', added, removed });
      details.push(`${k}: ${av.join(', ') || '∅'} → ${bv.join(', ') || '∅'}`);
    }
  }
  if (!fields.length) return undefined;
  return { iri: b.iri || a.iri, label: b.title ?? a.title, kind: 'ontology', change: 'modified', details, fields };
}

/** Blank-node-insensitive triple lines: named-subject triples plus root blank structures. */
export function canonicalTriples(store: Store): Set<string> {
  const lines = new Set<string>();
  const referenced = new Set<string>();
  for (const q of store.getQuads(null, null, null, null)) if (q.object.termType === 'BlankNode') referenced.add(q.object.value);
  for (const q of store.getQuads(null, null, null, null)) {
    if (q.subject.termType === 'NamedNode') {
      lines.add(`<${q.subject.value}> <${q.predicate.value}> ${canonical(store, q.object as Term)} .`);
    } else if (q.subject.termType === 'BlankNode' && !referenced.has(q.subject.value)) {
      lines.add(`${canonical(store, q.subject as Term)} .`);
    }
  }
  return lines;
}

/** Provenance the change engine stamps on edited terms; not part of what a term means. */
const PROVENANCE = new Set(['http://purl.org/dc/terms/created', 'http://purl.org/dc/terms/modified', 'http://purl.org/dc/terms/contributor', 'http://purl.org/dc/terms/source']);

/**
 * Everything a graph says about one term, as a stable string: its own
 * triples (blank-node structures such as restrictions in canonical form) and
 * any anonymous axioms that mention it (e.g. owl:AllDisjointClasses), minus
 * provenance. Two graphs agree on a term exactly when these strings are equal,
 * whoever made the edit and when. An absent term gives ''.
 */
export function termDescription(g: OntologyGraph, iri: string): string {
  const store = g.store;
  const lines: string[] = [];
  for (const q of store.getQuads(iri, null, null, null)) {
    if (PROVENANCE.has(q.predicate.value)) continue;
    lines.push(`<${q.predicate.value}> ${canonical(store, q.object as Term)}`);
  }
  const referenced = new Set<string>();
  for (const q of store.getQuads(null, null, null, null)) if (q.object.termType === 'BlankNode') referenced.add(q.object.value);
  const needle = `<${iri}>`;
  for (const q of store.getQuads(null, null, null, null)) {
    if (q.subject.termType !== 'BlankNode' || referenced.has(q.subject.value)) continue;
    const c = canonical(store, q.subject as Term);
    if (c.includes(needle)) lines.push(c);
  }
  return [...new Set(lines)].sort().join('\n');
}

export function diffOntologies(before: OntologyGraph, after: OntologyGraph): OntologyDiff {
  const prefixes = { ...before.prefixes, ...after.prefixes };
  const a = allTerms(before);
  const b = allTerms(after);
  const terms: TermChange[] = [];
  const meta = metadataChange(before, after);
  if (meta) terms.push(meta);

  for (const key of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const tb = a.get(key);
    const ta = b.get(key);
    const t = (ta ?? tb)!;
    const fields = compareFields(tb, ta);
    let change: TermChange['change'];
    if (!tb) change = 'added';
    else if (!ta) change = 'removed';
    else if (!tb.deprecated && ta.deprecated) change = 'deprecated';
    else if (tb.deprecated && !ta.deprecated) change = 'undeprecated';
    else if (fields.length) change = 'modified';
    else continue;
    const details = change === 'added' ? [`added ${t.kind}`] : change === 'removed' ? [`removed ${t.kind}`] : describe(fields, prefixes);
    terms.push({ iri: t.iri, label: ta?.label ?? tb?.label, kind: t.kind, change, details, fields });
  }

  const ta = canonicalTriples(before.store);
  const tb = canonicalTriples(after.store);
  const addedNTriples = [...tb].filter((x) => !ta.has(x)).sort();
  const removedNTriples = [...ta].filter((x) => !tb.has(x)).sort();
  return { terms, addedTriples: addedNTriples.length, removedTriples: removedNTriples.length, addedNTriples, removedNTriples };
}
