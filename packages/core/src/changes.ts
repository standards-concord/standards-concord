/**
 * Structured change operations: the only way the platform mutates an ontology.
 *
 * `applyChangeOps` clones the input graph, validates every op against the
 * current state (so later ops can reference terms added by earlier ones) and
 * throws `ChangeOpError` on the first invalid op.
 */
import type { Store, Term } from 'n3';
import type { ChangeOp, IRI, PropertyCharacteristic, Restriction, TermAnnotations } from './types.js';
import { NS, RDF_TYPE, expandIRI, isBuiltinDatatype, isValidLocalName, isWellKnown, today } from './ns.js';
import {
  blankNode, canonical, defaultGraph, langLit, literal, nn, objects, readList, removeBlankSubtree, subjects, typedLit, writeList,
  RDF_FIRST, RDF_REST,
} from './rdf.js';
import {
  CHARACTERISTIC_TYPES, OntologyGraph, P, T, declareAnnotationProperties, looksLikeIRI, restrictionKey,
} from './graph.js';

export class ChangeOpError extends Error {
  opIndex: number;
  constructor(message: string, opIndex: number) {
    super(`op #${opIndex}: ${message}`);
    this.name = 'ChangeOpError';
    this.opIndex = opIndex;
  }
}

export interface ChangeContext {
  author?: string;
  date?: string;
  source?: string;
}

export interface ApplyResult {
  graph: OntologyGraph;
  warnings: string[];
  touched: string[];
}

export function applyChangeOps(graph: OntologyGraph, ops: ChangeOp[], ctx: ChangeContext = {}): ApplyResult {
  const g = graph.clone();
  const warnings: string[] = [];
  const touched = new Set<string>();
  ops.forEach((op, i) => {
    try {
      applyOne(g, op, ctx, warnings, touched);
    } catch (e) {
      if (e instanceof ChangeOpError) throw e;
      throw new ChangeOpError((e as Error).message, i);
    }
  });
  return { graph: g, warnings, touched: [...touched].sort() };
}

class OpFail extends Error {}
const fail = (msg: string): never => {
  throw new OpFail(msg);
};

const ANNOTATION_FIELDS: Record<keyof Omit<TermAnnotations, 'mappings'>, string> = {
  label: P.label,
  definition: P.definition,
  comment: P.comment,
  altLabels: P.altLabel,
  examples: P.example,
  editorialNote: P.editorialNote,
  source: P.source,
};

