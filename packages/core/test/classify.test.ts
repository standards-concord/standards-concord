import { describe, expect, it } from 'vitest';
import { DataFactory } from 'n3';
import {
  CLASSIFICATION_RULES, NS, XSD, applyChangeOps, bumpVersion, classifyChange, diffOntologies, migrationSparql, stampRelease,
} from '../src/index.js';
import type { ChangeOp, ClassifyOptions, OntologyGraph } from '../src/index.js';
import { X, baseOntology } from './helpers.js';

const { namedNode, blankNode } = DataFactory;

function run(ops: ChangeOp[], before: OntologyGraph = baseOntology(), opts?: ClassifyOptions) {
  const after = applyChangeOps(before, ops, { date: '2026-05-05' }).graph;
  const diff = diffOntologies(before, after);
  const c = classifyChange(diff, before, after, opts);
  return { ...c, rules: c.reasons.map((r) => r.rule), diff, before, after };
}

const withIndividuals = () => applyChangeOps(baseOntology(), [
  { op: 'addIndividual', localName: 'acme', label: 'Acme', types: [X('Organisation')] },
  { op: 'addIndividual', localName: 'ada', label: 'Ada', types: [X('Person')], facts: { [X('worksFor')]: [X('acme')] } },
]).graph;

describe('diffOntologies', () => {
  it('is empty for identical graphs', () => {
    const g = baseOntology();
    const d = diffOntologies(g, g.clone());
    expect(d.terms).toEqual([]);
    expect(d.addedTriples + d.removedTriples).toBe(0);
  });

  it('is blank-node insensitive', () => {
    const g = applyChangeOps(baseOntology(), [{ op: 'addRestriction', classIri: X('Employee'), restriction: { property: X('worksFor'), kind: 'some', filler: X('Organisation') } }]).graph;
    // Remove and re-add the same restriction: new blank node ids, same structure.
    const r = { property: X('worksFor'), kind: 'some' as const, filler: X('Organisation') };
    const g2 = applyChangeOps(applyChangeOps(g, [{ op: 'removeRestriction', classIri: X('Employee'), restriction: r }]).graph, [{ op: 'addRestriction', classIri: X('Employee'), restriction: r }]).graph;
    const d = diffOntologies(g, g2);
    expect(d.addedTriples + d.removedTriples).toBe(0);
    expect(d.terms).toEqual([]);
  });

  it('reports field-level changes with readable details and sorted N-Triples', () => {
    const { diff } = run([{ op: 'setDomainRange', iri: X('age'), range: [XSD.decimal] }]);
    const t = diff.terms.find((x) => x.iri === X('age'))!;
    expect(t.change).toBe('modified');
    expect(t.details).toEqual(['range: xsd:integer → xsd:decimal']);
    expect(t.fields).toEqual([{ field: 'range', added: [XSD.decimal], removed: [XSD.integer] }]);
    expect(diff.addedNTriples).toHaveLength(1);
    expect(diff.removedNTriples[0]).toContain('XMLSchema#integer');
  });
});

