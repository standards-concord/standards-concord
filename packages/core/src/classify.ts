/**
 * Rule-based semantic-versioning classification of an ontology diff.
 *
 * Principle (after OWL 2 semantics, OBO principle 19 and the gist release policy):
 *  - MAJOR if a consumer who upgrades may get different/fewer answers, new
 *    inconsistencies or broken references;
 *  - MINOR if the change only adds terms, or entailments that involve new terms,
 *    without retracting anything about existing terms;
 *  - PATCH if the logical content is unchanged (annotation/metadata only).
 * The overall level is the maximum over all matching reasons; every matching
 * reason is returned so reviewers see why.
 */
import type { ChangeClassification, ChangeLevel, ClassificationReason, FieldChange, OntologyDiff, TermChange } from './types.js';
import { NS, compactIRI, isBuiltinDatatype, isWellKnown } from './ns.js';
import { P, T } from './graph.js';
import type { OntologyGraph } from './graph.js';
import { objects, readList } from './rdf.js';

export interface ClassificationRule {
  id: string;
  level: ChangeLevel;
  description: string;
}

export const CLASSIFICATION_RULES: ClassificationRule[] = [
  // PATCH
  { id: 'no-op', level: 'patch', description: 'No logical or annotation change.' },
  { id: 'annotation-changed', level: 'patch', description: 'Label, alt label, definition, comment, example, editorial note, source or translation changed on an existing term. Definition rewording must keep the same referents (OBO principle 19); a change of meaning needs a new term.' },
  { id: 'metadata-changed', level: 'patch', description: 'Ontology header metadata changed (title, description, contributors, dates, version annotations).' },
  { id: 'deprecation-without-replacement', level: 'patch', description: 'Informational: a term was deprecated without dcterms:isReplacedBy; consumers have no migration target.' },
  // MINOR
  { id: 'term-added', level: 'minor', description: 'A new class, property or individual was declared (including its own axioms).' },
  { id: 'term-deprecated', level: 'minor', description: 'A term was marked owl:deprecated; the IRI is kept so existing data still resolves. Final removal comes later as a major change.' },
  { id: 'term-renamed', level: 'minor', description: 'A term was renamed OBO-style: a new IRI was minted and the old IRI deprecated with dcterms:isReplacedBy. Old data still resolves. (Removing the old IRI instead would be term-removed, MAJOR.)' },
  { id: 'term-undeprecated', level: 'minor', description: 'A deprecated term was restored; no existing data becomes invalid.' },
  { id: 'axiom-relates-new-term', level: 'minor', description: 'A logical axiom on an existing term only relates it to a newly added term (e.g. an existing class placed beneath a new intermediate class, or a new inverse); no entailment over the old signature changes.' },
  { id: 'mapping-added', level: 'minor', description: 'A mapping annotation (skos:exactMatch/closeMatch/broadMatch/narrowMatch/relatedMatch, rdfs:seeAlso) was added.' },
  { id: 'domain-range-broadened', level: 'minor', description: 'An object property domain/range was replaced by a superclass of the old one (or removed): existing data stays valid.' },
  { id: 'import-added', level: 'minor', description: 'An owl:imports was added (check with the reasoner that no new unsatisfiable classes appear).' },
  { id: 'individual-assertion-added', level: 'minor', description: 'A type or property assertion was added to an existing individual.' },
  // MAJOR
  { id: 'term-removed', level: 'major', description: 'A declared term was removed: references to its IRI break. Prefer deprecation.' },
  { id: 'term-kind-changed', level: 'major', description: 'A term changed kind (e.g. class to property, or object to datatype property).' },
  { id: 'namespace-changed', level: 'major', description: 'The ontology IRI, preferred namespace or preferred prefix changed.' },
  { id: 'superclass-removed', level: 'major', description: 'A named superclass was removed from an existing class: subsumption answers are retracted.' },
  { id: 'superclass-added-existing', level: 'major', description: 'An existing class gained an existing superclass: existing data is reclassified and may become inconsistent. (Configurable: lenientSubsumption reports this as minor.)' },
  { id: 'equivalence-changed', level: 'major', description: 'An equivalent-class axiom (named or logical definition) on an existing class was added or removed.' },
  { id: 'class-expression-changed', level: 'major', description: 'An anonymous superclass expression (e.g. a union) on an existing class changed.' },
  { id: 'disjointness-added', level: 'major', description: 'Disjointness between existing classes was added: existing data may become inconsistent.' },
  { id: 'disjointness-removed', level: 'major', description: 'Disjointness between existing classes was removed: entailments (and data checks) are retracted.' },
  { id: 'restriction-universal-added', level: 'major', description: 'An `only` (owl:allValuesFrom) restriction was added to an existing class.' },
  { id: 'restriction-existential-added', level: 'major', description: 'A `some`/`value` restriction was added to an existing class: derived SHACL shapes now require the property, so existing records may fail validation.' },
  { id: 'cardinality-added', level: 'major', description: 'A min/max/exactly cardinality restriction was added to (or tightened on) an existing class.' },
  { id: 'restriction-removed', level: 'major', description: 'A restriction was removed from an existing class: entailments are retracted.' },
  { id: 'property-characteristic-added', level: 'major', description: 'A property was made functional, inverse-functional, transitive, symmetric, asymmetric, reflexive or irreflexive.' },
  { id: 'property-characteristic-removed', level: 'major', description: 'A property characteristic was removed: entailments are retracted.' },
  { id: 'domain-narrowed', level: 'major', description: 'A property domain was replaced by a subclass of the old domain (or added where there was none).' },
  { id: 'range-narrowed', level: 'major', description: 'A property range was replaced by a subclass of the old range (or added where there was none).' },
  { id: 'domain-range-replaced', level: 'major', description: 'A property domain/range was replaced by an unrelated class.' },
  { id: 'datatype-range-changed', level: 'major', description: 'The datatype range of an existing datatype property changed.' },
  { id: 'superproperty-changed', level: 'major', description: 'A super-property of an existing property was added or removed.' },
  { id: 'inverse-changed', level: 'major', description: 'owl:inverseOf on an existing property changed.' },
  { id: 'import-removed', level: 'major', description: 'An owl:imports was removed or replaced.' },
  { id: 'individual-assertion-removed', level: 'major', description: 'A type or property assertion was removed from an existing individual.' },
  { id: 'mapping-removed', level: 'major', description: 'A mapping annotation was removed: integrations relying on it break.' },
  { id: 'definition-reworded', level: 'patch', description: 'An existing definition was replaced with a new one. Patch only if it keeps the same referents (OBO principle 19), so governance asks someone other than the author to confirm that, even where patches need no approval.' },
  { id: 'meaning-changed', level: 'major', description: 'The person proposing a definition change said it changes what the term means. OBO principle 19 treats that as a different term, so it is reviewed as a breaking change.' },
  { id: 'label-or-definition-removed', level: 'major', description: 'The label or definition of an existing term was removed (also covers deprecated terms, OBO "M5").' },
];

