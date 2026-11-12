/**
 * LinkML export/import.
 *
 * Mapping (OWL → LinkML):
 *  - owl:Class → class (class_uri; is_a = first named superclass in the ontology,
 *    other superclasses as an annotation; external superclasses as broad_mappings)
 *  - skos:definition → description; rdfs:label → title; skos:altLabel → aliases
 *  - object/datatype properties → slots (slot_uri, range = class name or LinkML type,
 *    domain, inverse, is_a); properties whose domain includes a class are listed in its `slots`
 *  - `some` / min ≥ 1 / exactly ≥ 1 restrictions → slot_usage required: true;
 *    max 1 / exactly 1 / functional → multivalued: false; `only` → slot_usage range
 *  - classes equivalent to owl:oneOf → enums
 *  - owl:deprecated → deprecated (history note text)
 */
import YAML from 'yaml';
import type { Term } from 'n3';
import type { ClassView, PropertyView } from './types.js';
import { NS, RDF_TYPE, compactIRI, expandIRI, humanize, isBuiltinDatatype, localName } from './ns.js';
import { blankNode, langLit, literal, nn, objects, readList, typedLit, writeList } from './rdf.js';
import { OntologyGraph, P, T, declareAnnotationProperties } from './graph.js';
import { writeRestriction } from './changes.js';
import { distributionNotice, noticeComment } from './notices.js';

const XSD_TO_LINKML: Record<string, string> = {
  string: 'string', normalizedString: 'string', token: 'string', language: 'string',
  integer: 'integer', int: 'integer', long: 'integer', short: 'integer', byte: 'integer',
  nonNegativeInteger: 'integer', positiveInteger: 'integer', nonPositiveInteger: 'integer', negativeInteger: 'integer',
  unsignedInt: 'integer', unsignedLong: 'integer', unsignedShort: 'integer', unsignedByte: 'integer',
  decimal: 'decimal', boolean: 'boolean', date: 'date', dateTime: 'datetime', dateTimeStamp: 'datetime', time: 'time',
  anyURI: 'uri', float: 'float', double: 'double',
};
const LINKML_TO_XSD: Record<string, string> = {
  string: 'string', integer: 'integer', decimal: 'decimal', boolean: 'boolean', date: 'date', datetime: 'dateTime',
  time: 'time', uri: 'anyURI', uriorcurie: 'anyURI', float: 'float', double: 'double', ncname: 'string',
};
const MIN_VALUE: Record<string, number> = { nonNegativeInteger: 0, positiveInteger: 1, unsignedInt: 0, unsignedLong: 0, unsignedShort: 0, unsignedByte: 0 };
const MAPPING_KEYS: Record<string, string> = {
  [NS.skos + 'exactMatch']: 'exact_mappings', [NS.skos + 'closeMatch']: 'close_mappings', [NS.skos + 'broadMatch']: 'broad_mappings',
  [NS.skos + 'narrowMatch']: 'narrow_mappings', [NS.skos + 'relatedMatch']: 'related_mappings', [NS.rdfs + 'seeAlso']: 'see_also',
};

type Obj = Record<string, unknown>;