describe('classifyChange rules', () => {
  type Case = { rule: string; level: 'patch' | 'minor' | 'major'; ops?: ChangeOp[]; before?: () => OntologyGraph; edit?: (g: OntologyGraph) => void; opts?: ClassifyOptions };
  const cases: Case[] = [
    // PATCH
    { rule: 'annotation-changed', level: 'patch', ops: [{ op: 'updateAnnotations', iri: X('Person'), set: { definition: 'An agent that is an individual human being.', altLabels: ['human'] } }] },
    { rule: 'metadata-changed', level: 'patch', ops: [{ op: 'setMetadata', set: { description: 'Better description.', contributors: ['Grace'] } }] },
    { rule: 'deprecation-without-replacement', level: 'minor', ops: [{ op: 'deprecateTerm', iri: X('Employee'), reason: 'Not needed.' }] },
    // MINOR
    { rule: 'term-added', level: 'minor', ops: [{ op: 'addClass', localName: 'Volunteer', label: 'volunteer', definition: 'A person who gives time.', subClassOf: [X('Person')], restrictions: [{ property: X('worksFor'), kind: 'some', filler: X('Organisation') }] }] },
    { rule: 'term-deprecated', level: 'minor', ops: [{ op: 'deprecateTerm', iri: X('Employee'), reason: 'Merged.', replacedBy: X('Person') }] },
    { rule: 'term-renamed', level: 'minor', ops: [{ op: 'renameTerm', iri: X('Organisation'), newLocalName: 'Organization' }] },
    // No op un-deprecates, so edit the graph directly.
    { rule: 'term-undeprecated', level: 'minor', before: () => applyChangeOps(baseOntology(), [{ op: 'deprecateTerm', iri: X('Place'), reason: 'x' }]).graph,
      edit: (g) => g.store.removeQuads(g.store.getQuads(namedNode(X('Place')), namedNode(NS.owl + 'deprecated'), null, null)) },
    { rule: 'axiom-relates-new-term', level: 'minor', ops: [
      { op: 'addClass', localName: 'LivingThing', label: 'living thing', definition: 'An entity that is alive.' },
      { op: 'setSuperClasses', iri: X('Person'), superClasses: [X('Agent'), X('LivingThing')] },
    ] },
    { rule: 'mapping-added', level: 'minor', ops: [{ op: 'updateAnnotations', iri: X('Person'), set: { mappings: { [NS.skos + 'exactMatch']: ['https://schema.org/Person'] } } }] },
    { rule: 'domain-range-broadened', level: 'minor', ops: [{ op: 'setDomainRange', iri: X('worksFor'), domain: [X('Agent')] }] },
    { rule: 'import-added', level: 'minor', ops: [{ op: 'addImport', iri: 'http://www.w3.org/ns/prov-o' }] },
    { rule: 'individual-assertion-added', level: 'minor', before: withIndividuals,
      edit: (g) => g.store.addQuad(namedNode(X('ada')), namedNode(X('knows')), namedNode(X('ada'))) },
    // MAJOR
    { rule: 'term-removed', level: 'major', ops: [{ op: 'removeTerm', iri: X('Place') }] },
    { rule: 'namespace-changed', level: 'major', ops: [{ op: 'setMetadata', set: { preferredNamespace: 'https://example.org/other#' } }] },
    { rule: 'superclass-removed', level: 'major', ops: [{ op: 'setSuperClasses', iri: X('Employee'), superClasses: [] }] },
    { rule: 'superclass-added-existing', level: 'major', ops: [{ op: 'setSuperClasses', iri: X('Place'), superClasses: [X('Agent')] }] },
    { rule: 'disjointness-added', level: 'major', ops: [{ op: 'addDisjointness', classes: [X('Agent'), X('Place')] }] },
    { rule: 'disjointness-removed', level: 'major', ops: [{ op: 'removeDisjointness', classes: [X('Person'), X('Organisation')] }] },
    { rule: 'restriction-universal-added', level: 'major', ops: [{ op: 'addRestriction', classIri: X('Employee'), restriction: { property: X('worksFor'), kind: 'only', filler: X('Organisation') } }] },
    { rule: 'restriction-existential-added', level: 'major', ops: [{ op: 'addRestriction', classIri: X('Employee'), restriction: { property: X('worksFor'), kind: 'some', filler: X('Organisation') } }] },
    { rule: 'cardinality-added', level: 'major', ops: [{ op: 'addRestriction', classIri: X('Employee'), restriction: { property: X('worksFor'), kind: 'max', cardinality: 1 } }] },
    { rule: 'property-characteristic-added', level: 'major', ops: [{ op: 'setCharacteristics', iri: X('worksFor'), characteristics: ['functional'] }] },
    { rule: 'domain-narrowed', level: 'major', ops: [{ op: 'setDomainRange', iri: X('worksFor'), domain: [X('Employee')] }] },
    { rule: 'range-narrowed', level: 'major', ops: [{ op: 'setDomainRange', iri: X('knows'), range: [X('Employee')] }] },
    { rule: 'domain-range-replaced', level: 'major', ops: [{ op: 'setDomainRange', iri: X('worksFor'), range: [X('Place')] }] },
    { rule: 'datatype-range-changed', level: 'major', ops: [{ op: 'setDomainRange', iri: X('age'), range: [XSD.decimal] }] },
    { rule: 'label-or-definition-removed', level: 'major', ops: [{ op: 'updateAnnotations', iri: X('Place'), set: { definition: '' } }] },
  ];

  for (const c of cases) {
    it(`${c.rule} → ${c.level}`, () => {
      const before = c.before?.() ?? baseOntology();
      let rules: string[];
      let level: string;
      let messages: string[];
      if (c.edit) {
        const after = before.clone();
        c.edit(after);
        const cl = classifyChange(diffOntologies(before, after), before, after, c.opts);
        [rules, level, messages] = [cl.reasons.map((r) => r.rule), cl.level, cl.reasons.map((r) => r.message)];
      } else {
        const r = run(c.ops!, before, c.opts);
        [rules, level, messages] = [r.rules, r.level, r.reasons.map((x) => x.message)];
      }
      expect(rules).toContain(c.rule);
      expect(level).toBe(c.level);
      expect(messages[rules.indexOf(c.rule)].length).toBeGreaterThan(5);
    });
  }

  it('property-characteristic-removed, superproperty-changed, inverse-changed, equivalence-changed, restriction-removed', () => {
    const before = applyChangeOps(baseOntology(), [
      { op: 'setCharacteristics', iri: X('knows'), characteristics: ['symmetric'] },
      { op: 'addRestriction', classIri: X('Employee'), restriction: { property: X('worksFor'), kind: 'some', filler: X('Organisation') } },
      { op: 'addObjectProperty', localName: 'employs', label: 'employs', definition: 'Relates an organisation to a person it employs.', domain: [X('Organisation')], range: [X('Person')] },
    ]).graph;
    const after = applyChangeOps(before, [
      { op: 'setCharacteristics', iri: X('knows'), characteristics: [] },
      { op: 'removeRestriction', classIri: X('Employee'), restriction: { property: X('worksFor'), kind: 'some', filler: X('Organisation') } },
    ]).graph;
    
    after.store.addQuad(namedNode(X('employs')), namedNode(NS.owl + 'inverseOf'), namedNode(X('worksFor')));
    after.store.addQuad(namedNode(X('knows')), namedNode(NS.rdfs + 'subPropertyOf'), namedNode(X('worksFor')));
    after.store.addQuad(namedNode(X('Employee')), namedNode(NS.owl + 'equivalentClass'), namedNode(X('Person')));
    const rules = classifyChange(diffOntologies(before, after), before, after).reasons.map((r) => r.rule);
    for (const id of ['property-characteristic-removed', 'restriction-removed', 'inverse-changed', 'superproperty-changed', 'equivalence-changed']) expect(rules).toContain(id);
  });

  it('term-kind-changed, import-removed, individual-assertion-removed, mapping-removed', () => {
    const before = applyChangeOps(withIndividuals(), [
      { op: 'addImport', iri: 'http://www.w3.org/ns/prov-o' },
      { op: 'updateAnnotations', iri: X('Person'), set: { mappings: { [NS.skos + 'closeMatch']: ['https://schema.org/Person'] } } },
    ]).graph;
    const after = before.clone();
    const s = after.store;
    
    s.removeQuads(s.getQuads(null, namedNode(NS.owl + 'imports'), null, null));
    s.removeQuads(s.getQuads(namedNode(X('Person')), namedNode(NS.skos + 'closeMatch'), null, null));
    s.removeQuads(s.getQuads(namedNode(X('ada')), namedNode(X('worksFor')), null, null));
    s.removeQuads(s.getQuads(namedNode(X('name')), namedNode(NS.rdf + 'type'), namedNode(NS.owl + 'DatatypeProperty'), null));
    s.addQuad(namedNode(X('name')), namedNode(NS.rdf + 'type'), namedNode(NS.owl + 'ObjectProperty'));
    const rules = classifyChange(diffOntologies(before, after), before, after).reasons.map((r) => r.rule);
    for (const id of ['term-kind-changed', 'import-removed', 'individual-assertion-removed', 'mapping-removed']) expect(rules).toContain(id);
  });

  it('class-expression-changed for anonymous superclasses', () => {
    const before = baseOntology();
    const after = before.clone();
    
    const u = blankNode();
    const l1 = blankNode();
    const l2 = blankNode();
    const s = after.store;
    s.addQuad(namedNode(X('Employee')), namedNode(NS.rdfs + 'subClassOf'), u);
    s.addQuad(u, namedNode(NS.rdf + 'type'), namedNode(NS.owl + 'Class'));
    s.addQuad(u, namedNode(NS.owl + 'unionOf'), l1);
    s.addQuad(l1, namedNode(NS.rdf + 'first'), namedNode(X('Person')));
    s.addQuad(l1, namedNode(NS.rdf + 'rest'), l2);
    s.addQuad(l2, namedNode(NS.rdf + 'first'), namedNode(X('Place')));
    s.addQuad(l2, namedNode(NS.rdf + 'rest'), namedNode(NS.rdf + 'nil'));
    const c = classifyChange(diffOntologies(before, after), before, after);
    expect(c.reasons.map((r) => r.rule)).toContain('class-expression-changed');
    expect(c.reasons.find((r) => r.rule === 'class-expression-changed')!.message).toContain('ex:Person or ex:Place');
  });

  it('no-op for an empty diff', () => {
    const g = baseOntology();
    const c = classifyChange(diffOntologies(g, g.clone()));
    expect(c).toEqual({ level: 'patch', reasons: [{ rule: 'no-op', level: 'patch', message: 'no changes' }] });
  });

  it('rename is minor overall: reference rewrites caused by the rename are not breaking', () => {
    const r = run([{ op: 'renameTerm', iri: X('Organisation'), newLocalName: 'Organization' }]);
    expect(r.level).toBe('minor');
    expect(r.rules).toContain('term-renamed');
    expect(r.rules).not.toContain('domain-range-replaced');
    expect(r.rules).not.toContain('disjointness-added');
    expect(r.rules).not.toContain('term-added');
  });

  it('removing a term (vs deprecating) is major', () => {
    expect(run([{ op: 'removeTerm', iri: X('Employee') }]).level).toBe('major');
    expect(run([{ op: 'deprecateTerm', iri: X('Employee'), reason: 'x', replacedBy: X('Person') }]).level).toBe('minor');
  });

  it('lenientSubsumption downgrades existing→existing subclass links to minor', () => {
    const ops: ChangeOp[] = [{ op: 'setSuperClasses', iri: X('Place'), superClasses: [X('Agent')] }];
    expect(run(ops).level).toBe('major');
    const lenient = run(ops, baseOntology(), { lenientSubsumption: true });
    expect(lenient.level).toBe('minor');
    expect(lenient.rules).toContain('superclass-added-existing');
  });

  it('uses subclass closure: range broadened to a superclass is minor, narrowed is major', () => {
    expect(run([{ op: 'setDomainRange', iri: X('knows'), range: [X('Agent')] }]).rules).toEqual(['domain-range-broadened']);
    expect(run([{ op: 'setDomainRange', iri: X('knows'), range: [X('Employee')] }]).rules).toEqual(['range-narrowed']);
    // without graphs, any replacement is treated as unrelated (major)
    const before = baseOntology();
    const after = applyChangeOps(before, [{ op: 'setDomainRange', iri: X('knows'), range: [X('Agent')] }]).graph;
    expect(classifyChange(diffOntologies(before, after)).level).toBe('major');
  });

  it('a new class plus its own axioms is only minor', () => {
    const r = run([
      { op: 'addClass', localName: 'Volunteer', label: 'volunteer', definition: 'A person who gives time.', subClassOf: [X('Person')], disjointWith: [X('Employee')] },
    ]);
    expect(r.level).toBe('minor');
    expect(r.rules).toEqual(['axiom-relates-new-term', 'term-added']);
  });

  it('every rule id is unique and documented', () => {
    const ids = CLASSIFICATION_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ['term-removed', 'range-narrowed', 'disjointness-added', 'restriction-universal-added', 'cardinality-added', 'property-characteristic-added', 'superclass-removed', 'superclass-added-existing', 'term-added', 'term-deprecated', 'domain-range-broadened', 'annotation-changed', 'metadata-changed']) {
      expect(ids).toContain(id);
    }
  });
});

