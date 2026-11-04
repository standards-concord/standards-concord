import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { DataFactory, Parser, Store } from 'n3';
import { NS, OntologyGraph, applyChangeOps, npmPackage, toShacl, toShaclc, toWrapperClasses, withWrapperImport, WRAPPER_CDN } from '../src/index.js';
import { X, baseOntology, loadFixture } from './helpers.js';

const VOL = 'https://w3id.org/odi/volunteering#';
const here = path.dirname(new URL(import.meta.url).pathname);
/** Generated code is written inside the package so it resolves @rdfjs/wrapper and n3 from node_modules. */
const GEN = path.join(here, '..', '.gen', 'test');

describe('SHACL compact syntax', () => {
  it('writes the same shapes in SHACLC', async () => {
    const text = await toShaclc(await loadFixture());
    expect(text).toMatch(/^BASE <https:\/\/w3id\.org\/odi\/volunteering\/shapes>/);
    expect(text).toContain('PREFIX vol: <https://w3id.org/odi/volunteering#>');
    expect(text).toMatch(/shape volsh:ApplicationShape -> vol:Application[\s\S]*?\{[\s\S]*?vol:submittedBy vol:Person \[1\.\.1\] \./);
    expect(text).toContain('vol:submittedAt xsd:dateTime [0..1] .');
    // Datatypes outside the short-form list are written explicitly, so they don't read back as classes.
    expect(text).toContain('vol:joiningUrl datatype=xsd:anyURI .');
    expect(text).not.toContain('codeIdentifier');
  });

  it('round-trips to the Turtle shapes (less sh:codeIdentifier)', async () => {
    const g = await loadFixture();
    const { parse } = await import('shaclc-parse');
    const fromC = new Store(parse(await toShaclc(g), { extendedSyntax: true }) as any);
    const fromT = new Store(new Parser().parse(await toShacl(g)));
    for (const q of fromT.getQuads(null, DataFactory.namedNode(NS.sh + "codeIdentifier"), null, null)) fromT.removeQuad(q);
    const shapes = (s: Store) => s.getSubjects(DataFactory.namedNode(NS.rdf + 'type'), DataFactory.namedNode(NS.sh + 'NodeShape'), null).map((x) => x.value).sort();
    expect(shapes(fromC)).toEqual(shapes(fromT));
    // Same triple count: nothing is lost in the compact form.
    expect(fromC.size).toBe(fromT.size);
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
