/**
 * Ontology lint: naming, annotation, structural and header checks with stable
 * codes, each citing the best practice it comes from (OBO principles, ROBOT
 * report checks, OOPS! pitfalls, FAIR vocabulary best practice).
 */
import type { Term } from 'n3';
import type { ClassView, Issue, IssueSeverity, TermView } from './types.js';
import { NS, OWL2_DATATYPES, RDF_TYPE, compactIRI, isBuiltinDatatype, isValidLocalName, isWellKnown, localName } from './ns.js';
import { P, T, MAPPING_PROPERTIES } from './graph.js';
import type { OntologyGraph } from './graph.js';
import { RDF_FIRST, RDF_REST, objects, readList } from './rdf.js';

export const LINT_REFERENCES = {
  label: 'OBO principle 12 (naming conventions); ROBOT report missing_label; OOPS! P08 (missing annotations)',
  multipleLabels: 'ROBOT report multiple_labels (ERROR)',
  definition: 'OBO principle 6 (textual definitions); ROBOT report missing_definition; OOPS! P08',
  multipleDefinitions: 'ROBOT report multiple_definitions',
  naming: 'OOPS! P22 (using different naming conventions); FAIR vocabulary best practice (Garijo & Poveda-Villalón)',
  undeclared: 'OWL 2 DL declarations; ROBOT validate-profile',
  domainRange: 'OOPS! P11 (missing domain or range in properties)',
  multipleDomainRange: 'OOPS! P19 (defining multiple domains or ranges: interpreted as intersection)',
  datatypeRange: 'OWL 2 DL typing constraints; OOPS! P35 (untyped property)',
  deprecated: 'OBO principle 13 (obsoletion); ROBOT report misused_obsolete_label / deprecated_*_reference',
  replacedBy: 'ROBOT report misused_replaced_by',
  cycle: 'OOPS! P06 (including cycles in a class hierarchy)',
  labelCollision: 'ROBOT report duplicate_label (ERROR); OBO principle 12',
  punning: 'OWL 2 punning; OOPS! P31-style ambiguity',
  genus: 'Seppälä, Ruttenberg & Smith (2017) definition guidelines: genus–differentia; OBO principle 6',
  circular: 'OOPS! P24 (using recursive definitions); Seppälä et al. (2017): avoid circularity',
  superclass: 'OBO principle 10 / is_a completeness; Kendall & McGuinness (2019)',
  header: 'FAIR vocabulary best practice (Garijo & Poveda-Villalón 2020); ROBOT report missing_ontology_*; OOPS! P41 (no license)',
  whitespace: 'ROBOT report label_whitespace / annotation_whitespace',
  equivalentPair: 'ROBOT report equivalent_pair',
  builtin: 'ROBOT report illegal_use_of_built_in_vocabulary',
  disjointness: 'OOPS! P10 (missing disjointness)',
  manySubclasses: 'Kendall & McGuinness (2019): keep hierarchies navigable',
  owl2Datatype: 'OWL 2 Structural Specification §4 (datatype maps); ROBOT validate-profile --profile DL',
  propertyKind: 'OWL 2 DL: an IRI cannot be both an object and a datatype property',
} as const;

const AXIOM_PREDICATES = [
  P.subClassOf, P.equivalentClass, P.disjointWith, P.domain, P.range, P.subPropertyOf, P.inverseOf,
  NS.owl + 'onProperty', NS.owl + 'someValuesFrom', NS.owl + 'allValuesFrom', NS.owl + 'onClass', NS.owl + 'onDataRange',
  NS.owl + 'hasValue', NS.owl + 'complementOf', NS.owl + 'propertyDisjointWith', NS.owl + 'equivalentProperty',
];
const LIST_AXIOMS = [NS.owl + 'unionOf', NS.owl + 'intersectionOf', NS.owl + 'members', NS.owl + 'oneOf', NS.owl + 'propertyChainAxiom'];

export interface LintOptions {
  strict?: boolean;
}

