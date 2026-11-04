import { describe, expect, it } from 'vitest';
import type { ClassView, OntologyView, PropertyView, Restriction } from '@concord/core/types';
import { OntologyGraph } from '@concord/core';
import volunteering from '../../../../packages/core/fixtures/volunteering.ttl?raw';
import { buildModel, slotCard, type OntologyModel } from './ontologyModel';

const NS = 'https://example.org/t#';
const I = (l: string) => NS + l;

function cls(l: string, opts: { sup?: string[]; r?: Restriction[] } = {}): ClassView {
  return { kind: 'class', iri: I(l), label: l, superClasses: (opts.sup ?? []).map(I), equivalentClasses: [], disjointWith: [], restrictions: opts.r ?? [] };
}
function prop(l: string, opts: Partial<Omit<PropertyView, 'iri' | 'kind'>> & { kind?: PropertyView['kind'] } = {}): PropertyView {
  return { kind: opts.kind ?? 'objectProperty', iri: I(l), label: l, domain: opts.domain ?? [], range: opts.range ?? [], superProperties: opts.superProperties ?? [], characteristics: opts.characteristics ?? [], inverseOf: opts.inverseOf };
}
function model(classes: ClassView[], props: PropertyView[]): OntologyModel {
  const view: OntologyView = {
    metadata: { iri: 'https://example.org/t', creators: [], contributors: [] } as unknown as OntologyView['metadata'],
    classes,
    objectProperties: props.filter((p) => p.kind === 'objectProperty'),
    datatypeProperties: props.filter((p) => p.kind === 'datatypeProperty'),
    annotationProperties: [],
    individuals: [],
    prefixes: {},
    tripleCount: 0,
  };
  return buildModel(view);
}
const r = (property: string, kind: Restriction['kind'], filler?: string, cardinality?: number): Restriction => ({ property: I(property), kind, filler: filler && I(filler), cardinality });
const slot = (m: OntologyModel, c: string, p: string) => m.allSlots(I(c)).flatMap((g) => g.slots).find((s) => s.property.iri === I(p));

const animals = [cls('Animal'), cls('Cat', { sup: ['Animal'] }), cls('Dog', { sup: ['Animal'] })];
const hasPet = prop('hasPet', { range: [I('Animal')] });

