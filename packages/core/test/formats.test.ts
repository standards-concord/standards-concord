import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { DataFactory } from 'n3';
import { NS, OntologyGraph, applyChangeOps, fromLinkML, lint, toLinkML, toManchester, toShacl } from '../src/index.js';
import { X, baseOntology, linkmlBin, loadFixture } from './helpers.js';

const VOL = 'https://w3id.org/odi/volunteering#';
const { namedNode, blankNode } = DataFactory;

describe('LinkML', () => {
  it('maps classes, slots, ranges, requiredness and multiplicity', async () => {
    const schema = YAML.parse(toLinkML(await loadFixture()));
    expect(schema.id).toBe('https://w3id.org/odi/volunteering');
    expect(schema.default_prefix).toBe('vol');
    expect(schema.prefixes.vol).toBe(VOL);
    expect(schema.imports).toEqual(['linkml:types']);
    const vol = schema.classes.Volunteer;
    expect(vol.is_a).toBe('Person');
    expect(vol.class_uri).toBe('vol:Volunteer');
    expect(vol.description).toMatch(/^A person who/);
    const app = schema.classes.Application;
    expect(app.slots).toEqual(['for_opportunity', 'submitted_at', 'submitted_by']);
    expect(app.slot_usage.submitted_by).toEqual({ required: true, multivalued: false });
    expect(schema.classes.VolunteeringOpportunity.slot_usage.has_role).toEqual({ required: true });
    expect(schema.classes.Session.slots).toContain('has_location'); // via union domain
    expect(schema.slots.submitted_by).toMatchObject({ slot_uri: 'vol:submittedBy', range: 'Person', domain: 'Application', multivalued: false });
    expect(schema.slots.has_skill).toMatchObject({ range: 'Skill', multivalued: true });
    expect(schema.slots.minimum_age).toMatchObject({ range: 'integer', minimum_value: 0, multivalued: false });
    expect(schema.slots.start_date_time.range).toBe('datetime');
    expect(schema.slots.joining_url.range).toBe('uri');
    expect(schema.slots.requires_background_check.range).toBe('boolean');
    expect(schema.slots.hours_per_week.range).toBe('decimal');
    expect(schema.slots.offered_by.inverse).toBe('offers_opportunity');
  });

  it('maps deprecation, enums (owl:oneOf) and external superclasses', async () => {
    let g = applyChangeOps(baseOntology(), [
      { op: 'addClass', localName: 'Frequency', label: 'frequency', definition: 'A pattern of repetition.' },
      { op: 'addIndividual', localName: 'Weekly', label: 'weekly', types: [X('Frequency')] },
      { op: 'addIndividual', localName: 'Monthly', label: 'monthly', types: [X('Frequency')] },
      { op: 'addClass', localName: 'Venue', label: 'venue', definition: 'A place where events happen.', subClassOf: ['https://schema.org/Place'] },
      { op: 'deprecateTerm', iri: X('Employee'), reason: 'Use person.', replacedBy: X('Person') },
    ]).graph;
    g = g.clone();
    const s = g.store;
    const one = blankNode(); const l1 = blankNode(); const l2 = blankNode();
    s.addQuad(namedNode(X('Frequency')), namedNode(NS.owl + 'equivalentClass'), one);
    s.addQuad(one, namedNode(NS.rdf + 'type'), namedNode(NS.owl + 'Class'));
    s.addQuad(one, namedNode(NS.owl + 'oneOf'), l1);
    s.addQuad(l1, namedNode(NS.rdf + 'first'), namedNode(X('Weekly')));
    s.addQuad(l1, namedNode(NS.rdf + 'rest'), l2);
    s.addQuad(l2, namedNode(NS.rdf + 'first'), namedNode(X('Monthly')));
    s.addQuad(l2, namedNode(NS.rdf + 'rest'), namedNode(NS.rdf + 'nil'));
    const schema = YAML.parse(toLinkML(g));
    expect(schema.enums.Frequency.permissible_values).toEqual({ Weekly: { meaning: 'ex:Weekly', description: 'weekly' }, Monthly: { meaning: 'ex:Monthly', description: 'monthly' } });
    expect(schema.classes.Frequency).toBeUndefined();
    expect(schema.classes.Employee.deprecated).toBe('Use person.');
    expect(schema.classes.Employee.deprecated_element_has_exact_replacement).toBe('ex:Person');
    expect(schema.classes.Venue.broad_mappings).toEqual(['schema:Place']);
    // round trip the enum back to owl:oneOf
    const back = await fromLinkML(toLinkML(g));
    const freq = back.term(X('Frequency'));
    expect(freq?.kind === 'class' && freq.equivalentExpressions).toEqual(['{ex:Weekly , ex:Monthly}']);
  });

  it('fromLinkML recovers the OWL structure', async () => {
    const g = await loadFixture();
    const back = await fromLinkML(toLinkML(g));
    const v = back.view();
    expect(v.classes.map((c) => c.iri)).toEqual(g.view().classes.map((c) => c.iri));
    expect(v.objectProperties.map((p) => p.iri)).toEqual(g.view().objectProperties.map((p) => p.iri));
    expect(v.datatypeProperties.map((p) => p.iri)).toEqual(g.view().datatypeProperties.map((p) => p.iri));
    const vol = back.term(VOL + 'Volunteer');
    expect(vol?.kind === 'class' && vol.superClasses).toEqual([VOL + 'Person']);
    const app = back.term(VOL + 'Application');
    expect(app?.kind === 'class' && app.restrictions.map((r) => r.kind).sort()).toEqual(['some', 'some']);
    const sb = back.term(VOL + 'submittedBy');
    expect(sb?.kind === 'objectProperty' && sb.characteristics).toEqual(['functional']);
    const loc = back.term(VOL + 'hasLocation');
    expect(loc?.kind === 'objectProperty' && loc.domainExpressions).toEqual(['vol:Session or vol:VolunteeringOpportunity']);
    expect(lint(back, { strict: true }).filter((i) => i.severity === 'error')).toEqual([]);
  });

  const hasLinkML = existsSync(linkmlBin('linkml-lint')) && existsSync(linkmlBin('gen-owl'));
  it.skipIf(!hasLinkML)('produces a schema accepted by linkml-lint and gen-owl', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'concord-linkml-'));
    const file = path.join(dir, 'volunteering.yaml');
    writeFileSync(file, toLinkML(await loadFixture()));
    const lintOut = execFileSync(linkmlBin('linkml-lint'), [file], { encoding: 'utf8' });
    expect(lintOut).toMatch(/No problems found/);
    const owl = execFileSync(linkmlBin('gen-owl'), [file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const back = await OntologyGraph.fromTurtle(owl);
    expect(back.view().classes.length).toBeGreaterThanOrEqual(16);
  }, 120000);
});