function applyOne(g: OntologyGraph, op: ChangeOp, ctx: ChangeContext, warnings: string[], touched: Set<string>): void {
  const s = g.store;
  const ex = (i: IRI) => expandIRI(i, g.prefixes);
  const known = (iri: IRI) => g.isDeclared(iri) || isWellKnown(iri) || isBuiltinDatatype(iri) || inImports(g, iri);
  const requireKnown = (iri: IRI, what: string) => {
    if (!known(iri)) fail(`unknown ${what} <${iri}>: declare it first (or use a well-known vocabulary term)`);
    return iri;
  };
  const requireTerm = (iri: IRI) => {
    if (!g.isDeclared(iri)) fail(`term <${iri}> does not exist in this ontology`);
    return iri;
  };
  const requireClass = (iri: IRI) => {
    if (!g.isClassIri(iri) && !(isWellKnown(iri) && !isBuiltinDatatype(iri)) && !inImports(g, iri)) fail(`<${iri}> is not a declared class`);
    return iri;
  };
  const add = (subj: Term | string, p: string, o: Term) => s.addQuad((typeof subj === 'string' ? nn(subj) : subj) as any, nn(p), o as any);
  const removeAll = (subj: string, p: string, filter: (t: Term) => boolean = () => true) => {
    for (const o of objects(s, subj, p)) {
      if (!filter(o)) continue;
      s.removeQuad(nn(subj), nn(p), o as any, defaultGraph());
      removeBlankSubtree(s, o);
    }
  };
  const date = ctx.date ?? today();
  const usedAnnotations = new Set<string>();
  const annotate = (iri: string, set: TermAnnotations) => {
    for (const [field, pred] of Object.entries(ANNOTATION_FIELDS) as [keyof typeof ANNOTATION_FIELDS, string][]) {
      const v = set[field];
      if (v === undefined) continue;
      // Replace English/untagged values; keep other-language translations.
      removeAll(iri, pred, (t) => t.termType !== 'Literal' || !('language' in t) || !(t as any).language || (t as any).language.startsWith('en'));
      const values = Array.isArray(v) ? v : [v];
      for (const val of values) {
        if (val === '' || val === null) continue;
        if (field === 'source') add(iri, pred, looksLikeIRI(val) ? nn(val) : literal(val));
        else add(iri, pred, langLit(val.trim()));
        usedAnnotations.add(pred);
      }
    }
    if (set.mappings) {
      for (const [p, targets] of Object.entries(set.mappings)) {
        const pred = ex(p);
        removeAll(iri, pred);
        for (const t of targets) add(iri, pred, nn(ex(t)));
        usedAnnotations.add(pred);
      }
    }
  };
  const newTerm = (localName: string, kind: 'class' | 'property' | 'individual', type: string, fields: TermAnnotations & { label: string; definition?: string }) => {
    if (!isValidLocalName(localName, kind)) {
      fail(`invalid local name "${localName}": ${kind === 'class' ? 'classes use UpperCamelCase' : kind === 'property' ? 'properties use lowerCamelCase' : 'individuals use letters, digits and hyphens'} with no spaces or underscores`);
    }
    if (!g.namespace) fail('ontology has no namespace (no owl:Ontology header)');
    const iri = g.namespace + localName;
    if (s.countQuads(nn(iri), null, null, null) > 0) fail(`term <${iri}> already exists`);
    if (!fields.label?.trim()) fail('label is required');
    if (kind !== 'individual' && !fields.definition?.trim()) fail('definition is required');
    const clash = findLabel(g, fields.label);
    if (clash) warnings.push(`label "${fields.label}" is already used by <${clash}>`);
    add(iri, RDF_TYPE, nn(type));
    annotate(iri, fields);
    if (g.ontologyIRI) add(iri, P.isDefinedBy, nn(g.ontologyIRI));
    add(iri, P.created, typedLit(date, NS.xsd + 'date'));
    if (ctx.author) add(iri, P.contributor, looksLikeIRI(ctx.author) ? nn(ctx.author) : literal(ctx.author));
    if (ctx.source && !(fields.source ?? []).includes(ctx.source)) add(iri, P.source, looksLikeIRI(ctx.source) ? nn(ctx.source) : literal(ctx.source));
    usedAnnotations.add(P.created).add(P.definition);
    if (ctx.author) usedAnnotations.add(P.contributor);
    if (ctx.source || fields.source?.length) usedAnnotations.add(P.source);
    touched.add(iri);
    return iri;
  };

  switch (op.op) {
    case 'addClass': {
      const supers = (op.subClassOf ?? []).map(ex).map(requireClass);
      const eqs = (op.equivalentTo ?? []).map(ex).map(requireClass);
      const disj = (op.disjointWith ?? []).map(ex).map(requireClass);
      const restrictions = (op.restrictions ?? []).map((r) => normaliseRestriction(g, r, ex, requireKnown));
      const iri = newTerm(op.localName, 'class', T.Class, op);
      for (const sc of supers) add(iri, P.subClassOf, nn(sc));
      for (const e of eqs) add(iri, P.equivalentClass, nn(e));
      for (const d of disj) add(iri, P.disjointWith, nn(d));
      for (const r of restrictions) add(iri, P.subClassOf, writeRestriction(g, r));
      break;
    }
    case 'addObjectProperty':
    case 'addDatatypeProperty': {
      const isObj = op.op === 'addObjectProperty';
      const domain = (op.domain ?? []).map(ex).map(requireClass);
      const range = (op.range ?? []).map(ex).map((r) => requireKnown(r, 'range'));
      for (const r of range) {
        const dt = isDatatype(g, r);
        if (isObj && dt) fail(`object property range <${r}> is a datatype; use addDatatypeProperty`);
        if (!isObj && !dt) fail(`datatype property range <${r}> must be an XSD/RDF datatype`);
      }
      const supers = (op.subPropertyOf ?? []).map(ex).map((p) => requireKnown(p, 'super-property'));
      const inverse = isObj && op.inverseOf ? requireKnown(ex(op.inverseOf), 'inverse property') : undefined;
      const characteristics = isObj ? (op.characteristics ?? []) : op.functional ? (['functional'] as PropertyCharacteristic[]) : [];
      const iri = newTerm(op.localName, 'property', isObj ? T.ObjectProperty : T.DatatypeProperty, op);
      for (const d of domain) add(iri, P.domain, nn(d));
      for (const r of range) add(iri, P.range, nn(r));
      for (const sp of supers) add(iri, P.subPropertyOf, nn(sp));
      if (inverse) add(iri, P.inverseOf, nn(inverse));
      for (const c of characteristics) add(iri, RDF_TYPE, nn(characteristicType(c)));
      if (!domain.length) warnings.push(`<${iri}> has no domain`);
      if (!range.length) warnings.push(`<${iri}> has no range`);
      break;
    }
    case 'addIndividual': {
      const types = op.types.map(ex).map(requireClass);
      if (!types.length) fail('an individual needs at least one type');
      const facts = Object.entries(op.facts ?? {}).map(([p, vals]) => [requireKnown(ex(p), 'property'), vals] as const);
      const iri = newTerm(op.localName, 'individual', T.NamedIndividual, op);
      for (const t of types) add(iri, RDF_TYPE, nn(t));
      for (const [p, vals] of facts) for (const v of vals) add(iri, p, factValue(g, p, v, ex, requireKnown));
      break;
    }
    case 'updateAnnotations': {
      const iri = requireTerm(ex(op.iri));
      if (op.set.label !== undefined && !op.set.label.trim()) fail('label cannot be empty');
      if (op.set.label) {
        const clash = findLabel(g, op.set.label, iri);
        if (clash) warnings.push(`label "${op.set.label}" is already used by <${clash}>`);
      }
      annotate(iri, op.set);
      touched.add(iri);
      break;
    }
    case 'setSuperClasses': {
      const iri = requireTerm(ex(op.iri));
      if (!g.isClassIri(iri)) fail(`<${iri}> is not a class`);
      const supers = op.superClasses.map(ex).map(requireClass);
      if (supers.includes(iri)) fail('a class cannot be its own superclass');
      removeAll(iri, P.subClassOf, (t) => t.termType === 'NamedNode');
      for (const sc of supers) add(iri, P.subClassOf, nn(sc));
      touched.add(iri);
      break;
    }
    case 'setDomainRange': {
      const iri = requireTerm(ex(op.iri));
      const kinds = g.kindsOf(iri);
      if (!kinds.has('objectProperty') && !kinds.has('datatypeProperty')) fail(`<${iri}> is not an object or datatype property`);
      if (op.domain) {
        const domain = op.domain.map(ex).map(requireClass);
        removeAll(iri, P.domain);
        for (const d of domain) add(iri, P.domain, nn(d));
      }
      if (op.range) {
        const range = op.range.map(ex).map((r) => requireKnown(r, 'range'));
        for (const r of range) {
          const dt = isDatatype(g, r);
          if (kinds.has('objectProperty') && dt) fail(`object property range <${r}> is a datatype`);
          if (kinds.has('datatypeProperty') && !dt) fail(`datatype property range <${r}> must be a datatype`);
        }
        removeAll(iri, P.range);
        for (const r of range) add(iri, P.range, nn(r));
      }
      touched.add(iri);
      break;
    }
    case 'addRestriction': {
      const iri = requireTerm(ex(op.classIri));
      if (!g.isClassIri(iri)) fail(`<${iri}> is not a class`);
      const r = normaliseRestriction(g, op.restriction, ex, requireKnown);
      if (findRestriction(g, iri, r)) fail('the class already has this restriction');
      add(iri, P.subClassOf, writeRestriction(g, r));
      touched.add(iri);
      break;
    }
    case 'removeRestriction': {
      const iri = requireTerm(ex(op.classIri));
      const r = normaliseRestriction(g, op.restriction, ex, (iri) => iri);
      const node = findRestriction(g, iri, r);
      if (!node) fail('restriction not found on class');
      s.removeQuad(nn(iri), nn(P.subClassOf), node as any, defaultGraph());
      removeBlankSubtree(s, node!);
      touched.add(iri);
      break;
    }
    case 'addDisjointness': {
      const classes = [...new Set(op.classes.map(ex))].map(requireClass);
      if (classes.length < 2) fail('disjointness needs at least two distinct classes');
      if (classes.length === 2) add(classes[0], P.disjointWith, nn(classes[1]));
      else {
        const ax = blankNode();
        add(ax, RDF_TYPE, nn(T.AllDisjointClasses));
        add(ax, P.members, writeList(s, classes.map(nn)));
      }
      classes.forEach((c) => touched.add(c));
      break;
    }
    case 'removeDisjointness': {
      const classes = [...new Set(op.classes.map(ex))];
      if (classes.length < 2) fail('need at least two classes');
      let removed = 0;
      const inSet = new Set(classes);
      for (const a of classes) {
        for (const b of classes) {
          if (a !== b && s.countQuads(nn(a), nn(P.disjointWith), nn(b), null)) {
            s.removeQuad(nn(a), nn(P.disjointWith), nn(b), defaultGraph());
            removed++;
          }
        }
      }
      for (const ax of subjects(s, RDF_TYPE, T.AllDisjointClasses)) {
        const members = objects(s, ax, P.members).flatMap((h) => readList(s, h) ?? []).map((t) => t.value);
        const hit = members.filter((m) => inSet.has(m));
        if (hit.length < 2) continue;
        // Drop the axiom and re-assert the pairs that are not being removed.
        for (const q of s.getQuads(ax, null, null, null)) {
          s.removeQuad(q);
          removeBlankSubtree(s, q.object as Term);
        }
        const keep = members.filter((m) => !inSet.has(m));
        if (keep.length >= 2) {
          const nax = blankNode();
          add(nax, RDF_TYPE, nn(T.AllDisjointClasses));
          add(nax, P.members, writeList(s, keep.map(nn)));
        } else if (keep.length === 1) {
          // nothing extra: pairs with the single kept member are handled below
        }
        for (const k of keep) for (const h of hit) add(k, P.disjointWith, nn(h));
        removed++;
      }
      if (!removed) fail('no disjointness axiom between these classes was found');
      classes.forEach((c) => touched.add(c));
      break;
    }
    case 'setCharacteristics': {
      const iri = requireTerm(ex(op.iri));
      const kinds = g.kindsOf(iri);
      if (kinds.has('datatypeProperty') && op.characteristics.some((c) => c !== 'functional')) {
        fail('datatype properties can only be functional');
      }
      if (!kinds.has('objectProperty') && !kinds.has('datatypeProperty')) fail(`<${iri}> is not a property`);
      for (const t of Object.values(CHARACTERISTIC_TYPES)) s.removeQuad(nn(iri), nn(RDF_TYPE), nn(t), defaultGraph());
      // Characteristic types (other than Functional) imply ObjectProperty; keep the explicit declaration.
      for (const c of op.characteristics) add(iri, RDF_TYPE, nn(characteristicType(c)));
      touched.add(iri);
      break;
    }
    case 'deprecateTerm': {
      const iri = requireTerm(ex(op.iri));
      if (!op.reason?.trim()) fail('a deprecation reason is required');
      const replacement = op.replacedBy ? requireKnown(ex(op.replacedBy), 'replacement') : undefined;
      if (replacement === iri) fail('a term cannot be replaced by itself');
      deprecate(g, iri, op.reason, replacement);
      usedAnnotations.add(P.historyNote);
      if (replacement) usedAnnotations.add(P.replacedBy);
      touched.add(iri);
      break;
    }
    case 'removeTerm': {
      const iri = requireTerm(ex(op.iri));
      const n = removeTerm(g, iri);
      if (n.axioms) warnings.push(`removing <${iri}> also removed ${n.axioms} axiom(s) that referenced it`);
      warnings.push(`<${iri}> was removed outright: this is a breaking (major) change; prefer deprecateTerm`);
      touched.add(iri);
      break;
    }
    case 'renameTerm': {
      const iri = requireTerm(ex(op.iri));
      const kinds = g.kindsOf(iri);
      const kind = kinds.has('class') ? 'class' : kinds.has('individual') && kinds.size === 1 ? 'individual' : 'property';
      if (!isValidLocalName(op.newLocalName, kind)) fail(`invalid local name "${op.newLocalName}" for a ${kind}`);
      const newIri = g.namespace + op.newLocalName;
      if (newIri === iri) fail('new name is the same as the old one');
      if (s.countQuads(nn(newIri), null, null, null) > 0) fail(`term <${newIri}> already exists`);
      renameTerm(g, iri, newIri, date);
      usedAnnotations.add(P.historyNote).add(P.replacedBy);
      touched.add(iri).add(newIri);
      break;
    }
    case 'setMetadata': {
      const o = g.ontologyIRI;
      if (!o) fail('ontology has no owl:Ontology header');
      setMetadata(g, op.set);
      touched.add(o);
      break;
    }
    case 'addImport': {
      const o = g.ontologyIRI;
      if (!o) fail('ontology has no owl:Ontology header');
      const target = ex(op.iri);
      if (!looksLikeIRI(target)) fail(`import <${target}> is not an absolute IRI`);
      if (s.countQuads(nn(o), nn(NS.owl + 'imports'), nn(target), null)) fail('already imported');
      add(o, NS.owl + 'imports', nn(target));
      touched.add(o);
      break;
    }
    default:
      fail(`unknown op ${(op as { op: string }).op}`);
  }
  declareAnnotationProperties(s, [...usedAnnotations]);
}