describe('ontology model: cardinality semantics', () => {
  it('does not turn "max 1 Cat" plus "some Dog" into "exactly 1 Dog"', () => {
    const m = model([...animals, cls('Owner', { r: [r('hasPet', 'max', 'Cat', 1), r('hasPet', 'some', 'Dog')] })], [hasPet]);
    const s = slot(m, 'Owner', 'hasPet')!;
    expect(s.range).toEqual([I('Animal')]);
    expect(slotCard(s)).toBe('1..*');
    expect(s.conflict).toBeUndefined();
    expect(s.qualified.map((q) => [q.kind, q.filler])).toEqual(
      expect.arrayContaining([
        ['max', I('Cat')],
        ['some', I('Dog')],
      ]),
    );
  });

  it('keeps every existential, not just the last one', () => {
    const m = model([...animals, cls('Owner', { r: [r('hasPet', 'some', 'Cat'), r('hasPet', 'some', 'Dog')] })], [hasPet]);
    const s = slot(m, 'Owner', 'hasPet')!;
    expect(s.qualified.filter((q) => q.kind === 'some').map((q) => q.filler)).toEqual([I('Cat'), I('Dog')]);
    expect(s.min).toBe(1);
  });

  it('keeps an inherited minimum when a subclass narrows the type with "only"', () => {
    const m = model([...animals, cls('Owner', { r: [r('hasPet', 'min', undefined, 2)] }), cls('CatOwner', { sup: ['Owner'], r: [r('hasPet', 'only', 'Cat')] })], [hasPet]);
    const s = slot(m, 'CatOwner', 'hasPet')!;
    expect(s.range).toEqual([I('Cat')]);
    expect(s.closed).toBe(true);
    expect(slotCard(s)).toBe('2..*');
    expect(s.from).toBe(I('CatOwner'));
  });

  it('combines bounds from two parents', () => {
    const m = model([...animals, cls('A', { r: [r('hasPet', 'min', undefined, 2)] }), cls('B', { r: [r('hasPet', 'max', undefined, 3)] }), cls('C', { sup: ['A', 'B'] })], [hasPet]);
    expect(slotCard(slot(m, 'C', 'hasPet')!)).toBe('2..3');
  });

  it('flags contradictory bounds instead of showing an impossible range', () => {
    const m = model([...animals, cls('A', { r: [r('hasPet', 'min', undefined, 2)] }), cls('B', { sup: ['A'], r: [r('hasPet', 'max', undefined, 1)] })], [hasPet]);
    const s = slot(m, 'B', 'hasPet')!;
    expect(s.conflict).toBeTruthy();
    expect(slotCard(s)).toBe('conflict');
  });

  it('flags a functional property that is required to have two values', () => {
    const m = model([...animals, cls('Owner', { r: [r('hasPet', 'exactly', undefined, 2)] })], [prop('hasPet', { range: [I('Animal')], characteristics: ['functional'] })]);
    expect(slot(m, 'Owner', 'hasPet')!.conflict).toBeTruthy();
  });

  it('flags a qualified minimum above a maximum that covers it', () => {
    const m = model([...animals, cls('Owner', { r: [r('hasPet', 'min', 'Cat', 3), r('hasPet', 'max', 'Animal', 2)] })], [hasPet]);
    expect(slot(m, 'Owner', 'hasPet')!.conflict).toMatch(/at least 3/);
  });

  it('uses a qualified cardinality on the range class as the overall bound', () => {
    const m = model([...animals, cls('Owner', { r: [r('hasPet', 'exactly', 'Animal', 1)] })], [hasPet]);
    const s = slot(m, 'Owner', 'hasPet')!;
    expect(slotCard(s)).toBe('1');
    expect(s.qualified.every((q) => q.implied)).toBe(true);
  });

  it('intersects ranges rather than offering a choice', () => {
    const people = [cls('Person'), cls('Employee', { sup: ['Person'] }), cls('Robot'), cls('Firm')];
    const m = model(people, [prop('employs', { domain: [I('Firm')], range: [I('Person'), I('Robot')] }), prop('manages', { domain: [I('Firm')], range: [I('Person'), I('Employee')] })]);
    expect(slot(m, 'Firm', 'employs')!.range.sort()).toEqual([I('Person'), I('Robot')]);
    // Employee is already a Person, so the intersection is just Employee.
    expect(slot(m, 'Firm', 'manages')!.range).toEqual([I('Employee')]);
  });

  it('includes ranges inherited from a super-property', () => {
    const m = model([...animals, cls('Owner')], [hasPet, prop('hasCat', { domain: [I('Owner')], range: [I('Cat')], superProperties: [I('hasPet')] })]);
    expect(slot(m, 'Owner', 'hasCat')!.range).toEqual([I('Cat')]);
  });

  it('treats a property as functional when its inverse is inverse-functional', () => {
    const people = [cls('Person'), cls('Passport')];
    const props = [prop('holder', { domain: [I('Passport')], range: [I('Person')] }), prop('holds', { domain: [I('Person')], range: [I('Passport')], inverseOf: I('holder'), characteristics: ['inverseFunctional'] })];
    expect(slotCard(slot(model(people, props), 'Passport', 'holder')!)).toBe('0..1');
    const props2 = [prop('holder', { domain: [I('Passport')], range: [I('Person')], inverseOf: I('holds') }), prop('holds', { domain: [I('Person')], characteristics: ['inverseFunctional'] })];
    expect(slotCard(slot(model(people, props2), 'Passport', 'holder')!)).toBe('0..1');
  });

  it('lists axioms it cannot summarise', () => {
    const c = cls('Owner');
    c.superClassExpressions = ['hasPet some (Cat or Dog)'];
    const m = model([...animals, c, cls('Kid', { sup: ['Owner'] })], [hasPet]);
    expect(m.unsummarised(I('Kid'))).toEqual([{ on: I('Owner'), text: 'SubClassOf: hasPet some (Cat or Dog)' }]);
  });
});

describe('ontology model: hierarchy', () => {
  it('bounds inheritance paths in a heavily multiply-inherited hierarchy', () => {
    // A ladder of diamonds: 2^30 paths from the bottom to the top.
    const classes = [cls('L0')];
    for (let i = 1; i <= 30; i++) classes.push(cls(`A${i}`, { sup: [`L${i - 1}`] }), cls(`B${i}`, { sup: [`L${i - 1}`] }), cls(`L${i}`, { sup: [`A${i}`, `B${i}`] }));
    const m = model(classes, []);
    const t = performance.now();
    const { paths, more } = m.paths(I('L30'), 4);
    expect(performance.now() - t).toBeLessThan(200);
    expect(paths).toHaveLength(4);
    expect(more).toBe(true);
    expect(paths[0][0]).toBe(I('L0'));
    expect(paths[0].at(-1)).toBe(I('L30'));
    expect(m.ancestors(I('L30'))).toHaveLength(90);
  });
});

describe('ontology model: the volunteering demo ontology', async () => {
  const m = buildModel((await OntologyGraph.fromTurtle(volunteering)).view());
  const VOL = 'https://w3id.org/odi/volunteering#';

  it('shows the same cardinality in the table and in "points here"', () => {
    const s = m.allSlots(VOL + 'Application').flatMap((g) => g.slots).find((x) => x.property.iri === VOL + 'submittedBy')!;
    expect(slotCard(s)).toBe('1');
    const rel = m.incoming(VOL + 'Person').find((x) => x.property.iri === VOL + 'submittedBy' && x.from === VOL + 'Application')!;
    expect(rel.card).toBe('1');
  });

  it('has no contradictions', () => {
    for (const c of m.classes.keys()) for (const g of m.allSlots(c)) for (const s of g.slots) expect(s.conflict, `${c} ${s.property.iri}`).toBeUndefined();
  });
});