describe('Manchester syntax', () => {
  it('writes frames with annotations, axioms and characteristics', async () => {
    const m = toManchester(await loadFixture());
    expect(m).toMatch(/^Prefix: dcat: <http:\/\/www\.w3\.org\/ns\/dcat#>/);
    expect(m).toContain('Prefix: vol: <https://w3id.org/odi/volunteering#>');
    expect(m).toContain('Ontology: <https://w3id.org/odi/volunteering> <https://w3id.org/odi/volunteering/0.1.0>');
    expect(m).toMatch(/Class: vol:Application\n    Annotations: \n[\s\S]*?    SubClassOf: \n        vol:forOpportunity exactly 1 vol:VolunteeringOpportunity,\n        vol:submittedBy exactly 1 vol:Person/);
    expect(m).toMatch(/ObjectProperty: vol:submittedBy[\s\S]*?Characteristics: Functional/);
    expect(m).toMatch(/ObjectProperty: vol:offeredBy[\s\S]*?InverseOf: vol:offersOpportunity/);
    expect(m).toMatch(/ObjectProperty: vol:hasLocation[\s\S]*?Domain: vol:VolunteeringOpportunity or vol:Session/);
    expect(m).toMatch(/DataProperty: vol:startDateTime[\s\S]*?Range: xsd:dateTime/);
    expect(m).toMatch(/Class: vol:Session[\s\S]*?SubClassOf: vol:startDateTime some xsd:dateTime/);
    expect(m).toMatch(/Class: vol:PhysicalLocation[\s\S]*?DisjointWith: vol:OnlineLocation/);
    expect(m).toMatch(/DisjointClasses: \n    vol:Agent,/);
  });

  it('writes individuals with types and facts', () => {
    const g = applyChangeOps(baseOntology(), [
      { op: 'addIndividual', localName: 'acme', label: 'Acme', types: [X('Organisation')] },
      { op: 'addIndividual', localName: 'ada', label: 'Ada', types: [X('Person')], facts: { [X('worksFor')]: [X('acme')], [X('age')]: ['36'] } },
    ]).graph;
    const m = toManchester(g);
    expect(m).toMatch(/Individual: ex:ada\n[\s\S]*?Types: ex:Person\n    Facts: \n        ex:age 36,\n        ex:worksFor ex:acme/);
  });
});

describe('SHACL', () => {
  it('derives node shapes with OWL-faithful constraints', async () => {
    const ttl = await toShacl(await loadFixture());
    const shapes = await OntologyGraph.fromTurtle(ttl);
    const s = shapes.store;
    const SH = NS.sh;
    const shape = namedNode('https://w3id.org/odi/volunteering/shapes#ApplicationShape');
    expect(s.getObjects(shape, namedNode(SH + 'targetClass'), null).map((o) => o.value)).toEqual([VOL + 'Application']);
    const props = s.getObjects(shape, namedNode(SH + 'property'), null);
    const byPath = new Map(props.map((p) => [s.getObjects(p, namedNode(SH + 'path'), null)[0].value, p]));
    const val = (p: string, k: string) => s.getObjects(byPath.get(p)!, namedNode(SH + k), null).map((o) => o.value);
    expect(val(VOL + 'submittedBy', 'class')).toEqual([VOL + 'Person']);
    expect(val(VOL + 'submittedBy', 'minCount')).toEqual(['1']);
    expect(val(VOL + 'submittedBy', 'maxCount')).toEqual(['1']);
    // xsd:dateTime, and xsd:dateTimeStamp derived from it (#27).
    expect(val(VOL + 'submittedAt', 'datatype')).toEqual([]);
    expect(val(VOL + 'submittedAt', 'or')).toHaveLength(1);
    expect(val(VOL + 'submittedAt', 'maxCount')).toEqual(['1']); // functional
    expect(ttl).toContain('a sh:NodeShape');
    expect(ttl).toContain('### Shapes');
    // union domain: hasLocation applies to sessions
    expect(ttl).toMatch(/volsh:SessionShape[\s\S]*?sh:path vol:hasLocation/);
  });

  it('uses qualified value shapes when the filler differs from the range', async () => {
    const g = applyChangeOps(baseOntology(), [
      { op: 'addClass', localName: 'Charity', label: 'charity', definition: 'An organisation with charitable purposes.', subClassOf: [X('Organisation')] },
      { op: 'addRestriction', classIri: X('Employee'), restriction: { property: X('worksFor'), kind: 'some', filler: X('Charity') } },
    ]).graph;
    const ttl = await toShacl(g);
    expect(ttl).toMatch(/sh:qualifiedMinCount 1/);
    expect(ttl).toMatch(/sh:qualifiedValueShape \[ sh:class ex:Charity \]/);
  });
});