/* ------------------------------------------------------------------------ */
/* Helpers (exported for reuse by stampRelease/fromLinkML)                   */
/* ------------------------------------------------------------------------ */

function inImports(g: OntologyGraph, iri: string): boolean {
  return g.metadata().imports.some((imp) => iri.startsWith(imp));
}

export function isDatatype(g: OntologyGraph, iri: string): boolean {
  return isBuiltinDatatype(iri) || objects(g.store, iri, RDF_TYPE).some((t) => t.value === T.Datatype);
}

function characteristicType(c: PropertyCharacteristic): string {
  const t = CHARACTERISTIC_TYPES[c];
  if (!t) fail(`unknown characteristic "${c}"`);
  return t;
}

function findLabel(g: OntologyGraph, label: string, except?: string): string | undefined {
  const want = label.trim().toLowerCase();
  for (const q of g.store.getQuads(null, nn(P.label), null, null)) {
    if (q.subject.termType === 'NamedNode' && q.subject.value !== except && q.object.value.trim().toLowerCase() === want) {
      if (!objects(g.store, q.subject.value, P.deprecated).some((t) => t.value === 'true')) return q.subject.value;
    }
  }
  return undefined;
}

function normaliseRestriction(
  g: OntologyGraph, r: Restriction, ex: (i: string) => string, requireKnown: (iri: string, what: string) => string,
): Restriction {
  const out: Restriction = { property: ex(r.property), kind: r.kind };
  requireKnown(out.property, 'restriction property');
  if (!['some', 'only', 'min', 'max', 'exactly', 'value'].includes(r.kind)) fail(`unknown restriction kind "${r.kind}"`);
  if (r.filler) out.filler = requireKnown(ex(r.filler), 'restriction filler');
  if (r.literal !== undefined) out.literal = r.literal;
  if (['min', 'max', 'exactly'].includes(r.kind)) {
    if (r.cardinality === undefined || !Number.isInteger(r.cardinality) || r.cardinality < 0) {
      fail(`${r.kind} restriction needs a non-negative integer cardinality`);
    }
    out.cardinality = r.cardinality;
  }
  if ((r.kind === 'some' || r.kind === 'only') && !out.filler) fail(`${r.kind} restriction needs a filler`);
  if (r.kind === 'value' && !out.filler && out.literal === undefined) fail('value restriction needs a filler IRI or literal');
  const kinds = g.kindsOf(out.property);
  if (out.filler && kinds.has('datatypeProperty') && !isDatatype(g, out.filler) && r.kind !== 'value') {
    fail(`datatype property <${out.property}> needs a datatype filler`);
  }
  if (out.filler && kinds.has('objectProperty') && isDatatype(g, out.filler)) {
    fail(`object property <${out.property}> cannot have a datatype filler`);
  }
  return out;
}

