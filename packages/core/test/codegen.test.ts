import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { DataFactory, Parser, Store } from 'n3';
import * as wrapper from '@rdfjs/wrapper';
import { NS, OntologyGraph, applyChangeOps, npmPackage, toShacl, toShaclc, toWrapperClasses, withWrapperImport, WRAPPER_CDN } from '../src/index.js';
import { canonical } from '../src/rdf.js';
import { parseShaclc } from '../src/shacl.js';
import { RESERVED_CLASSES } from '../src/codemodel.js';
import { X, baseOntology, loadFixture } from './helpers.js';

const VOL = 'https://w3id.org/odi/volunteering#';
const here = path.dirname(new URL(import.meta.url).pathname);
/** Generated code is written inside the package so it resolves @rdfjs/wrapper and n3 from node_modules. */
const GEN = path.join(here, '..', '.gen', 'test');

/** Blank-node-insensitive set of triples, for comparing graphs. */
function triples(store: Store, drop: string[] = []): string[] {
  for (const p of drop) for (const q of store.getQuads(null, DataFactory.namedNode(p), null, null)) store.removeQuad(q);
  return store
    .getQuads(null, null, null, null)
    .filter((q) => q.subject.termType !== 'BlankNode')
    .map((q) => `${canonical(store, q.subject as any)} <${q.predicate.value}> ${canonical(store, q.object as any)}`)
    .sort();
}
const turtleShapes = async (g: OntologyGraph) => new Store(new Parser().parse(await toShacl(g)));
/** Turtle shapes with blank qualified value shapes named the way SHACLC names them, for comparison. */
const SH = NS.sh;
const STANDARD_DROPPED = [SH + 'codeIdentifier', SH + 'name', NS.rdfs + 'label', NS.dcterms + 'source'];

/** Edge cases from review: unsafe local names, quoted datatype names, colliding names, odd hierarchies. */
const EDGE = `
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix vann: <http://purl.org/vocab/vann/> .
@prefix dcterms: <http://purl.org/dc/terms/> .
@prefix e: <https://example.org/e#> .
@prefix o: <https://example.org/o#> .
<https://example.org/e> a owl:Ontology ; dcterms:title "*/ globalThis.__reviewMarker = 42; /*" ;
  vann:preferredNamespacePrefix "e" ; vann:preferredNamespaceUri "https://example.org/e#" ; owl:versionInfo "1.0.0" .
e:A a owl:Class ; rdfs:label "a */ globalThis.__labelMarker = 1; /*" ;
  rdfs:subClassOf [ a owl:Restriction ; owl:onProperty e:note ; owl:hasValue "use xsd:anyURI here" ] ,
                  [ a owl:Restriction ; owl:onProperty e:p ; owl:someValuesFrom e:BShape ] .
e:A-p-B a owl:Class .
e:BShape a owl:Class .
e:C a owl:Class .
<https://example.org/e#star*> a owl:DatatypeProperty ; rdfs:domain e:A ; rdfs:range xsd:string .
e:link a owl:DatatypeProperty ; rdfs:domain e:A ; rdfs:range xsd:anyURI .
e:note a owl:DatatypeProperty ; rdfs:range xsd:string .
e:p a owl:ObjectProperty ; rdfs:range e:C .
e:LiteralAs a owl:Class .
e:label a owl:DatatypeProperty ; rdfs:domain e:LiteralAs ; rdfs:range xsd:string .
e:Parent a owl:Class .
e:Child a owl:Class ; rdfs:subClassOf e:Parent .
e:name a owl:DatatypeProperty ; rdfs:domain e:Parent ; rdfs:range xsd:string .
o:name a owl:DatatypeProperty ; rdfs:domain e:Child ; rdfs:range xsd:integer .
e:tag a owl:DatatypeProperty ; rdfs:domain e:Parent ; rdfs:range xsd:string .
e:Narrow a owl:Class ; rdfs:subClassOf e:Parent , [ a owl:Restriction ; owl:onProperty e:tag ; owl:cardinality "1"^^xsd:nonNegativeInteger ] .
e:Left a owl:Class . e:Right a owl:Class .
e:Both a owl:Class ; rdfs:subClassOf e:Left , e:Right .
e:left a owl:DatatypeProperty ; rdfs:domain e:Left ; rdfs:range xsd:string .
e:right a owl:DatatypeProperty ; rdfs:domain e:Right ; rdfs:range xsd:string .
e:X a owl:Class ; rdfs:subClassOf e:Y .
e:Y a owl:Class ; rdfs:subClassOf e:X .
e:y a owl:DatatypeProperty ; rdfs:domain e:Y ; rdfs:range xsd:string .
<http://www.w3.org/1999/02/22-rdf-syntax-ns#p*> a owl:DatatypeProperty ; rdfs:domain e:C ; rdfs:range xsd:string .
e:C rdfs:subClassOf [ a owl:Restriction ; owl:onProperty e:note ; owl:hasValue "line\\nnext \\"quoted\\"\\ttab \\\\ back" ] .
<https://outside.example/O'Reilly> a owl:DatatypeProperty ; rdfs:domain e:C ; rdfs:range xsd:anyURI .
e:Animal a owl:Class . e:Dog a owl:Class ; rdfs:subClassOf e:Animal .
e:pet a owl:ObjectProperty ; rdfs:range e:Animal .
e:Owner a owl:Class ; rdfs:subClassOf [ a owl:Restriction ; owl:onProperty e:pet ; owl:allValuesFrom e:Dog ] .
e:OneDogOwner a owl:Class ; rdfs:subClassOf e:Owner , [ a owl:Restriction ; owl:onProperty e:pet ; owl:cardinality "1"^^xsd:nonNegativeInteger ] .
e:SA a owl:Class . e:SB a owl:Class ; rdfs:subClassOf [ a owl:Restriction ; owl:onProperty e:sp ; owl:cardinality "1"^^xsd:nonNegativeInteger ] .
e:SC a owl:Class ; rdfs:subClassOf e:SA , e:SB .
e:sp a owl:DatatypeProperty ; rdfs:domain e:SA ; rdfs:range xsd:string .
`;
const edge = () => OntologyGraph.fromTurtle(EDGE);