describe('versioning', () => {
  it('bumpVersion follows semver', () => {
    expect(bumpVersion('0.1.0', 'patch')).toBe('0.1.1');
    expect(bumpVersion('0.1.3', 'minor')).toBe('0.2.0');
    expect(bumpVersion('1.4.2', 'major')).toBe('2.0.0');
    expect(bumpVersion('v1.2', 'patch')).toBe('1.2.1');
    expect(bumpVersion('1.0.0-rc.1', 'minor')).toBe('1.1.0');
    expect(() => bumpVersion('latest', 'minor')).toThrow();
  });

  it('stampRelease sets OWL versioning annotations', () => {
    const g = baseOntology();
    const prior = g.view().metadata.versionIRI!;
    const minor = stampRelease(g, { version: '0.2.0', level: 'minor', date: '2026-06-01', backwardCompatible: true });
    const m = minor.view().metadata;
    expect(m.versionIRI).toBe('https://example.org/test/0.2.0');
    expect(m.versionInfo).toBe('0.2.0');
    expect(m.priorVersion).toBe(prior);
    expect(m.backwardCompatibleWith).toEqual([prior]);
    expect(m.incompatibleWith).toEqual([]);
    expect(m.modified).toBe('2026-06-01');
    expect(m.issued).toBe('2026-06-01');
    expect(minor.literalOf(minor.ontologyIRI, NS.dcterms + 'bibliographicCitation')).toContain('Version 0.2.0');
    const major = stampRelease(minor, { version: '1.0.0', level: 'major', date: '2026-07-01', backwardCompatible: false, versionIRIBase: 'https://example.org/test/releases/' });
    const mm = major.view().metadata;
    expect(mm.versionIRI).toBe('https://example.org/test/releases/1.0.0');
    expect(mm.priorVersion).toBe('https://example.org/test/0.2.0');
    expect(mm.incompatibleWith).toEqual(['https://example.org/test/0.2.0']);
    expect(mm.backwardCompatibleWith).toEqual([]);
    const hosted = stampRelease(g, { version: '1.0.0', versionIRI: 'https://concord.example/def/test/1.0.0', priorVersionIRI: 'https://concord.example/def/test/0.1.0', level: 'minor', date: '2026-07-01', backwardCompatible: true });
    expect(hosted.metadata()).toMatchObject({ versionIRI: 'https://concord.example/def/test/1.0.0', priorVersion: 'https://concord.example/def/test/0.1.0', backwardCompatibleWith: ['https://concord.example/def/test/0.1.0'] });
    expect(g.view().metadata.versionInfo).toBe('0.1.0'); // input untouched
  });

  it('migrationSparql rewrites instance data for renamed and replaced terms', () => {
    const r = run([
      { op: 'renameTerm', iri: X('Organisation'), newLocalName: 'Organization' },
      { op: 'renameTerm', iri: X('worksFor'), newLocalName: 'employedBy' },
      { op: 'deprecateTerm', iri: X('Place'), reason: 'out of scope' },
      { op: 'removeTerm', iri: X('Employee') },
    ]);
    const q = migrationSparql(r.before, r.after, r.diff);
    expect(q).toContain(`DELETE { ?s a <${X('Organisation')}> } INSERT { ?s a <${X('Organization')}> } WHERE { ?s a <${X('Organisation')}> }`);
    expect(q).toContain(`DELETE { ?s <${X('worksFor')}> ?v } INSERT { ?s <${X('employedBy')}> ?v }`);
    expect(q).toMatch(/ex:Place was deprecated without a replacement/);
    expect(q).toMatch(/ex:Employee was removed without a replacement/);
  });
});