/** Writes an owl:Restriction blank node (qualified cardinalities when a filler is given). */
export function writeRestriction(g: OntologyGraph, r: Restriction): Term {
  const s = g.store;
  const b = blankNode();
  const add = (p: string, o: Term) => s.addQuad(b, nn(NS.owl + p), o as any);
  s.addQuad(b, nn(RDF_TYPE), nn(T.Restriction));
  add('onProperty', nn(r.property));
  const card = () => typedLit(String(r.cardinality), NS.xsd + 'nonNegativeInteger');
  const dataFiller = r.filler !== undefined && isDatatype(g, r.filler);
  const qual = (unq: string, q: string) => {
    if (r.filler && r.filler !== T.Thing && r.filler !== NS.rdfs + 'Literal') {
      add(q, card());
      add(dataFiller ? 'onDataRange' : 'onClass', nn(r.filler));
    } else add(unq, card());
  };
  switch (r.kind) {
    case 'some': add('someValuesFrom', nn(r.filler!)); break;
    case 'only': add('allValuesFrom', nn(r.filler!)); break;
    case 'value': add('hasValue', r.literal !== undefined ? literal(r.literal) : nn(r.filler!)); break;
    case 'min': qual('minCardinality', 'minQualifiedCardinality'); break;
    case 'max': qual('maxCardinality', 'maxQualifiedCardinality'); break;
    case 'exactly': qual('cardinality', 'qualifiedCardinality'); break;
  }
  return b;
}

