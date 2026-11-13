import { describe, expect, it } from 'vitest';
import type { ChangeOp, OntologyView } from '@concord/shared';
import { dependentEdits, draftedNameError, renameDraftedTerm, rewriteOpIris } from './changeRequestEdits';

const ns = 'https://example.org/terms#';
const old = ns + 'Before';
const next = ns + 'After';
const r = { property: old, kind: 'value' as const, filler: old, literal: old, fillerExpression: `(<${old}> or ex:Before) and ex:BeforeOther and "${old}"` };
const annotations = { label: old, definition: old, comment: old, altLabels: [old], examples: [old], editorialNote: old, source: [old, 'written source'], mappings: { [old]: [old] } };
const cases: ChangeOp[] = [
  { op: 'addClass', localName: 'Before', ...annotations, subClassOf: [old], equivalentTo: [old], disjointWith: [old], restrictions: [r] },
  { op: 'addObjectProperty', localName: 'before', ...annotations, domain: [old], range: [old], subPropertyOf: [old], inverseOf: old, codeList: old, characteristics: ['functional'] },
  { op: 'addDatatypeProperty', localName: 'before', ...annotations, domain: [old], range: [old], subPropertyOf: [old], functional: true },
  { op: 'addIndividual', localName: 'before', ...annotations, types: [old], facts: { [old]: [old, 'a literal'] } },
  { op: 'addConceptScheme', localName: 'Before', label: 'before', definition: 'before', source: [old] },
  { op: 'addConcept', localName: 'before', label: 'before', definition: 'before', scheme: old, broader: old, source: [old] },
  { op: 'updateAnnotations', iri: old, set: annotations, expect: { label: old, source: [old] } },
  { op: 'updateConcept', iri: old, set: { label: old, notation: old }, expect: { label: old } },
  { op: 'moveConcept', iri: old, broader: old, expect: { broader: old } },
  { op: 'setCodeList', property: old, scheme: old },
  { op: 'setSuperClasses', iri: old, superClasses: [old] },
  { op: 'setDomainRange', iri: old, domain: [old], range: [old] },
  { op: 'addRestriction', classIri: old, restriction: r },
  { op: 'removeRestriction', classIri: old, restriction: r },
  { op: 'addDisjointness', classes: [old] },
  { op: 'removeDisjointness', classes: [old] },
  { op: 'setCharacteristics', iri: old, characteristics: ['transitive'] },
  { op: 'deprecateTerm', iri: old, reason: old, replacedBy: old },
  { op: 'deprecateConcept', iri: old, reason: old, replacedBy: old },
  { op: 'removeTerm', iri: old }, { op: 'renameTerm', iri: old, newLocalName: 'Before' },
  { op: 'setMetadata', set: { versionIRI: old, priorVersion: old, backwardCompatibleWith: [old], incompatibleWith: [old], creators: [old], contributors: [old], publisher: old, license: old, preferredNamespace: old, title: old, description: old } },
  { op: 'addImport', iri: old },
];
describe('rewriting drafted term references', () => {
  it.each(cases.map((op) => [op.op, op] as const))('rewrites every IRI field of %s without changing literal wording or the input', (_, op) => {
    const original = structuredClone(op);
    const rewritten = rewriteOpIris(op, old, next, { ex: ns });
    // Assert both the rewritten references and the prose/baselines that must stay untouched.
    expect(op).toEqual(original);
    expect(rewritten.op).toBe(op.op);
    if ('localName' in op) expect(rewritten).toMatchObject({ localName: op.localName });
    if ('newLocalName' in op) expect(rewritten).toMatchObject({ newLocalName: op.newLocalName });
    if ('iri' in rewritten) expect(rewritten.iri).toBe(next);
    if ('classIri' in rewritten) expect(rewritten.classIri).toBe(next);
    for (const key of ['subClassOf', 'equivalentTo', 'disjointWith', 'domain', 'range', 'subPropertyOf', 'types', 'superClasses', 'classes'] as const)
      if (key in rewritten) expect((rewritten as unknown as Record<string, unknown>)[key]).toEqual([next]);
    for (const key of ['scheme', 'broader', 'inverseOf', 'codeList', 'replacedBy', 'property'] as const)
      if (key in rewritten) expect((rewritten as unknown as Record<string, unknown>)[key]).toBe(next);
    if ('expect' in op && op.op !== 'moveConcept') expect('expect' in rewritten && rewritten.expect).toEqual(op.expect);
    const a = 'set' in rewritten ? rewritten.set : rewritten;
    if ('source' in a) expect(a.source).toEqual([next, ...('source' in op && op.source?.length === 1 ? [] : ['written source'])]);
    if ('mappings' in a) expect(a.mappings).toEqual({ [next]: [next] });
    for (const key of ['label', 'definition', 'comment', 'altLabels', 'examples', 'editorialNote', 'reason', 'literal', 'notation'] as const)
      if (key in a) expect((a as Record<string, unknown>)[key]).toEqual((('set' in op ? op.set : op) as Record<string, unknown>)[key]);
    const restriction = 'restriction' in rewritten ? rewritten.restriction : 'restrictions' in rewritten ? rewritten.restrictions?.[0] : undefined;
    if (restriction) expect(restriction).toEqual({ ...r, property: next, filler: next, fillerExpression: `(<${next}> or <${next}>) and ex:BeforeOther and "${old}"` });
    if ('facts' in rewritten) expect(rewritten.facts).toEqual({ [next]: [next, 'a literal'] });
    if (rewritten.op === 'moveConcept') expect(rewritten.expect).toEqual({ broader: next });
    if (rewritten.op === 'setMetadata') expect(rewritten.set).toEqual({ ...(op.op === 'setMetadata' ? op.set : {}), versionIRI: next, priorVersion: next, backwardCompatibleWith: [next], incompatibleWith: [next], creators: [next], contributors: [next], publisher: next, license: next, preferredNamespace: next });
  });
  it('renames the addition and references atomically, including CURIEs, and reports dependencies only', () => {
    const ops: ChangeOp[] = [cases[0], { op: 'setSuperClasses', iri: 'ex:Child', superClasses: ['ex:Before'] }, { op: 'updateAnnotations', iri: 'ex:Child', set: { definition: old } }];
    const result = renameDraftedTerm(ops, 0, 'After', ns, { ex: ns });
    expect(result[0]).toMatchObject({ localName: 'After', subClassOf: [next] });
    expect(result[1]).toMatchObject({ superClasses: [next] });
    expect(result[2]).toEqual(ops[2]);
    expect(dependentEdits(ops, 0, ns, { ex: ns })).toEqual([1]);
    expect(ops[0]).toMatchObject({ localName: 'Before' });
  });
  it('leaves the values of datatype-property facts alone, whether the property is drafted or already in the ontology', () => {
    // Fact values under a datatype property are literal text. Renaming a drafted term used to rewrite a
    // literal that happened to spell the old IRI.
    const view = { classes: [], objectProperties: [], datatypeProperties: [{ iri: ns + 'seeAlsoText' }], annotationProperties: [], individuals: [], conceptSchemes: [], concepts: [] } as unknown as OntologyView;
    const ops: ChangeOp[] = [
      { op: 'addClass', localName: 'Before', label: 'before', definition: 'Before.' },
      { op: 'addDatatypeProperty', localName: 'note', label: 'note', definition: 'A note.' },
      { op: 'addIndividual', localName: 'thing', label: 'thing', definition: 'A thing.', types: [old], facts: { 'ex:note': [old], [ns + 'seeAlsoText']: [old], [ns + 'relatedTo']: [old] } },
    ];
    const result = renameDraftedTerm(ops, 0, 'After', ns, { ex: ns }, view);
    expect(result[2]).toMatchObject({ types: [next], facts: { 'ex:note': [old], [ns + 'seeAlsoText']: [old], [ns + 'relatedTo']: [next] } });
    // Renaming the drafted datatype property itself moves the key and still keeps the literal.
    expect(renameDraftedTerm(ops, 1, 'remark', ns, { ex: ns }, view)[2]).toMatchObject({ facts: { [ns + 'remark']: [old] } });
  });
  it('keeps literal fact values under a datatype property that the request itself renames', () => {
    // A property renamed earlier in the same request was not recognised under its new name, so a literal
    // spelling the old IRI was rewritten.
    const view = { classes: [], objectProperties: [], datatypeProperties: [{ iri: ns + 'note' }], annotationProperties: [], individuals: [], conceptSchemes: [], concepts: [] } as unknown as OntologyView;
    const ops: ChangeOp[] = [
      { op: 'addClass', localName: 'Before', label: 'before', definition: 'Before.' },
      { op: 'renameTerm', iri: 'ex:note', newLocalName: 'remark' },
      { op: 'addDatatypeProperty', localName: 'memo', label: 'memo', definition: 'A memo.' },
      { op: 'renameTerm', iri: `<${ns}memo>`, newLocalName: 'minute' },
      { op: 'addIndividual', localName: 'thing', label: 'thing', definition: 'A thing.', types: [old], facts: { 'ex:remark': [old], 'ex:minute': [old] } },
    ];
    expect(renameDraftedTerm(ops, 0, 'After', ns, { ex: ns }, view)[4]).toMatchObject({ types: [next], facts: { 'ex:remark': [old], 'ex:minute': [old] } });
  });
  it('rewrites and finds references written as <IRI> or with surrounding spaces', () => {
    // The engine accepts both spellings; a child left pointing at the old name failed validation after a rename.
    const ops: ChangeOp[] = [cases[0], { op: 'addClass', localName: 'Child', label: 'child', definition: 'Child.', subClassOf: [`<${old}>`] }, { op: 'setSuperClasses', iri: 'ex:Other', superClasses: [' ex:Before '] }];
    const result = renameDraftedTerm(ops, 0, 'After', ns, { ex: ns });
    expect(result[1]).toMatchObject({ subClassOf: [next] });
    expect(result[2]).toMatchObject({ superClasses: [next] });
    expect(dependentEdits(ops, 0, ns, { ex: ns })).toEqual([1, 2]);
  });
  it('counts edits to a renamed term as depending on the rename', () => {
    // Removing a rename used to give no warning, and the edits to the new name then failed: that term no longer exists.
    const ops: ChangeOp[] = [{ op: 'renameTerm', iri: old, newLocalName: 'After' }, { op: 'updateAnnotations', iri: 'ex:After', set: { definition: 'Clearer.' } }, { op: 'updateAnnotations', iri: old, set: { definition: 'Unrelated to the new name.' } }];
    expect(dependentEdits(ops, 0, ns, { ex: ns })).toEqual([1]);
  });
  it('preserves missing optional fields, null code-list links and unrelated IRIs', () => {
    for (const op of [{ op: 'addClass', localName: 'Other', label: 'other', definition: 'Other.' }, { op: 'setCodeList', property: 'elsewhere', scheme: null }, { op: 'moveConcept', iri: 'elsewhere', broader: null, expect: { broader: null } }] satisfies ChangeOp[])
      expect(rewriteOpIris(op, old, next)).toEqual(op);
  });
  it('uses engine naming rules and refuses existing and drafted IRI collisions across term kinds', () => {
    const view = { classes: [{ iri: next }], objectProperties: [], datatypeProperties: [], annotationProperties: [], individuals: [], conceptSchemes: [], concepts: [] } as unknown as OntologyView;
    const op = cases[0];
    if (!('localName' in op)) throw new Error('Expected an addition');
    for (const name of ['', 'two words', 'two-words', 'lowercase', 'café', 'After']) expect(draftedNameError(op, name, ns, view, [op], 0)).toBeTruthy();
    expect(draftedNameError(op, 'Fresh2', ns, view, [op], 0)).toBeUndefined();
    expect(draftedNameError(op, 'Before', ns, view, [op], 0)).toBeUndefined();
    expect(draftedNameError(op, 'Fresh2', ns, view, [op, { op: 'addConcept', localName: 'Fresh2', label: 'fresh', definition: 'Fresh.', scheme: 'list' }], 0)).toMatch(/already used/);
    expect(draftedNameError(op, 'Fresh2', ns, view, [op, { op: 'renameTerm', iri: 'existing', newLocalName: 'Fresh2' }], 0)).toMatch(/already used/);
  });
});