const RULE = new Map(CLASSIFICATION_RULES.map((r) => [r.id, r]));
const RANK: Record<ChangeLevel, number> = { patch: 0, minor: 1, major: 2 };

export interface ClassifyOptions {
  /** Treat new existing→existing subClassOf links as minor (OBO practice). Default false (major). */
  lenientSubsumption?: boolean;
}

/* ------------------------------------------------------------------------ */
/* Subsumption support                                                       */
/* ------------------------------------------------------------------------ */

// Fragment of the XSD datatype hierarchy used to decide narrowing of data ranges.
const XSD_PARENT: Record<string, string> = {
  integer: 'decimal', nonNegativeInteger: 'integer', positiveInteger: 'nonNegativeInteger', nonPositiveInteger: 'integer',
  negativeInteger: 'nonPositiveInteger', long: 'integer', int: 'long', short: 'int', byte: 'short',
  unsignedLong: 'nonNegativeInteger', unsignedInt: 'unsignedLong', unsignedShort: 'unsignedInt', unsignedByte: 'unsignedShort',
  normalizedString: 'string', token: 'normalizedString', language: 'token', dateTimeStamp: 'dateTime',
};

/** Builds a reflexive-transitive "is subsumed by" test from the named hierarchy of the given graphs. */
export function subsumptionOracle(graphs: (OntologyGraph | undefined)[]): (sub: string, sup: string) => boolean {
  const parents = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (!parents.has(a)) parents.set(a, new Set());
    parents.get(a)!.add(b);
  };
  for (const g of graphs) {
    if (!g) continue;
    for (const q of g.store.getQuads(null, null, null, null)) {
      if (q.subject.termType !== 'NamedNode' || q.object.termType !== 'NamedNode') continue;
      const p = q.predicate.value;
      if (p === P.subClassOf || p === P.subPropertyOf) link(q.subject.value, q.object.value);
      else if (p === P.equivalentClass) {
        link(q.subject.value, q.object.value);
        link(q.object.value, q.subject.value);
      }
    }
    // A named class equivalent to a union is a superclass of each member.
    for (const q of g.store.getQuads(null, null, null, null)) {
      if (q.predicate.value !== P.equivalentClass || q.subject.termType !== 'NamedNode' || q.object.termType !== 'BlankNode') continue;
      for (const head of objects(g.store, q.object, NS.owl + 'unionOf')) {
        for (const m of readList(g.store, head) ?? []) if (m.termType === 'NamedNode') link(m.value, q.subject.value);
      }
    }
  }
  for (const [k, v] of Object.entries(XSD_PARENT)) link(NS.xsd + k, NS.xsd + v);
  const cache = new Map<string, Set<string>>();
  const ancestors = (x: string): Set<string> => {
    const hit = cache.get(x);
    if (hit) return hit;
    const out = new Set<string>([x]);
    const stack = [x];
    while (stack.length) for (const p of parents.get(stack.pop()!) ?? []) if (!out.has(p)) { out.add(p); stack.push(p); }
    cache.set(x, out);
    return out;
  };
  return (sub, sup) =>
    sup === T.Thing || (sup === NS.rdfs + 'Literal' && isBuiltinDatatype(sub)) || ancestors(sub).has(sup);
}