function findRestriction(g: OntologyGraph, cls: string, r: Restriction): Term | undefined {
  const want = restrictionKey(r);
  return objects(g.store, cls, P.subClassOf).find((o) => {
    if (o.termType !== 'BlankNode') return false;
    const have = g.restrictionOf(o);
    if (!have) return false;
    // Unqualified "min 1" equals "min 1 owl:Thing".
    const norm = (x: Restriction) => restrictionKey(x.filler === T.Thing ? { ...x, filler: undefined } : x);
    return norm(have) === want || norm(have) === norm(r);
  });
}

function factValue(g: OntologyGraph, p: string, v: string, ex: (i: string) => string, requireKnown: (iri: string, what: string) => string): Term {
  const kinds = g.kindsOf(p);
  if (kinds.has('objectProperty')) return nn(requireKnown(ex(v), 'individual'));
  if (kinds.has('datatypeProperty')) {
    const range = objects(g.store, p, P.range).find((t) => t.termType === 'NamedNode' && isDatatype(g, t.value));
    return range && range.value !== NS.xsd + 'string' && range.value !== NS.rdfs + 'Literal' ? typedLit(v, range.value) : literal(v);
  }
  if (looksLikeIRI(v)) return nn(v);
  return literal(v);
}

export function deprecate(g: OntologyGraph, iri: string, reason: string, replacedBy?: string): void {
  const s = g.store;
  for (const o of objects(s, iri, P.deprecated)) s.removeQuad(nn(iri), nn(P.deprecated), o as any, defaultGraph());
  s.addQuad(nn(iri), nn(P.deprecated), typedLit('true', NS.xsd + 'boolean'));
  s.addQuad(nn(iri), nn(P.historyNote), langLit(reason.trim()));
  if (replacedBy) {
    for (const o of objects(s, iri, P.replacedBy)) s.removeQuad(nn(iri), nn(P.replacedBy), o as any, defaultGraph());
    s.addQuad(nn(iri), nn(P.replacedBy), nn(replacedBy));
  }
}