export function toLinkML(graph: OntologyGraph): string {
  const v = graph.view();
  const m = v.metadata;
  const ns = graph.namespace;
  const s = graph.store;
  const usedPrefixes = new Set<string>();
  const curie = (iri: string) => {
    const c = compactIRI(iri, graph.prefixes);
    if (c !== iri) usedPrefixes.add(c.slice(0, c.indexOf(':')));
    return c;
  };
  const isLocal = (iri: string) => !!ns && iri.startsWith(ns);
  const pref = m.preferredPrefix ?? (Object.entries(graph.prefixes).find(([, n]) => n === ns)?.[0] || 'ont');

  // Enumerations: classes defined as owl:oneOf.
  const enumMembers = new Map<string, string[]>();
  for (const k of v.classes) {
    for (const e of objects(s, k.iri, P.equivalentClass)) {
      const head = e.termType === 'BlankNode' ? objects(s, e, NS.owl + 'oneOf')[0] : undefined;
      if (head) enumMembers.set(k.iri, (readList(s, head) ?? []).map((t) => t.value));
    }
  }
  const localClasses = v.classes.filter((k) => isLocal(k.iri));
  const knownClass = new Set(localClasses.map((k) => k.iri));
  const name = (iri: string) => localName(iri);
  // LinkML convention: slots are snake_case; slot_uri keeps the OWL IRI.
  const slotName = (iri: string) => snakeCase(localName(iri));

  // External classes referenced as ranges get stub classes so the schema stays closed.
  const stubs = new Map<string, Obj>();
  const rangeOf = (iri: string): { range?: string; minimum_value?: number } => {
    if (isBuiltinDatatype(iri)) {
      const ln = iri.startsWith(NS.xsd) ? iri.slice(NS.xsd.length) : 'string';
      return { range: XSD_TO_LINKML[ln] ?? 'string', ...(MIN_VALUE[ln] !== undefined ? { minimum_value: MIN_VALUE[ln] } : {}) };
    }
    if (knownClass.has(iri)) return { range: name(iri) };
    if (!stubs.has(iri)) stubs.set(iri, { class_uri: curie(iri), description: `External class ${curie(iri)} (referenced, not defined here).` });
    return { range: name(iri) };
  };

  const props = [...v.objectProperties, ...v.datatypeProperties].filter((p) => isLocal(p.iri));
  const propByIri = new Map(props.map((p) => [p.iri, p]));
  const domainOf = (p: PropertyView): string[] => {
    const out = [...p.domain];
    for (const d of objects(s, p.iri, P.domain)) {
      if (d.termType !== 'BlankNode') continue;
      for (const head of objects(s, d, NS.owl + 'unionOf')) for (const mm of readList(s, head) ?? []) out.push(mm.value);
    }
    return out;
  };

  const mappingsOf = (t: { mappings?: Record<string, string[]> }): Obj => {
    const out: Obj = {};
    for (const [p, vals] of Object.entries(t.mappings ?? {})) if (MAPPING_KEYS[p]) out[MAPPING_KEYS[p]] = vals.map(curie);
    return out;
  };
  const common = (t: ClassView | PropertyView): Obj => clean({
    title: t.label,
    description: t.definition,
    aliases: t.altLabels?.length ? t.altLabels : undefined,
    comments: t.comment ? [t.comment] : undefined,
    examples: t.examples?.length ? t.examples.map((e) => ({ value: e })) : undefined,
    deprecated: t.deprecated ? (objects(s, t.iri, P.historyNote)[0]?.value ?? 'deprecated') : undefined,
    deprecated_element_has_exact_replacement: t.replacedBy ? curie(t.replacedBy) : undefined,
    ...mappingsOf(t),
  });

  const classes: Obj = {};
  for (const k of localClasses) {
    if (enumMembers.has(k.iri)) continue;
    const local = k.superClasses.filter((sc) => knownClass.has(sc) && !enumMembers.has(sc));
    const external = k.superClasses.filter((sc) => !knownClass.has(sc));
    const slots = new Set<string>();
    for (const p of props) if (domainOf(p).includes(k.iri)) slots.add(slotName(p.iri));
    const usage: Record<string, Obj> = {};
    for (const r of k.restrictions) {
      const p = propByIri.get(r.property);
      if (!p) continue;
      const sn = slotName(p.iri);
      slots.add(sn);
      const u = (usage[sn] ??= {});
      const n = r.cardinality ?? 0;
      if (r.kind === 'some' || ((r.kind === 'min' || r.kind === 'exactly') && n >= 1)) u.required = true;
      if ((r.kind === 'max' || r.kind === 'exactly') && n <= 1) u.multivalued = false;
      if (r.kind === 'only' && r.filler) u.range = rangeOf(r.filler).range;
      if ((r.kind === 'some' || r.kind === 'min' || r.kind === 'exactly') && r.filler && r.filler !== p.range[0] && !isBuiltinDatatype(r.filler)) {
        u.range = rangeOf(r.filler).range;
      }
      if (r.kind === 'value') u.equals_string = r.literal ?? curie(r.filler!);
    }
    const annotations: Obj = {};
    if (local.length > 1) annotations.additional_superclasses = local.slice(1).map(curie).join(' ');
    if (k.superClassExpressions?.length || k.equivalentExpressions?.length) {
      annotations.owl_axioms = [...(k.equivalentExpressions ?? []).map((e) => `EquivalentTo: ${e}`), ...(k.superClassExpressions ?? []).map((e) => `SubClassOf: ${e}`)].join('; ');
    }
    if (k.disjointWith.length) annotations.disjoint_with = k.disjointWith.map(curie).join(' ');
    const external_m = external.length ? { broad_mappings: [...((mappingsOf(k).broad_mappings as string[]) ?? []), ...external.map(curie)] } : {};
    classes[name(k.iri)] = clean({
      class_uri: curie(k.iri),
      ...common(k),
      ...external_m,
      is_a: local[0] ? name(local[0]) : undefined,
      slots: slots.size ? [...slots].sort() : undefined,
      slot_usage: Object.keys(usage).length ? sortObj(usage) : undefined,
      annotations: Object.keys(annotations).length ? annotations : undefined,
    });
  }

  const slots: Obj = {};
  for (const p of props) {
    const functional = p.characteristics.includes('functional');
    const range = p.codeList ? { range: name(p.codeList) } : p.range.length === 1 ? rangeOf(p.range[0]) : {};
    const anyOf = (p.rangeExpressions ?? []).length || p.range.length > 1
      ? (() => {
          const members: string[] = [];
          for (const r of objects(s, p.iri, P.range)) {
            if (r.termType === 'NamedNode') members.push(r.value);
            else for (const head of objects(s, r, NS.owl + 'unionOf')) for (const mm of readList(s, head) ?? []) members.push(mm.value);
          }
          return members.length ? members.map((mm) => ({ range: rangeOf(mm).range })) : undefined;
        })()
      : undefined;
    const dom = domainOf(p).filter((d) => knownClass.has(d));
    slots[slotName(p.iri)] = clean({
      slot_uri: curie(p.iri),
      ...common(p),
      ...range,
      any_of: anyOf,
      domain: dom.length === 1 ? name(dom[0]) : undefined,
      multivalued: functional ? false : p.kind === 'objectProperty' ? true : undefined,
      inverse: p.inverseOf && propByIri.has(p.inverseOf) ? slotName(p.inverseOf) : undefined,
      is_a: p.superProperties.find((sp) => propByIri.has(sp)) ? slotName(p.superProperties.find((sp) => propByIri.has(sp))!) : undefined,
    });
  }

  const enums: Obj = {};
  for (const scheme of v.conceptSchemes.filter((t) => isLocal(t.iri))) {
    const keys = new Set<string>();
    const permissibleValues = v.concepts.filter((c) => c.inScheme.includes(scheme.iri)).map((code) => {
      const base = code.notation ?? name(code.iri);
      let key = base;
      for (let suffix = 2; keys.has(key); suffix++) key = `${base}-${suffix}`;
      keys.add(key);
      return [key, clean({ meaning: code.iri, description: code.definition })];
    });
    enums[name(scheme.iri)] = clean({
      enum_uri: curie(scheme.iri), description: scheme.definition,
      permissible_values: Object.fromEntries(permissibleValues),
    });
  }
  for (const [iri, members] of enumMembers) {
    const k = v.classes.find((c) => c.iri === iri)!;
    enums[name(iri)] = clean({
      enum_uri: curie(iri),
      description: k.definition,
      permissible_values: Object.fromEntries(members.map((mm) => [name(mm), clean({ meaning: curie(mm), description: graph.term(mm)?.label })])),
    });
  }
  for (const [iri, stub] of stubs) if (!classes[name(iri)]) classes[name(iri)] = stub;

  const prefixes: Record<string, string> = { linkml: 'https://w3id.org/linkml/', [pref]: ns };
  for (const p of [...usedPrefixes].sort()) if (graph.prefixes[p] && !prefixes[p]) prefixes[p] = graph.prefixes[p];
  const schema = clean({
    id: m.iri,
    name: sanitizeName(m.preferredPrefix ?? localName(m.iri) ?? 'ontology'),
    title: m.title,
    description: m.description,
    license: m.license,
    version: m.versionInfo,
    prefixes,
    default_prefix: pref,
    default_range: 'string',
    imports: ['linkml:types'],
    classes: sortObj(classes),
    slots: sortObj(slots),
    enums: Object.keys(enums).length ? sortObj(enums) : undefined,
  });
  return noticeComment(distributionNotice(graph)) + YAML.stringify(schema, { lineWidth: 0 });
}