export function lint(graph: OntologyGraph, opts: LintOptions = {}): Issue[] {
  const strict = opts.strict ?? false;
  const issues: Issue[] = [];
  const s = graph.store;
  const ns = graph.namespace;
  const v = graph.view();
  const c = (iri: string) => compactIRI(iri, graph.prefixes);
  const push = (severity: IssueSeverity, code: string, message: string, iri: string | undefined, reference: string) =>
    issues.push({ severity, code, message, ...(iri ? { iri } : {}), reference });
  const sev = (strictLevel: IssueSeverity, lenient: IssueSeverity) => (strict ? strictLevel : lenient);

  const local = (t: TermView) => !!ns && t.iri.startsWith(ns);
  const classes = v.classes;
  const props = [...v.objectProperties, ...v.datatypeProperties];
  const coreTerms: TermView[] = [...classes, ...props].filter(local);
  const deprecated = new Set([...classes, ...props, ...v.individuals, ...v.annotationProperties].filter((t) => t.deprecated).map((t) => t.iri));
  const labelOf = (iri: string) => graph.term(iri)?.label;

  /* --- annotations ------------------------------------------------------ */
  for (const t of coreTerms) {
    const labels = objects(s, t.iri, P.label);
    const en = labels.filter((l) => l.termType === 'Literal' && ((l as any).language === 'en' || (l as any).language === ''));
    if (!labels.length) push(sev('error', 'warning'), 'missing-label', `${c(t.iri)} has no rdfs:label`, t.iri, LINT_REFERENCES.label);
    else if (en.length > 1 || new Set(labels.map((l: any) => l.language)).size < labels.length) {
      push('error', 'multiple-labels', `${c(t.iri)} has ${labels.length} rdfs:label values; use exactly one per language (put synonyms in skos:altLabel)`, t.iri, LINT_REFERENCES.multipleLabels);
    } else if (strict && !labels.some((l: any) => l.language?.startsWith('en'))) {
      push('warning', 'label-not-english', `${c(t.iri)} has no @en label`, t.iri, LINT_REFERENCES.label);
    }
    const defs = [...objects(s, t.iri, P.definition), ...objects(s, t.iri, P.iaoDefinition)];
    if (!t.deprecated) {
      if (!defs.length) push(sev('error', 'warning'), 'missing-definition', `${c(t.iri)} has no skos:definition`, t.iri, LINT_REFERENCES.definition);
      else if (defs.filter((d: any) => !d.language || d.language.startsWith('en')).length > 1) {
        push(sev('error', 'warning'), 'multiple-definitions', `${c(t.iri)} has more than one definition`, t.iri, LINT_REFERENCES.multipleDefinitions);
      }
    }
    for (const p of [P.label, P.definition, P.altLabel, P.comment]) {
      for (const o of objects(s, t.iri, p)) {
        if (o.termType === 'Literal' && (o.value !== o.value.trim() || /\s{2,}/.test(o.value))) {
          push('warning', 'annotation-whitespace', `${c(p)} of ${c(t.iri)} has leading/trailing or repeated whitespace`, t.iri, LINT_REFERENCES.whitespace);
        }
      }
    }
  }

  /* --- naming ------------------------------------------------------------ */
  for (const t of classes.filter(local)) {
    if (!isValidLocalName(localName(t.iri), 'class')) {
      push(sev('error', 'warning'), 'naming-class-case', `class ${c(t.iri)} should be UpperCamelCase without spaces or underscores`, t.iri, LINT_REFERENCES.naming);
    }
  }
  for (const t of props.filter(local)) {
    if (!isValidLocalName(localName(t.iri), 'property')) {
      push(sev('error', 'warning'), 'naming-property-case', `property ${c(t.iri)} should be lowerCamelCase without spaces or underscores`, t.iri, LINT_REFERENCES.naming);
    }
  }

  /* --- undeclared terms ---------------------------------------------------- */
  const imports = v.metadata.imports;
  const okRef = (iri: string) =>
    graph.isDeclared(iri) || isWellKnown(iri) || isBuiltinDatatype(iri) || imports.some((i) => iri.startsWith(i)) || iri === graph.ontologyIRI;
  const reported = new Set<string>();
  const reportUndeclared = (iri: string, where: string) => {
    if (okRef(iri) || reported.has(iri)) return;
    reported.add(iri);
    push('error', 'undeclared-term', `${c(iri)} is used in ${where} but is not declared (and is not in an imported or well-known vocabulary)`, iri, LINT_REFERENCES.undeclared);
  };
  for (const q of s.getQuads(null, null, null, null)) {
    const p = q.predicate.value;
    if (AXIOM_PREDICATES.includes(p) && q.object.termType === 'NamedNode') reportUndeclared(q.object.value, `an axiom (${c(p)}) on ${q.subject.termType === 'NamedNode' ? c(q.subject.value) : 'an anonymous expression'}`);
    if (LIST_AXIOMS.includes(p)) for (const m of readList(s, q.object as Term) ?? []) if (m.termType === 'NamedNode') reportUndeclared(m.value, `a ${c(p)} list`);
    if (p === RDF_TYPE && q.object.termType === 'NamedNode' && q.subject.termType === 'NamedNode') reportUndeclared(q.object.value, `the type of ${c(q.subject.value)}`);
    if (!okRef(p) && p !== RDF_FIRST && p !== RDF_REST) reportUndeclared(p, `a triple about ${q.subject.termType === 'NamedNode' ? c(q.subject.value) : 'an anonymous node'}`);
  }

  /* --- property domain/range ------------------------------------------- */
  for (const p of props) {
    if (p.deprecated) continue;
    const isLocal = local(p);
    const hasDom = p.domain.length || p.domainExpressions?.length;
    const hasRng = p.range.length || p.rangeExpressions?.length;
    if (isLocal && !hasDom) push('warning', 'missing-domain', `${c(p.iri)} has no rdfs:domain`, p.iri, LINT_REFERENCES.domainRange);
    if (isLocal && !hasRng) push('warning', 'missing-range', `${c(p.iri)} has no rdfs:range`, p.iri, LINT_REFERENCES.domainRange);
    if (p.domain.length + (p.domainExpressions?.length ?? 0) > 1) {
      push('warning', 'multiple-domains', `${c(p.iri)} has several rdfs:domain axioms; their intersection is the domain. Use a union if either is meant`, p.iri, LINT_REFERENCES.multipleDomainRange);
    }
    if (p.range.length + (p.rangeExpressions?.length ?? 0) > 1) {
      push('warning', 'multiple-ranges', `${c(p.iri)} has several rdfs:range axioms; their intersection is the range`, p.iri, LINT_REFERENCES.multipleDomainRange);
    }
    for (const r of p.range) {
      const dt = isBuiltinDatatype(r) || objects(s, r, RDF_TYPE).some((t) => t.value === T.Datatype);
      if (p.kind === 'datatypeProperty' && !dt) {
        push('error', 'datatype-range-is-class', `datatype property ${c(p.iri)} has range ${c(r)}, which is not a datatype`, p.iri, LINT_REFERENCES.datatypeRange);
      }
      if (p.kind === 'objectProperty' && dt) {
        push('error', 'object-range-is-datatype', `object property ${c(p.iri)} has datatype range ${c(r)}; make it a datatype property`, p.iri, LINT_REFERENCES.datatypeRange);
      }
      if (p.kind === 'datatypeProperty' && isBuiltinDatatype(r) && !OWL2_DATATYPES.has(r)) {
        push(sev('warning', 'info'), 'datatype-not-owl2', `range ${c(r)} of ${c(p.iri)} is not in the OWL 2 datatype map; OWL 2 DL reasoners (HermiT) reject it. Prefer ${r === NS.xsd + 'date' ? 'xsd:dateTime' : 'an OWL 2 datatype'}`, p.iri, LINT_REFERENCES.owl2Datatype);
      }
      if (p.kind === 'objectProperty' && !dt && graph.isDeclared(r) && !graph.isClassIri(r)) {
        push('warning', 'range-not-class', `range ${c(r)} of ${c(p.iri)} is not declared as a class`, p.iri, LINT_REFERENCES.datatypeRange);
      }
    }
  }
  const objIris = new Set(v.objectProperties.map((p) => p.iri));
  for (const p of v.datatypeProperties) {
    if (objIris.has(p.iri)) push('error', 'property-kind-conflict', `${c(p.iri)} is declared as both an object and a datatype property`, p.iri, LINT_REFERENCES.propertyKind);
  }

  /* --- deprecation ------------------------------------------------------- */
  for (const iri of deprecated) {
    const reason = objects(s, iri, P.historyNote).length || objects(s, iri, P.comment).length || objects(s, iri, NS.obo + 'IAO_0000231').length;
    if (!reason) push('warning', 'deprecated-without-reason', `${c(iri)} is deprecated without a reason (skos:historyNote or rdfs:comment)`, iri, LINT_REFERENCES.deprecated);
    const rb = graph.term(iri)?.replacedBy;
    if (!rb) push('info', 'deprecated-without-replacement', `${c(iri)} is deprecated without dcterms:isReplacedBy`, iri, LINT_REFERENCES.deprecated);
    else if (deprecated.has(rb)) push('warning', 'misused-replaced-by', `${c(iri)} is replaced by ${c(rb)}, which is itself deprecated`, iri, LINT_REFERENCES.replacedBy);
  }
  for (const t of [...classes, ...props, ...v.individuals]) {
    if (!t.deprecated && t.replacedBy) push('warning', 'misused-replaced-by', `${c(t.iri)} has dcterms:isReplacedBy but is not deprecated`, t.iri, LINT_REFERENCES.replacedBy);
  }
  if (deprecated.size) {
    const usedIn = new Map<string, Set<string>>();
    const note = (dep: string, by: string) => {
      if (!usedIn.has(dep)) usedIn.set(dep, new Set());
      usedIn.get(dep)!.add(by);
    };
    for (const q of s.getQuads(null, null, null, null)) {
      const subj = rootSubject(graph, q.subject as Term);
      if (!subj || deprecated.has(subj)) continue;
      const p = q.predicate.value;
      if (p === P.replacedBy || p === P.iaoReplacedBy || MAPPING_PROPERTIES.includes(p)) continue;
      if (deprecated.has(p)) note(p, subj);
      if (q.object.termType === 'NamedNode' && deprecated.has(q.object.value) && (AXIOM_PREDICATES.includes(p) || p === RDF_TYPE)) note(q.object.value, subj);
      if (LIST_AXIOMS.includes(p)) for (const m of readList(s, q.object as Term) ?? []) if (deprecated.has(m.value)) note(m.value, subj);
    }
    for (const [dep, users] of usedIn) {
      push('warning', 'deprecated-term-used', `deprecated ${c(dep)} is still used by ${[...users].map(c).join(', ')}`, dep, LINT_REFERENCES.deprecated);
    }
  }

  /* --- hierarchy ----------------------------------------------------------- */
  const parents = new Map<string, string[]>(classes.map((k) => [k.iri, k.superClasses]));
  const cycles = findCycles(parents);
  for (const cyc of cycles) {
    push(sev('error', 'warning'), 'subclass-cycle', `rdfs:subClassOf cycle: ${[...cyc, cyc[0]].map(c).join(' ⊑ ')} (makes these classes equivalent)`, cyc[0], LINT_REFERENCES.cycle);
  }
  for (const k of classes) {
    for (const e of k.equivalentClasses) {
      if (k.iri < e && local(k)) push('warning', 'equivalent-pair', `${c(k.iri)} and ${c(e)} are asserted equivalent named classes; consider merging (one deprecated, replaced by the other)`, k.iri, LINT_REFERENCES.equivalentPair);
    }
  }
  const children = new Map<string, string[]>();
  for (const k of classes) for (const sc of k.superClasses) children.set(sc, [...(children.get(sc) ?? []), k.iri]);
  for (const [parent, kids] of children) {
    if (kids.length > 7) push('info', 'many-direct-subclasses', `${c(parent)} has ${kids.length} direct subclasses; consider intermediate groupings`, parent, LINT_REFERENCES.manySubclasses);
  }

  /* --- definitions: genus–differentia, circularity ---------------------- */
  for (const k of classes.filter(local)) {
    if (k.deprecated || !k.definition) continue;
    const def = k.definition.toLowerCase();
    const genusIris = [...k.superClasses, ...namedConjuncts(graph, k)];
    const genusLabels = genusIris.map((g) => labelOf(g) ?? splitCamel(localName(g))).filter(Boolean).map((l) => l!.toLowerCase());
    if (k.label && new RegExp(`^(an?|the)\\s+${escapeRe(k.label.toLowerCase())}\\b`).test(def)) {
      push('warning', 'definition-circular', `the definition of ${c(k.iri)} starts with its own label ("${k.label}")`, k.iri, LINT_REFERENCES.circular);
    }
    if (k.label && def.replace(/[.\s]+$/, '') === k.label.toLowerCase()) {
      push('warning', 'definition-restates-label', `the definition of ${c(k.iri)} only restates its label`, k.iri, LINT_REFERENCES.genus);
    }
    if (!genusLabels.length) {
      if (strict) push('info', 'missing-superclass', `${c(k.iri)} has no named superclass; confirm it is meant to be a top-level class`, k.iri, LINT_REFERENCES.superclass);
    } else if (!genusLabels.some((l) => def.includes(l) || def.includes(pluralise(l)))) {
      push('warning', 'definition-not-genus-differentia', `the definition of ${c(k.iri)} does not mention its superclass (${genusLabels.map((l) => `"${l}"`).join(', ')}); use "A <genus> that <differentia>"`, k.iri, LINT_REFERENCES.genus);
    }
  }

  /* --- labels ----------------------------------------------------------- */
  const byLabel = new Map<string, string[]>();
  for (const t of [...classes, ...props, ...v.individuals]) {
    if (t.deprecated || !t.label) continue;
    const key = t.label.trim().toLowerCase();
    byLabel.set(key, [...(byLabel.get(key) ?? []), t.iri]);
  }
  for (const [label, iris] of byLabel) {
    const uniq = [...new Set(iris)];
    if (uniq.length > 1) push('error', 'label-collision', `label "${label}" is used by ${uniq.map(c).join(', ')}`, uniq[0], LINT_REFERENCES.labelCollision);
  }

  /* --- punning ------------------------------------------------------------ */
  const classSet = new Set(classes.map((k) => k.iri));
  const propSet = new Set(props.map((p) => p.iri));
  for (const i of v.individuals) {
    if (classSet.has(i.iri) || propSet.has(i.iri)) {
      push('warning', 'punning', `${c(i.iri)} is used both as an individual and as a ${classSet.has(i.iri) ? 'class' : 'property'}`, i.iri, LINT_REFERENCES.punning);
    }
  }
  for (const k of classes) {
    if (propSet.has(k.iri)) push('warning', 'punning', `${c(k.iri)} is declared both as a class and as a property`, k.iri, LINT_REFERENCES.punning);
  }

  /* --- built-in vocabulary misuse ---------------------------------------- */
  for (const q of s.getQuads(null, null, null, null)) {
    const subj = q.subject.value;
    if (q.subject.termType !== 'NamedNode') continue;
    if ([NS.owl, NS.rdf, NS.rdfs, NS.xsd].some((n) => subj.startsWith(n)) && AXIOM_PREDICATES.includes(q.predicate.value)) {
      push('error', 'illegal-builtin-use', `axioms about built-in term ${c(subj)} are not allowed (${c(q.predicate.value)})`, subj, LINT_REFERENCES.builtin);
    }
  }

  /* --- missing disjointness (info) ---------------------------------------- */
  if (strict) {
    const siblingsOf = new Map<string, string[]>();
    for (const k of classes.filter(local)) {
      const key = k.superClasses.length ? k.superClasses.join(' ') : '(top)';
      siblingsOf.set(key, [...(siblingsOf.get(key) ?? []), k.iri]);
    }
    for (const [parent, sibs] of siblingsOf) {
      if (sibs.length < 2) continue;
      const anyDisjoint = sibs.some((a) => (graph.term(a) as ClassView).disjointWith.some((d) => sibs.includes(d)));
      if (!anyDisjoint) {
        push('info', 'missing-disjointness', `sibling classes ${sibs.map(c).join(', ')}${parent === '(top)' ? ' (top level)' : ` under ${parent.split(' ').map(c).join(', ')}`} have no disjointness axioms`, sibs[0], LINT_REFERENCES.disjointness);
      }
    }
  }

  /* --- ontology header ---------------------------------------------------- */
  const m = v.metadata;
  const header: [keyof typeof m, string, string, IssueSeverity][] = [
    ['title', 'title', 'dcterms:title', 'error'],
    ['description', 'description', 'dcterms:description', 'error'],
    ['license', 'license', 'dcterms:license', 'error'],
    ['creators', 'creator', 'dcterms:creator', 'warning'],
    ['versionIRI', 'versionIRI', 'owl:versionIRI', 'warning'],
    ['versionInfo', 'versionInfo', 'owl:versionInfo', 'warning'],
    ['preferredPrefix', 'prefix', 'vann:preferredNamespacePrefix', 'warning'],
    ['preferredNamespace', 'namespace', 'vann:preferredNamespaceUri', 'warning'],
  ];
  if (!graph.ontologyIRI) {
    push('error', 'header-missing-ontology', 'no owl:Ontology header', undefined, LINT_REFERENCES.header);
  } else {
    for (const [field, code, prop, strictSev] of header) {
      const val = m[field];
      if (val === undefined || (Array.isArray(val) && !val.length)) {
        push(sev(strictSev, 'warning'), `header-missing-${code}`, `ontology header has no ${prop}`, graph.ontologyIRI, LINT_REFERENCES.header);
      }
    }
  }

  const rank: Record<IssueSeverity, number> = { error: 0, warning: 1, info: 2 };
  return issues.sort((a, b) => rank[a.severity] - rank[b.severity] || a.code.localeCompare(b.code) || (a.iri ?? '').localeCompare(b.iri ?? ''));
}