/**
 * Removes every triple about `iri` and every axiom that mentions it. Blank-node
 * structures (restrictions, lists, AllDisjointClasses) containing it are removed whole.
 */
export function removeTerm(g: OntologyGraph, iri: string): { axioms: number } {
  const s = g.store;
  for (const q of s.getQuads(nn(iri), null, null, null)) {
    s.removeQuad(q);
    removeBlankSubtree(s, q.object as Term);
  }
  let axioms = 0;
  const refs = [...s.getQuads(null, null, nn(iri), null), ...s.getQuads(null, nn(iri), null, null)];
  for (const q of refs) {
    if (!s.has(q)) continue;
    let node = q.subject as Term;
    if (node.termType === 'NamedNode') {
      s.removeQuad(q);
      removeBlankSubtree(s, q.object as Term);
      axioms++;
      continue;
    }
    // Climb to the root of the blank-node structure and remove it entirely.
    const seen = new Set<string>();
    for (;;) {
      seen.add(node.value);
      const parent = s.getQuads(null, null, node, null)[0];
      if (!parent || seen.has(parent.subject.value)) break;
      if (parent.subject.termType === 'NamedNode') {
        s.removeQuad(parent);
        break;
      }
      node = parent.subject as Term;
    }
    removeBlankSubtree(s, node);
    axioms++;
  }
  return { axioms };
}