/** Compares two conjunctive sets of classes (rdfs:domain/range semantics = intersection). */
function compareConstraint(oldSet: string[], newSet: string[], sub: (a: string, b: string) => boolean): 'same' | 'broadened' | 'narrowed' | 'replaced' {
  // new is broader iff every new conjunct is implied by some old conjunct
  const broader = newSet.every((n) => oldSet.some((o) => sub(o, n)));
  // new is narrower iff every old conjunct is implied by some new conjunct
  const narrower = oldSet.every((o) => newSet.some((n) => sub(n, o)));
  if (broader && narrower) return 'same';
  if (broader) return 'broadened';
  if (narrower) return 'narrowed';
  return 'replaced';
}

/* ------------------------------------------------------------------------ */
/* Classification                                                            */
/* ------------------------------------------------------------------------ */

export function classifyChange(diff: OntologyDiff, before?: OntologyGraph, after?: OntologyGraph, opts: ClassifyOptions = {}): ChangeClassification {
  const prefixes = { ...(before?.prefixes ?? {}), ...(after?.prefixes ?? {}) };
  const c = (iri: string) => compactIRI(iri, prefixes);
  const pretty = (v: string) => v.replace(/<([^>\s]+)>/g, (_, iri: string) => c(iri));
  const reasons: ClassificationReason[] = [];
  const seen = new Set<string>();
  const emit = (rule: string, iri: string | undefined, message: string, level?: ChangeLevel) => {
    const key = `${rule}|${iri}|${message}`;
    if (seen.has(key)) return;
    seen.add(key);
    reasons.push({ rule, level: level ?? RULE.get(rule)!.level, iri, message });
  };
  const sub = subsumptionOracle([before, after]);

  const added = new Map<string, TermChange>();
  const removed = new Map<string, TermChange>();
  for (const t of diff.terms) {
    if (t.change === 'added') added.set(t.iri, t);
    if (t.change === 'removed') removed.set(t.iri, t);
  }
  // Rename detection: old IRI deprecated in this change with a replacement that is new in this change.
  const renameMap = new Map<string, string>();
  for (const t of diff.terms) {
    if (t.change !== 'deprecated') continue;
    const rb = t.fields.find((f) => f.field === 'replacedBy')?.added[0];
    if (rb && added.has(rb)) renameMap.set(t.iri, rb);
  }
  const renameTargets = new Set(renameMap.values());
  const normalise = (v: string) => {
    let out = renameMap.get(v) ?? v;
    for (const [o, n] of renameMap) out = out.split(`<${o}>`).join(`<${n}>`).split(`{${c(o)}`).join(`{${c(n)}`);
    return out;
  };
  const isNew = (v: string) => added.has(v.replace(/^<|>$/g, ''));

  for (const t of diff.terms) {
    const label = t.label ? ` "${t.label}"` : '';
    const name = t.kind === 'ontology' ? 'ontology' : `${c(t.iri)}${label}`;

    if (t.kind === 'ontology') {
      for (const f of t.fields) {
        const key = (s: string) => s.slice(0, s.indexOf(':'));
        const keys = new Set([...f.added, ...f.removed].map(key));
        for (const k of keys) {
          const a = f.added.filter((x) => key(x) === k);
          const r = f.removed.filter((x) => key(x) === k);
          if (k === 'imports') {
            a.forEach((x) => emit('import-added', t.iri, `ontology now imports ${x.slice(9).trim()}`));
            r.forEach((x) => emit('import-removed', t.iri, `ontology no longer imports ${x.slice(9).trim()}`));
          } else if ((k === 'iri' || k === 'preferredNamespace' || k === 'preferredPrefix') && r.length) {
            emit('namespace-changed', t.iri, `${k} changed: ${r.map((x) => x.slice(k.length + 1).trim()).join(', ')} → ${a.map((x) => x.slice(k.length + 1).trim()).join(', ') || '∅'}`);
          } else {
            emit('metadata-changed', t.iri, `ontology ${k} changed`);
          }
        }
      }
      continue;
    }

    // Declaring/undeclaring a standard annotation property (skos:altLabel, dcterms:source...) changes no entailment.
    if (t.kind === 'annotationProperty' && (t.change === 'added' || t.change === 'removed') && isWellKnown(t.iri)) continue;

    if (t.change === 'added') {
      if (removed.has(t.iri)) emit('term-kind-changed', t.iri, `${name} changed from ${removed.get(t.iri)!.kind} to ${t.kind}`);
      else if (!renameTargets.has(t.iri)) emit('term-added', t.iri, `new ${t.kind} ${name}`);
      continue;
    }
    if (t.change === 'removed') {
      if (!added.has(t.iri)) {
        const wasDeprecated = t.fields.some((f) => f.field === 'deprecated' && f.removed.includes('true'));
        emit('term-removed', t.iri, `${t.kind} ${name} was removed${wasDeprecated ? ' (it was deprecated; final removal is still breaking)' : ''}`);
      }
      continue;
    }

    const isDeprecation = t.change === 'deprecated';
    if (isDeprecation) {
      const rb = t.fields.find((f) => f.field === 'replacedBy')?.added[0];
      if (renameMap.has(t.iri)) emit('term-renamed', t.iri, `${name} renamed to ${c(renameMap.get(t.iri)!)} (old IRI deprecated, still resolves)`);
      else {
        emit('term-deprecated', t.iri, `${name} deprecated${rb ? `, replaced by ${c(rb)}` : ''}`);
        if (!rb) emit('deprecation-without-replacement', t.iri, `${name} was deprecated without a replacement (dcterms:isReplacedBy)`);
      }
    }
    if (t.change === 'undeprecated') emit('term-undeprecated', t.iri, `${name} is no longer deprecated`);

    for (const raw of t.fields) {
      // Rewrite renamed IRIs so reference updates caused by a rename cancel out.
      const addedV = raw.added.map(normalise);
      const removedV = raw.removed.map(normalise);
      const f: FieldChange = {
        field: raw.field,
        added: addedV.filter((x) => !removedV.includes(x)),
        removed: removedV.filter((x) => !addedV.includes(x)),
      };
      if (!f.added.length && !f.removed.length) continue;
      const list = (xs: string[]) => xs.map(pretty).join(', ');

      switch (f.field) {
        case 'label': case 'definition': case 'comment': case 'altLabels': case 'examples': case 'editorialNote': case 'source':
          if ((f.field === 'label' || f.field === 'definition') && f.removed.length && !f.added.length) {
            emit('label-or-definition-removed', t.iri, `${f.field} of ${name} was removed`);
          } else {
            emit('annotation-changed', t.iri, `${f.field} of ${name} changed${f.field === 'definition' ? ' (reviewer: confirm the referents are unchanged, OBO principle 19)' : ''}`);
            if (f.field === 'definition' && f.removed.length && f.added.length) emit('definition-reworded', t.iri, `the definition of ${name} was replaced; someone other than the author must confirm it means the same`);
          }
          break;
        case 'replacedBy': case 'deprecated':
          if (!isDeprecation && t.change !== 'undeprecated') emit('annotation-changed', t.iri, `${f.field} of ${name} changed`);
          break;
        case 'mappings':
          if (f.added.length) emit('mapping-added', t.iri, `mapping added to ${name}: ${list(f.added)}`);
          if (f.removed.length) emit('mapping-removed', t.iri, `mapping removed from ${name}: ${list(f.removed)}`);
          break;
        case 'metadata':
          emit('metadata-changed', t.iri, `metadata of ${name} changed`);
          break;
      }
      if (isDeprecation) continue; // OBO obsoletion strips logical axioms from the old term; that is part of the deprecation.

      switch (f.field) {
        case 'superClasses':
          for (const r of f.removed) emit('superclass-removed', t.iri, `${name} is no longer a subclass of ${c(r)}`);
          for (const a of f.added) {
            if (isNew(a)) emit('axiom-relates-new-term', t.iri, `${name} placed beneath new class ${c(a)}`);
            else emit('superclass-added-existing', t.iri, `${name} is now a subclass of existing class ${c(a)}`, opts.lenientSubsumption ? 'minor' : undefined);
          }
          break;
        case 'equivalentClasses': case 'equivalentExpressions':
          for (const a of f.added) {
            if (f.field === 'equivalentClasses' && isNew(a)) emit('axiom-relates-new-term', t.iri, `${name} declared equivalent to new class ${c(a)}`);
            else emit('equivalence-changed', t.iri, `${name} is now equivalent to ${pretty(a)}`);
          }
          for (const r of f.removed) emit('equivalence-changed', t.iri, `${name} is no longer equivalent to ${pretty(r)}`);
          break;
        case 'superClassExpressions':
          emit('class-expression-changed', t.iri, `anonymous superclass of ${name} changed: ${[...f.added.map((x) => '+' + x), ...f.removed.map((x) => '−' + x)].join(', ')}`);
          break;
        case 'disjointWith':
          for (const a of f.added) {
            if (isNew(a)) emit('axiom-relates-new-term', t.iri, `${name} declared disjoint with new class ${c(a)}`);
            else emit('disjointness-added', t.iri, `${name} is now disjoint with ${c(a)}`);
          }
          for (const r of f.removed) if (!removed.has(r)) emit('disjointness-removed', t.iri, `${name} is no longer disjoint with ${c(r)}`);
          break;
        case 'restrictions':
          for (const a of f.added) {
            const kind = a.split(' ')[0];
            const rule = kind === 'only' ? 'restriction-universal-added' : kind === 'some' || kind === 'value' ? 'restriction-existential-added' : 'cardinality-added';
            emit(rule, t.iri, `restriction added to ${name}: ${pretty(a)}`);
          }
          for (const r of f.removed) emit('restriction-removed', t.iri, `restriction removed from ${name}: ${pretty(r)}`);
          break;
        case 'domain': case 'range': {
          const beforeSet = constraintSet(t, f.field, before, 'before', renameMap);
          const afterSet = constraintSet(t, f.field, after, 'after', renameMap);
          if (t.kind === 'datatypeProperty' && f.field === 'range') {
            emit('datatype-range-changed', t.iri, `range of ${name}: ${list(beforeSet) || '∅'} → ${list(afterSet) || '∅'}`);
            break;
          }
          const verdict = compareConstraint(beforeSet, afterSet, sub);
          const msg = `${f.field} of ${name}: ${list(beforeSet) || '∅ (owl:Thing)'} → ${list(afterSet) || '∅ (owl:Thing)'}`;
          if (verdict === 'broadened') emit('domain-range-broadened', t.iri, msg + ' (broadened)');
          else if (verdict === 'narrowed') emit(f.field === 'domain' ? 'domain-narrowed' : 'range-narrowed', t.iri, msg + ' (narrowed)');
          else if (verdict === 'replaced') emit('domain-range-replaced', t.iri, msg + ' (unrelated)');
          break;
        }
        case 'superProperties':
          for (const a of f.added) {
            if (isNew(a)) emit('axiom-relates-new-term', t.iri, `${name} placed beneath new property ${c(a)}`);
            else emit('superproperty-changed', t.iri, `${name} is now a sub-property of ${c(a)}`);
          }
          for (const r of f.removed) emit('superproperty-changed', t.iri, `${name} is no longer a sub-property of ${c(r)}`);
          break;
        case 'inverseOf':
          if (f.added.length && !f.removed.length && f.added.every(isNew)) emit('axiom-relates-new-term', t.iri, `${name} has new inverse ${list(f.added)}`);
          else emit('inverse-changed', t.iri, `inverse of ${name}: ${list(f.removed) || '∅'} → ${list(f.added) || '∅'}`);
          break;
        case 'characteristics':
          for (const a of f.added) emit('property-characteristic-added', t.iri, `${name} is now ${a}`);
          for (const r of f.removed) emit('property-characteristic-removed', t.iri, `${name} is no longer ${r}`);
          break;
        case 'types': case 'facts':
          if (f.added.length) emit('individual-assertion-added', t.iri, `${f.field} added to ${name}: ${list(f.added)}`);
          if (f.removed.length) emit('individual-assertion-removed', t.iri, `${f.field} removed from ${name}: ${list(f.removed)}`);
          break;
      }
    }
  }

  if (!reasons.length) {
    const triples = diff.addedTriples + diff.removedTriples;
    reasons.push({ rule: 'no-op', level: 'patch', message: triples ? `${triples} triple-level change(s) with no term-level effect` : 'no changes' });
  }
  const level = reasons.reduce<ChangeLevel>((m, r) => (RANK[r.level] > RANK[m] ? r.level : m), 'patch');
  reasons.sort((a, b) => RANK[b.level] - RANK[a.level] || a.rule.localeCompare(b.rule) || (a.iri ?? '').localeCompare(b.iri ?? ''));
  return { level, reasons };
}