/* ------------------------------------------------------------------------ */

/** The named subject an (possibly nested blank) node belongs to. */
function rootSubject(graph: OntologyGraph, t: Term, depth = 0): string | undefined {
  if (t.termType === 'NamedNode') return t.value;
  if (depth > 20) return undefined;
  const parent = graph.store.getQuads(null, null, t, null)[0];
  return parent ? rootSubject(graph, parent.subject as Term, depth + 1) : undefined;
}

/** Named classes in owl:intersectionOf of an equivalent-class definition (the logical genus). */
function namedConjuncts(graph: OntologyGraph, k: ClassView): string[] {
  const out: string[] = [];
  for (const e of objects(graph.store, k.iri, P.equivalentClass)) {
    if (e.termType !== 'BlankNode') continue;
    for (const head of objects(graph.store, e, NS.owl + 'intersectionOf')) {
      for (const m of readList(graph.store, head) ?? []) if (m.termType === 'NamedNode') out.push(m.value);
    }
  }
  return out;
}

function findCycles(parents: Map<string, string[]>): string[][] {
  const cycles: string[][] = [];
  const seenKey = new Set<string>();
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const dfs = (n: string) => {
    state.set(n, 1);
    stack.push(n);
    for (const p of parents.get(n) ?? []) {
      if (state.get(p) === 1) {
        const cyc = stack.slice(stack.indexOf(p));
        const key = [...cyc].sort().join(' ');
        if (!seenKey.has(key)) {
          seenKey.add(key);
          // rotate so the smallest IRI comes first (deterministic)
          const i = cyc.indexOf([...cyc].sort()[0]);
          cycles.push([...cyc.slice(i), ...cyc.slice(0, i)]);
        }
      } else if (!state.get(p)) dfs(p);
    }
    stack.pop();
    state.set(n, 2);
  };
  for (const n of [...parents.keys()].sort()) if (!state.get(n)) dfs(n);
  return cycles;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const splitCamel = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
const pluralise = (s: string) => (s.endsWith('y') ? s.slice(0, -1) + 'ies' : s + 's');