/** OBO-style rename: new IRI gets the term's axioms, references are rewritten, old IRI is deprecated. */
function renameTerm(g: OntologyGraph, oldIri: string, newIri: string, date: string): void {
  const s = g.store;
  const keepOnOld = new Set([RDF_TYPE, P.label, P.definition, P.isDefinedBy]);
  for (const q of s.getQuads(nn(oldIri), null, null, null)) {
    s.addQuad(nn(newIri), q.predicate as any, q.object as any);
    if (!keepOnOld.has(q.predicate.value)) s.removeQuad(q);
  }
  // Rewrite references (as object and as predicate) everywhere except the old term's own triples.
  for (const q of s.getQuads(null, null, nn(oldIri), null)) {
    if (q.subject.value === oldIri) continue;
    s.removeQuad(q);
    s.addQuad(q.subject as any, q.predicate as any, nn(newIri));
  }
  for (const q of s.getQuads(null, nn(oldIri), null, null)) {
    s.removeQuad(q);
    s.addQuad(q.subject as any, nn(newIri), q.object as any);
  }
  // The new term is created today; drop any copied created/historyNote/deprecation from the old one.
  for (const p of [P.created, P.deprecated, P.replacedBy, P.historyNote]) {
    for (const o of objects(s, newIri, p)) s.removeQuad(nn(newIri), nn(p), o as any, defaultGraph());
  }
  s.addQuad(nn(newIri), nn(P.created), typedLit(date, NS.xsd + 'date'));
  const labelOld = objects(s, oldIri, P.label)[0]?.value;
  // Obsolete term labels are prefixed (OBO convention), which also avoids a duplicate-label clash.
  for (const o of objects(s, oldIri, P.label)) {
    s.removeQuad(nn(oldIri), nn(P.label), o as any, defaultGraph());
    s.addQuad(nn(oldIri), nn(P.label), literal(`obsolete ${o.value}`, (o as any).language || undefined));
  }
  deprecate(g, oldIri, `Renamed to <${newIri}>${labelOld ? ` ("${labelOld}")` : ''} on ${date}; the term's axioms moved to the new IRI.`, newIri);
}