/* ------------------------------------------------------------------------ */

/** Imports the OWL-expressible subset of a LinkML schema. */
export async function fromLinkML(yamlText: string): Promise<OntologyGraph> {
  const doc = YAML.parse(yamlText) as Obj;
  const rawPrefixes = (doc.prefixes ?? {}) as Record<string, string | { prefix_reference: string }>;
  const prefixes: Record<string, string> = {};
  for (const [p, val] of Object.entries(rawPrefixes)) prefixes[p] = typeof val === 'string' ? val : val.prefix_reference;
  const id = String(doc.id ?? 'https://example.org/linkml-import');
  const defaultPrefix = String(doc.default_prefix ?? doc.name ?? 'ont');
  const ns = prefixes[defaultPrefix] ?? (/[#/]$/.test(id) ? id : id + '#');
  prefixes[defaultPrefix] = ns;
  const g = OntologyGraph.empty({
    iri: id, namespace: ns, prefix: defaultPrefix, title: String(doc.title ?? doc.name ?? 'Imported LinkML schema'),
    description: doc.description ? String(doc.description) : undefined, license: doc.license ? String(doc.license) : undefined,
  });
  for (const [p, val] of Object.entries(prefixes)) if (!(p in g.prefixes)) g.prefixes[p] = val;
  const s = g.store;
  const add = (subj: Term | string, p: string, o: Term) => s.addQuad((typeof subj === 'string' ? nn(subj) : subj) as any, nn(p), o as any);
  if (doc.version) {
    for (const q of s.getQuads(nn(id), nn(NS.owl + 'versionInfo'), null, null)) s.removeQuad(q);
    for (const q of s.getQuads(nn(id), nn(NS.owl + 'versionIRI'), null, null)) s.removeQuad(q);
    add(id, NS.owl + 'versionInfo', literal(String(doc.version)));
    add(id, NS.owl + 'versionIRI', nn(`${id.replace(/[#/]$/, '')}/${doc.version}`));
  }
  const ex = (c: string) => expandIRI(c, prefixes);
  const classes = (doc.classes ?? {}) as Record<string, Obj>;
  const slots = (doc.slots ?? {}) as Record<string, Obj>;
  const enums = (doc.enums ?? {}) as Record<string, Obj>;
  const classIri = (n: string) => (classes[n]?.class_uri ? ex(String(classes[n].class_uri)) : enums[n]?.enum_uri ? ex(String(enums[n].enum_uri)) : ns + n);
  const slotIri = (n: string) => (slots[n]?.slot_uri ? ex(String(slots[n].slot_uri)) : ns + n.replace(/_([a-z0-9])/g, (_, ch: string) => ch.toUpperCase()));
  const isClassRange = (r?: string) => !!r && (r in classes || r in enums);
  const xsdOf = (r?: string) => NS.xsd + (LINKML_TO_XSD[r ?? 'string'] ?? 'string');

  const annotate = (iri: string, el: Obj, nm: string) => {
    add(iri, P.label, langLit(String(el.title ?? humanize(nm))));
    if (el.description) add(iri, P.definition, langLit(String(el.description)));
    for (const a of (el.aliases as string[] | undefined) ?? []) add(iri, P.altLabel, langLit(a));
    for (const c of (el.comments as string[] | undefined) ?? []) add(iri, P.comment, langLit(c));
    add(iri, P.isDefinedBy, nn(id));
    if (el.deprecated) {
      add(iri, P.deprecated, typedLit('true', NS.xsd + 'boolean'));
      add(iri, P.historyNote, langLit(String(el.deprecated)));
    }
    for (const [pIri, key] of Object.entries(MAPPING_KEYS)) for (const t of (el[key] as string[] | undefined) ?? []) add(iri, pIri, nn(ex(t)));
  };

  const slotUsers = new Map<string, Set<string>>();
  for (const [cn, c] of Object.entries(classes)) {
    // Stub classes for external terms are referenced, not defined.
    const iri = classIri(cn);
    const external = !iri.startsWith(ns);
    add(iri, RDF_TYPE, nn(T.Class));
    if (external) continue;
    annotate(iri, c, cn);
    for (const parent of [c.is_a, ...((c.mixins as string[]) ?? [])].filter(Boolean) as string[]) add(iri, P.subClassOf, nn(classIri(parent)));
    for (const sn of (c.slots as string[] | undefined) ?? []) {
      if (!slotUsers.has(sn)) slotUsers.set(sn, new Set());
      slotUsers.get(sn)!.add(iri);
    }
    for (const [sn, u] of Object.entries((c.slot_usage ?? {}) as Record<string, Obj>)) {
      const slot = slots[sn] ?? {};
      const rangeName = (u.range ?? slot.range) as string | undefined;
      const filler = isClassRange(rangeName) ? classIri(rangeName!) : xsdOf(rangeName);
      if (u.required) g.store.addQuad(nn(iri), nn(P.subClassOf), writeRestriction(g, { property: slotIri(sn), kind: 'some', filler }) as any);
      if (u.multivalued === false && slot.multivalued !== false) {
        g.store.addQuad(nn(iri), nn(P.subClassOf), writeRestriction(g, { property: slotIri(sn), kind: 'max', cardinality: 1, filler }) as any);
      }
      if (u.range && u.range !== slot.range && !u.required) {
        g.store.addQuad(nn(iri), nn(P.subClassOf), writeRestriction(g, { property: slotIri(sn), kind: 'only', filler }) as any);
      }
    }
  }
  for (const [sn, sl] of Object.entries(slots)) {
    const iri = slotIri(sn);
    const ranges = sl.any_of ? (sl.any_of as Obj[]).map((a) => a.range as string) : [sl.range as string | undefined];
    const isObj = ranges.some(isClassRange);
    add(iri, RDF_TYPE, nn(isObj ? T.ObjectProperty : T.DatatypeProperty));
    annotate(iri, sl, sn);
    if (sl.multivalued === false) add(iri, RDF_TYPE, nn(NS.owl + 'FunctionalProperty'));
    const rangeTerms = ranges.map((r) => nn(isObj ? classIri(r!) : xsdOf(r)));
    if (rangeTerms.length === 1) add(iri, P.range, rangeTerms[0]);
    else if (rangeTerms.length > 1) {
      const u = blankNode();
      add(u, RDF_TYPE, nn(isObj ? T.Class : T.Datatype));
      add(u, NS.owl + 'unionOf', writeList(s, rangeTerms));
      add(iri, P.range, u);
    }
    const domains = sl.domain ? [classIri(String(sl.domain))] : [...(slotUsers.get(sn) ?? [])].sort();
    if (domains.length === 1) add(iri, P.domain, nn(domains[0]));
    else if (domains.length > 1) {
      const u = blankNode();
      add(u, RDF_TYPE, nn(T.Class));
      add(u, NS.owl + 'unionOf', writeList(s, domains.map(nn)));
      add(iri, P.domain, u);
    }
    if (sl.inverse) add(iri, P.inverseOf, nn(slotIri(String(sl.inverse))));
    if (sl.is_a) add(iri, P.subPropertyOf, nn(slotIri(String(sl.is_a))));
    if (sl.required && sl.domain) g.store.addQuad(nn(classIri(String(sl.domain))), nn(P.subClassOf), writeRestriction(g, { property: iri, kind: 'some', filler: rangeTerms[0]?.value ?? NS.owl + 'Thing' }) as any);
  }
  for (const [en, e] of Object.entries(enums)) {
    const iri = classIri(en);
    add(iri, RDF_TYPE, nn(T.Class));
    annotate(iri, e, en);
    const members: Term[] = [];
    for (const [pv, pvDef] of Object.entries((e.permissible_values ?? {}) as Record<string, Obj | null>)) {
      const mIri = pvDef?.meaning ? ex(String(pvDef.meaning)) : ns + pv.replace(/[^A-Za-z0-9-]/g, '');
      add(mIri, RDF_TYPE, nn(T.NamedIndividual));
      add(mIri, RDF_TYPE, nn(iri));
      add(mIri, P.label, langLit(String(pvDef?.description ?? pv)));
      members.push(nn(mIri));
    }
    if (members.length) {
      const one = blankNode();
      add(one, RDF_TYPE, nn(T.Class));
      add(one, NS.owl + 'oneOf', writeList(s, members));
      add(iri, P.equivalentClass, one);
    }
  }
  declareAnnotationProperties(s, [P.definition, P.altLabel, P.historyNote, ...Object.keys(MAPPING_KEYS).filter((k) => k.startsWith(NS.skos))]);
  return g;
}

/* ------------------------------------------------------------------------ */

function clean(o: Obj): Obj {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

function sortObj<T>(o: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
}

function snakeCase(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2').replace(/[-\s]+/g, '_').toLowerCase();
}

function sanitizeName(s: string): string {
  const n = s.replace(/[^A-Za-z0-9_]/g, '_');
  return /^[A-Za-z_]/.test(n) ? n : `_${n}`;
}