/**
 * The domain/range set of a property before/after the change. Uses the graph when
 * given; otherwise falls back to the diff's removed/added values (unchanged values unknown).
 */
function constraintSet(t: TermChange, field: 'domain' | 'range', g: OntologyGraph | undefined, side: 'before' | 'after', renameMap: Map<string, string>): string[] {
  const norm = (v: string) => renameMap.get(v) ?? v;
  if (g) {
    const v = g.term(t.iri);
    if (!v || !('domain' in v)) return [];
    const exprs = (field === 'domain' ? v.domainExpressions : v.rangeExpressions) ?? [];
    return [...v[field].map(norm), ...exprs.map((e) => `{${e}}`)].sort();
  }
  const f = t.fields.find((x) => x.field === field);
  return (side === 'before' ? f?.removed ?? [] : f?.added ?? []).map(norm);
}


/**
 * Raises a computed classification to a level a person declared (for example an
 * author saying a definition change alters the term's meaning). It never lowers it.
 */
export function withDeclaredLevel(c: ChangeClassification, declared?: { level: ChangeLevel; rule: string; message: string; iri?: string }): ChangeClassification {
  if (!declared) return c;
  const reasons = [...c.reasons, { rule: declared.rule, level: declared.level, iri: declared.iri, message: declared.message }];
  return { level: RANK[declared.level] > RANK[c.level] ? declared.level : c.level, reasons };
}