const METADATA_PREDICATES: Record<string, { p: string; kind: 'iri' | 'lang' | 'string' | 'date' | 'iriOrString' | 'anyURI' }> = {
  versionIRI: { p: NS.owl + 'versionIRI', kind: 'iri' },
  versionInfo: { p: NS.owl + 'versionInfo', kind: 'string' },
  priorVersion: { p: NS.owl + 'priorVersion', kind: 'iri' },
  backwardCompatibleWith: { p: NS.owl + 'backwardCompatibleWith', kind: 'iri' },
  incompatibleWith: { p: NS.owl + 'incompatibleWith', kind: 'iri' },
  title: { p: NS.dcterms + 'title', kind: 'lang' },
  description: { p: NS.dcterms + 'description', kind: 'lang' },
  license: { p: NS.dcterms + 'license', kind: 'iriOrString' },
  creators: { p: NS.dcterms + 'creator', kind: 'iriOrString' },
  contributors: { p: NS.dcterms + 'contributor', kind: 'iriOrString' },
  publisher: { p: NS.dcterms + 'publisher', kind: 'iriOrString' },
  created: { p: NS.dcterms + 'created', kind: 'date' },
  modified: { p: NS.dcterms + 'modified', kind: 'date' },
  issued: { p: NS.dcterms + 'issued', kind: 'date' },
  preferredPrefix: { p: NS.vann + 'preferredNamespacePrefix', kind: 'string' },
  preferredNamespace: { p: NS.vann + 'preferredNamespaceUri', kind: 'anyURI' },
};

/**
 * A valid xsd:date (2026-11-04) or xsd:dateTime (2026-11-04T10:00:00, with
 * optional fractional seconds and time zone): the lexical forms we store, with
 * real calendar values (no 31 February, no 25:00, no +15:00 offset).
 */
const XSD_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?)?(Z|([+-])(\d{2}):(\d{2}))?$/;
export function isXsdDateOrDateTime(v: string): boolean {
  const m = XSD_DATE.exec(v);
  if (!m) return false;
  const [, y, mo, d, h, mi, sec, tz, , th, tm] = m;
  const year = Number(y), month = Number(mo), day = Number(d);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (day > days) return false;
  // 24:00:00 is XSD's end-of-day notation (the first instant of the next day).
  const midnight = h === '24' && mi === '00' && sec === '00' && !/\.\d*[1-9]/.test(v);
  if (h !== undefined && !midnight && (Number(h) > 23 || Number(mi) > 59 || Number(sec) > 59)) return false;
  if (tz && tz !== 'Z' && (Number(tm) > 59 || Number(th) * 60 + Number(tm) > 14 * 60)) return false;
  return true;
}

export function setMetadata(g: OntologyGraph, set: Record<string, unknown>): void {
  const s = g.store;
  const o = g.ontologyIRI;
  const used: string[] = [];
  for (const [field, value] of Object.entries(set)) {
    const spec = METADATA_PREDICATES[field];
    if (!spec) fail(`unknown metadata field "${field}"`);
    if (value === undefined) continue;
    for (const q of s.getQuads(nn(o), nn(spec.p), null, null)) {
      s.removeQuad(q);
      removeBlankSubtree(s, q.object as Term);
    }
    const values = (Array.isArray(value) ? value : [value]).map(String).filter((v) => v !== '');
    for (const v of values) {
      let term: Term;
      switch (spec.kind) {
        case 'iri': term = nn(v); break;
        case 'lang': term = langLit(v); break;
        case 'string': term = literal(v); break;
        case 'anyURI': term = typedLit(v, NS.xsd + 'anyURI'); break;
        case 'date':
          if (!isXsdDateOrDateTime(v)) fail(`${field} must be an ISO date such as 2026-11-04 (or a date-time with seconds, 2026-11-04T10:00:00Z), not "${v.slice(0, 40)}"`);
          term = typedLit(v, v.includes('T') ? NS.xsd + 'dateTime' : NS.xsd + 'date');
          break;
        default: term = looksLikeIRI(v) ? nn(v) : literal(v);
      }
      s.addQuad(nn(o), nn(spec.p), term as any);
    }
    if (!spec.p.startsWith(NS.owl)) used.push(spec.p);
  }
  declareAnnotationProperties(s, used);
}

export { canonical, RDF_FIRST, RDF_REST };