describe('SHACL compact syntax', () => {
  it('writes the same shapes in standard SHACLC', async () => {
    const text = await toShaclc(await loadFixture());
    expect(text).toMatch(/^# SHACL shapes for Volunteering Ontology, in SHACL compact syntax\.\n/);
    expect(text).toContain('BASE <https://w3id.org/odi/volunteering/shapes>');
    expect(text).toContain('PREFIX vol: <https://w3id.org/odi/volunteering#>');
    expect(text).toMatch(/shape volsh:ApplicationShape -> vol:Application \{[\s\S]*?vol:submittedBy vol:Person \[1\.\.1\] \./);
    expect(text).toContain('vol:submittedAt xsd:dateTime [0..1] .');
    // Datatypes outside the short-form list are written explicitly, so they don't read back as classes.
    expect(text).toContain('vol:joiningUrl datatype=xsd:anyURI .');
    expect(text).not.toContain('codeIdentifier');
    expect(text).not.toContain('sh:name');
  });

  it('parses with a strict SHACLC parser to exactly the Turtle shapes, less what SHACLC has no place for', async () => {
    const g = await loadFixture();
    const { parse } = await import('shaclc-parse');
    const fromC = new Store(parse(await toShaclc(g)) as any); // no extended syntax
    expect(triples(fromC)).toEqual(triples(await turtleShapes(g), STANDARD_DROPPED));
  });

  it('keeps shape names and the label in the extended dialect', async () => {
    const g = await loadFixture();
    const text = await toShaclc(g, { extended: true });
    expect(text).toContain('sh:name "application"@en');
    const { parse } = await import('shaclc-parse');
    const fromC = new Store(parse(text, { extendedSyntax: true }) as any);
    expect(triples(fromC)).toEqual(triples(await turtleShapes(g), [SH + 'codeIdentifier']));
  });

  it('names qualified value shapes so SHACLC can refer to them', async () => {
    const g = applyChangeOps(baseOntology(), [
      { op: 'addClass', localName: 'Charity', label: 'charity', definition: 'An organisation with charitable purposes.', subClassOf: [X('Organisation')] },
      { op: 'addRestriction', classIri: X('Employee'), restriction: { property: X('worksFor'), kind: 'some', filler: X('Charity') } },
    ]).graph;
    const text = await toShaclc(g);
    expect(text).toContain('ex:worksFor qualifiedValueShape=exsh:Employee-worksFor-Charity qualifiedMinCount=1 .');
    expect(text).toMatch(/shape exsh:Employee-worksFor-Charity \{\s+class=ex:Charity \.\s+\}/);
  });

  it('keeps meaning with unsafe local names, datatype names inside strings and colliding shape names', async () => {
    const g = await edge();
    for (const extended of [false, true]) {
      const text = await toShaclc(g, { extended }); // throws if the output would parse to different shapes
      // e:star* and rdf:p* would read as paths, so those IRIs are written in full, even under a built-in prefix.
      expect(text).toContain('<https://example.org/e#star*>');
      expect(text).toContain('<http://www.w3.org/1999/02/22-rdf-syntax-ns#p*>');
      expect(text).not.toMatch(/e:star\*|rdf:p\*/);
      // Other IRIs in the namespace still use the prefix.
      expect(text).toContain('e:link datatype=xsd:anyURI .');
      expect(text).toContain('hasValue="use xsd:anyURI here"');
      // An apostrophe inside an IRI isn't the start of a string.
      expect(text).toContain("<https://outside.example/O'Reilly> datatype=xsd:anyURI");
      // The qualified shape for A / p / BShape doesn't take the name of the shape for class A-p-B.
      expect(text).toContain('qualifiedValueShape=esh:A-p-BShape2');
      expect(text).toMatch(/shape esh:A-p-BShape -> e:A-p-B \{\s*\}/);
    }
    // Literals with escapes (newline, quotes, tab, backslash) round-trip.
    const fromC = new Store((await parseShaclc(await toShaclc(g), false)) as any);
    const paths = fromC.getObjects(null, DataFactory.namedNode(SH + 'path'), null);
    expect(paths.filter((t) => t.termType === 'NamedNode').map((t) => t.value)).toEqual(expect.arrayContaining([
      'http://www.w3.org/1999/02/22-rdf-syntax-ns#p*', 'https://example.org/e#star*', "https://outside.example/O'Reilly",
    ]));
    expect(fromC.getObjects(null, DataFactory.namedNode(SH + 'hasValue'), null).map((o) => o.value)).toContain('line\nnext "quoted"\ttab \\ back');
  });

  it('adds sh:codeIdentifier to the Turtle shapes', async () => {
    const ttl = await toShacl(await loadFixture());
    expect(ttl).toMatch(/volsh:VolunteeringOpportunityShape a sh:NodeShape ;[\s\S]*?sh:codeIdentifier "VolunteeringOpportunity"/);
    expect(ttl).toMatch(/sh:codeIdentifier "minimumAge" ;\s+sh:datatype xsd:nonNegativeInteger/);
  });
});

describe('Generated JavaScript classes', () => {
  it('makes one class per node shape, with inheritance and a dataset wrapper', async () => {
    const mod = await toWrapperClasses(await loadFixture(), { name: 'volunteering' });
    const names = mod.classes.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(['Volunteer', 'Person', 'VolunteeringOpportunity', 'Role', 'Session']));
    expect(mod.datasetClass).toBe('VolunteeringDataset');
    expect(mod.classes.find((c) => c.name === 'Volunteer')!.extends).toBe('Person');
    // Parents come first in the module, so `extends` works at load time.
    expect(mod.js.indexOf('class Person extends')).toBeLessThan(mod.js.indexOf('class Volunteer extends Person'));
    expect(mod.js).toContain('from "@rdfjs/wrapper"');
    expect(mod.ts).toContain('export class VolunteeringDataset extends DatasetWrapper');
    expect(mod.ts).toContain('get minimumAge(): number | undefined');
    expect(mod.dts).toContain('export declare class VolunteeringOpportunity extends TermWrapper');
    expect(mod.dts).not.toMatch(/return /);
    expect(mod.ontology).toMatchObject({ iri: 'https://w3id.org/odi/volunteering', namespace: VOL });
    expect(withWrapperImport(mod.js)).toContain(`from "${WRAPPER_CDN}"`);
  });

  it('reads and writes RDF with exact datatypes', async () => {
    const mod = await toWrapperClasses(await loadFixture(), { name: 'volunteering' });
    mkdirSync(GEN, { recursive: true });
    const file = path.join(GEN, `vol-${process.pid}.mjs`);
    writeFileSync(file, mod.js);
    try {
      const { VolunteeringDataset, Session, Volunteer, Person } = await import(file);
      const store = new Store(new Parser().parse(readFileSync(path.join(here, '..', 'fixtures', 'volunteering-example-data.ttl'), 'utf8')));
      const data = new VolunteeringDataset(store, DataFactory);
      const opps = [...data.volunteeringOpportunity];
      expect(opps.map((o: any) => [...o.title][0]).sort()).toEqual(['Saturday park clean-up', 'Telephone befriending']);
      const park = opps.find((o: any) => o.value.endsWith('parkCleanUp'));
      expect(park.minimumAge).toBe(16);
      expect([...park.hasRole].length).toBe(2);
      const session = new Session('https://example.org/s', store, DataFactory);
      session.placesAvailable = 7;
      session.endDateTime = new Date('2026-01-01T10:00:00Z');
      const obj = (p: string) => store.getObjects(DataFactory.namedNode('https://example.org/s'), DataFactory.namedNode(VOL + p), null)[0] as any;
      expect(obj('placesAvailable').datatype.value).toBe(NS.xsd + 'nonNegativeInteger');
      expect(obj('endDateTime').datatype.value).toBe(NS.xsd + 'dateTime');
      expect(obj('endDateTime').value).toBe('2026-01-01T10:00:00.000Z');
      expect(new Volunteer('https://example.org/v', store, DataFactory)).toBeInstanceOf(Person);
    } finally {
      rmSync(file, { force: true });
    }
  });

  it('type-checks: the TypeScript source and the declarations', async () => {
    const mod = await toWrapperClasses(await loadFixture(), { name: 'volunteering' });
    const dir = path.join(GEN, `tsc-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
      writeFileSync(path.join(dir, 'source.ts'), mod.ts);
      writeFileSync(path.join(dir, 'index.js'), mod.js);
      writeFileSync(path.join(dir, 'index.d.ts'), mod.dts);
      writeFileSync(path.join(dir, 'use.ts'), [
        `import { VolunteeringDataset, Volunteer, Person, ontology } from './index.js';`,
        `import { DataFactory, Store } from 'n3';`,
        `const data = new VolunteeringDataset(new Store(), DataFactory);`,
        `for (const o of data.volunteeringOpportunity) { const titles: Set<string> = o.title; const age: number | undefined = o.minimumAge; void titles; void age; }`,
        `const p: Person = new Volunteer('https://example.org/v', new Store(), DataFactory);`,
        `const v: string = ontology.namespace;`,
        `void p; void v;`,
      ].join('\n'));
      writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, module: 'nodenext', moduleResolution: 'nodenext', target: 'es2022', noEmit: true, types: [] }, files: ['source.ts', 'use.ts'] }));
      execFileSync(path.join(here, '..', 'node_modules', '.bin', 'tsc'), ['-p', dir], { stdio: 'pipe' });
    } catch (err: any) {
      throw new Error(`tsc failed:\n${err.stdout?.toString() ?? ''}${err.stderr?.toString() ?? err.message}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('handles names that clash with wrapper members, external ranges and multiple namespaces', async () => {
    const g = applyChangeOps(baseOntology(), [
      { op: 'addObjectProperty', localName: 'value', label: 'value', definition: 'A value.', domain: [X('Person')], range: ['http://xmlns.com/foaf/0.1/Document'] },
    ]).graph;
    const mod = await toWrapperClasses(g, { name: 'example' });
    expect(mod.ts).toContain('get value_(): Set<Thing>');
    expect(mod.ts).toContain('export class Thing extends TermWrapper');
    expect(mod.datasetClass).toBe('ExampleDataset');
  });

  it('never lets ontology text out of a code comment', async () => {
    const mod = await toWrapperClasses(await edge(), { name: 'edge', sourceUrl: 'https://example.org/*/x' });
    expect(mod.js).not.toContain('*/ globalThis');
    mkdirSync(GEN, { recursive: true });
    const file = path.join(GEN, `edge-inject-${process.pid}.mjs`);
    writeFileSync(file, mod.js);
    try {
      const m = await import(file);
      expect(m.EdgeDataset).toBeTypeOf('function');
      expect((globalThis as any).__reviewMarker).toBeUndefined();
      expect((globalThis as any).__labelMarker).toBeUndefined();
    } finally {
      rmSync(file, { force: true });
    }
  });

  it('keeps class names clear of everything the module imports', () => {
    for (const name of Object.keys(wrapper)) expect(RESERVED_CLASSES.has(name), name).toBe(true);
  });

  it('handles awkward hierarchies: clashing names, narrower subclasses, two superclasses and cycles', async () => {
    const mod = await toWrapperClasses(await edge(), { name: 'edge' });
    const cls = (n: string) => mod.classes.find((c) => c.name === n)!;
    // A class called LiteralAs can't shadow the helper.
    expect(cls('LiteralAs_')).toBeTruthy();
    expect(mod.ts).toMatch(/export class LiteralAs_ extends TermWrapper/);
    // Child inherits e:name as `name`, so o:name gets another name.
    expect(cls('Child').extends).toBe('Parent');
    expect(cls('Child').properties).toEqual(expect.arrayContaining([{ name: 'name', path: 'https://example.org/e#name' }, { name: 'name2', path: 'https://example.org/o#name' }]));
    // Narrow restricts tag to exactly one, which can't override Parent's Set: it stands alone with a single-valued tag.
    expect(cls('Narrow').extends).toBeUndefined();
    expect(mod.ts).toMatch(/export class Narrow extends TermWrapper[\s\S]*?get tag\(\): string \{/);
    // Both keeps the second superclass's property.
    expect(cls('Both').properties.map((p) => p.name).sort()).toEqual(['left', 'right']);
    // A child that only adds a cardinality keeps the inherited value type: Owner's pets are Dogs, so OneDogOwner's one pet is a Dog.
    expect(mod.ts).toMatch(/export class Owner extends TermWrapper[\s\S]*?get pet\(\): Set<Dog>/);
    expect(cls('OneDogOwner').extends).toBeUndefined();
    expect(mod.ts).toMatch(/export class OneDogOwner extends TermWrapper[\s\S]*?get pet\(\): Dog \{/);
    // Constraints on one path from two superclasses both apply: SA allows many sp, SB exactly one, so SC has one.
    expect(cls('SC').extends).toBeUndefined();
    expect(mod.ts).toMatch(/export class SC extends TermWrapper[\s\S]*?get sp\(\): string \{/);
    // The X/Y cycle still gives a loadable order.
    expect(mod.ts.indexOf('export class Y ')).toBeLessThan(mod.ts.indexOf('export class X extends Y'));

    mkdirSync(GEN, { recursive: true });
    const dir = path.join(GEN, `edge-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
      writeFileSync(path.join(dir, 'index.js'), mod.js);
      writeFileSync(path.join(dir, 'index.d.ts'), mod.dts);
      writeFileSync(path.join(dir, 'source.ts'), mod.ts);
      const m = await import(path.join(dir, 'index.js'));
      const store = new Store(new Parser().parse('<https://x/l> <https://example.org/e#label> "hello" . <https://x/c> <https://example.org/e#name> "n" ; <https://example.org/o#name> 3 .'));
      expect([...new m.LiteralAs_('https://x/l', store, DataFactory).label]).toEqual(['hello']);
      const child = new m.Child('https://x/c', store, DataFactory);
      expect([...child.name]).toEqual(['n']);
      expect([...child.name2]).toEqual([3]);
      expect(new m.X('https://x/x', store, DataFactory)).toBeInstanceOf(m.Y);
      const owner = new m.OneDogOwner('https://x/o', store, DataFactory);
      owner.pet = new m.Dog('https://x/rex', store, DataFactory);
      expect(owner.pet).toBeInstanceOf(m.Dog);
      expect(owner.pet.value).toBe('https://x/rex');
      const sc = new m.SC('https://x/sc', store, DataFactory);
      sc.sp = 'one';
      expect(sc.sp).toBe('one');
      writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, module: 'nodenext', moduleResolution: 'nodenext', target: 'es2022', noEmit: true, types: [] }, files: ['source.ts', 'index.d.ts'] }));
      execFileSync(path.join(here, '..', 'node_modules', '.bin', 'tsc'), ['-p', dir], { stdio: 'pipe' });
    } catch (err: any) {
      throw new Error(`${err.message}\n${err.stdout?.toString() ?? ''}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('packages the classes as an npm tarball', async () => {
    const g = await loadFixture();
    const mod = await toWrapperClasses(g, { name: 'volunteering' });
    const tgz = npmPackage(mod, { name: 'volunteering-ontology', version: '1.1.0-fork.activity.2', shapes: await toShacl(g) });
    const tar = gunzipSync(tgz);
    const names: string[] = [];
    for (let off = 0; off + 512 <= tar.length; ) {
      const name = tar.subarray(off, off + 100).toString('utf8').replace(/\0.*$/s, '');
      if (!name) break;
      const size = parseInt(tar.subarray(off + 124, off + 136).toString('ascii'), 8);
      names.push(name);
      if (name === 'package/package.json') {
        const pkg = JSON.parse(tar.subarray(off + 512, off + 512 + size).toString('utf8'));
        expect(pkg).toMatchObject({ name: 'volunteering-ontology', version: '1.1.0-fork.activity.2', type: 'module', dependencies: { '@rdfjs/wrapper': expect.stringMatching(/^\^0\./) } });
      }
      off += 512 + Math.ceil(size / 512) * 512;
    }
    expect(names).toEqual(['package/package.json', 'package/README.md', 'package/index.js', 'package/index.d.ts', 'package/index.ts', 'package/shapes.ttl']);
    // Reproducible bytes for the same input.
    expect(npmPackage(mod, { name: 'volunteering-ontology', version: '1.1.0-fork.activity.2', shapes: await toShacl(g) }).equals(tgz)).toBe(true);
  });
});
