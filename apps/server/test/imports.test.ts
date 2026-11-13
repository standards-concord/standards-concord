import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { config } from '../src/config.js';
import { matchImport } from '../src/services/importClosure.js';
import { findProject } from '../src/services/ontologies.js';
import { seedDemo } from '../src/services/simulation.js';

const app = createApp();
const VOL = 'https://w3id.org/odi/volunteering';

beforeAll(async () => {
  await openDb();
  await seedDemo();
});

async function owner(name: string) {
  const agent = request.agent(app);
  expect((await agent.post('/api/auth/demo').send({ name, role: 'owner' })).status).toBe(200);
  return agent;
}
let n = 0;
async function newOntology(agent: ReturnType<typeof request.agent>) {
  const created = await agent.post('/api/ontologies').send({ title: `Importer ${++n} ${Date.now()}`, prefix: `imp${n}`, description: 'Imports another ontology.' });
  expect(created.status).toBe(201);
  return created.body as { id: string; slug: string; namespace: string };
}

describe('finding an imported ontology among the hosted ones', () => {
  it('matches the ontology IRI, a version IRI and the public page, and nothing else', async () => {
    const vol = (await findProject('volunteering'))!;
    expect(matchImport(VOL, [vol])).toEqual({ project: vol });
    expect(matchImport(`${VOL}#`, [vol])).toEqual({ project: vol });
    expect(matchImport(`${VOL}/1.0.0`, [vol])).toEqual({ project: vol, version: '1.0.0' });
    expect(matchImport(`${config.publicUrl}/def/volunteering/1.0.0`, [vol])).toEqual({ project: vol, version: '1.0.0' });
    expect(matchImport(`${VOL}-extra`, [vol])).toBeUndefined();
    expect(matchImport('https://example.org/other', [vol])).toBeUndefined();
  });
});

describe('checking a change with the ontologies it imports', () => {
  it('passes an import of a hosted ontology and lists what it loaded', async () => {
    const agent = await owner('Import owner');
    const o = await newOntology(agent);
    const cr = await agent.post(`/api/ontologies/${o.id}/change-requests`).send({
      title: 'Reuse the volunteering ontology',
      kind: 'feature',
      ops: [
        { op: 'addImport', iri: VOL },
        { op: 'addClass', localName: 'Steward', label: 'steward', definition: 'A person who looks after a shared resource on behalf of a community.', subClassOf: [`${VOL}#Person`] },
      ],
    });
    expect(cr.status).toBe(201);
    const imports = cr.body.validation.imports;
    expect(imports).toMatchObject({ passed: true, consistent: true, checked: 'complete', unsatisfiable: [], unresolved: [] });
    expect(imports.imports).toEqual([{ iri: VOL, title: expect.stringMatching(/Volunteering/), version: '1.0.0', via: expect.any(String), ontologyId: (await findProject('volunteering'))!.id }]);
    expect(cr.body.validation.reasoner).toMatchObject({ available: true, consistent: true });
  });

  // Used to go wrong: an ontology with owl:imports was reasoned over alone, so sparq gave no verdict
  // (its imports weren't loaded) and the change could never pass; and a class that the imported
  // ontology makes unsatisfiable was never caught.
  it('fails a class under two classes the imported ontology declares disjoint, and names the import', async () => {
    const agent = await owner('Import owner 2');
    const o = await newOntology(agent);
    const cr = await agent.post(`/api/ontologies/${o.id}/change-requests`).send({
      title: 'Something both a person and an organisation',
      kind: 'feature',
      ops: [
        { op: 'addImport', iri: VOL },
        { op: 'addClass', localName: 'Hybrid', label: 'hybrid', definition: 'Something that is said to be both a person and an organisation.', subClassOf: [`${VOL}#Person`, `${VOL}#Organisation`] },
      ],
    });
    expect(cr.status).toBe(201);
    const hybrid = `${o.namespace}Hybrid`;
    expect(cr.body.validation.passed).toBe(false);
    expect(cr.body.validation.imports.unsatisfiable).toEqual([hybrid]);
    expect(cr.body.validation.imports.blame).toEqual([{ import: VOL, title: expect.stringMatching(/Volunteering/), inconsistent: false, unsatisfiable: [hybrid] }]);
  });

  it('lists an import Concord does not host as not checked', async () => {
    const agent = await owner('Import owner 3');
    const o = await newOntology(agent);
    const cr = await agent.post(`/api/ontologies/${o.id}/change-requests`).send({ title: 'Import something elsewhere', kind: 'feature', ops: [{ op: 'addImport', iri: 'https://elsewhere.example/vocab' }] });
    expect(cr.status).toBe(201);
    expect(cr.body.validation.imports.unresolved).toEqual([{ iri: 'https://elsewhere.example/vocab', via: expect.any(String), reason: 'not-hosted' }]);
  });
});
