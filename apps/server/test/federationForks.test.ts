import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { OntologyGraph } from '@concord/core';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { findProject, getProject } from '../src/services/ontologies.js';
import { ontologyStore } from '../src/services/ontologyStore.js';
import { seedDemo } from '../src/services/simulation.js';

const app = createApp();
const VOL = 'https://w3id.org/odi/volunteering#';
type Agent = ReturnType<typeof request.agent>;
let volId: string;
beforeAll(async () => {
  await openDb();
  await seedDemo();
  volId = (await findProject('volunteering'))!.id;
});

async function login(name: string): Promise<Agent> {
  const agent = request.agent(app);
  expect((await agent.post('/api/auth/demo').send({ name, role: 'contributor' })).status).toBe(200);
  return agent;
}

describe('federation forks', () => {
  it('forks a federation, proposes its choices back, and the original’s owners accept or decline', async () => {
    const owner = await login('Original owner');
    const forker = await login('Forker');
    const mine = (await forker.post('/api/ontologies').send({ title: `Fork member ${Date.now()}`, description: 'Added by a fork.', prefix: 'fkm' })).body;
    const original = (await owner.post('/api/federations').send({ title: `Original ${Date.now()}`, members: [{ ontologyId: volId, version: '1.0.0' }] })).body;

    const fork = await forker.post(`/api/federations/${original.slug}/forks`).send({ kind: 'development' });
    expect(fork.status).toBe(201);
    expect(fork.body).toMatchObject({ title: `${original.title} (fork)`, canEdit: true, forkedFrom: { id: original.id, kind: 'development' }, members: original.members });
    // Nothing changed yet, so there is nothing to propose.
    expect((await forker.post(`/api/federations/${fork.body.slug}/propose-back`).send({})).status).toBe(400);

    await forker.patch(`/api/federations/${fork.body.slug}`).send({ members: [...original.members, { ontologyId: mine.id, version: 'draft' }] });
    expect((await owner.post(`/api/federations/${fork.body.slug}/propose-back`).send({})).status).toBe(403);
    const proposed = await forker.post(`/api/federations/${fork.body.slug}/propose-back`).send({ note: 'Adds our ontology' });
    expect(proposed.status).toBe(200);
    expect(proposed.body.proposalInfo).toEqual([expect.objectContaining({ status: 'open', note: 'Adds our ontology', changes: [`adds ${mine.title} (its working draft)`], from: { slug: fork.body.slug, title: fork.body.title } })]);
    const id = proposed.body.proposalInfo[0].id;

    // Only the original's owners decide.
    expect((await forker.post(`/api/federations/${original.slug}/proposals/${id}`).send({ accept: true })).status).toBe(403);
    const accepted = await owner.post(`/api/federations/${original.slug}/proposals/${id}`).send({ accept: true });
    expect(accepted.body.members).toEqual([{ ontologyId: volId, version: '1.0.0' }, { ontologyId: mine.id, version: 'draft' }]);
    expect(accepted.body.proposalInfo[0].status).toBe('accepted');
    expect(accepted.body.forks).toEqual([{ id: fork.body.id, slug: fork.body.slug, title: fork.body.title, kind: 'development' }]);
    expect((await owner.post(`/api/federations/${original.slug}/proposals/${id}`).send({ accept: false })).status).toBe(409);

    // A divergent fork goes its own way.
    const divergent = (await forker.post(`/api/federations/${original.slug}/forks`).send({ kind: 'divergent', title: `Our own way ${Date.now()}` })).body;
    await forker.patch(`/api/federations/${divergent.slug}`).send({ members: [{ ontologyId: volId, version: '1.0.0' }] });
    expect((await forker.post(`/api/federations/${divergent.slug}/propose-back`).send({})).status).toBe(400);
  });

  // The UK financial services / UK government example: a sub-federation hands settled terms upstream.
  it('hands terms of a sub-federation upstream to an ontology of its parent, as a change request', async () => {
    const owner = await login('Sub-federation owner');
    const fs = (await owner.post('/api/ontologies').send({ title: `Finance ${Date.now()}`, description: 'Financial services terms.', prefix: 'fin' })).body;
    const project = await getProject(fs.id);
    const ttl = `${await (await ontologyStore.working(project)).toTurtle()}
<${VOL}Organisation> a <http://www.w3.org/2002/07/owl#Class> .
<${fs.namespace}Lender> a <http://www.w3.org/2002/07/owl#Class> ; <http://www.w3.org/2000/01/rdf-schema#label> "lender"@en ;
  <http://www.w3.org/2004/02/skos/core#definition> "An organisation that lends money to volunteers' causes."@en ; <http://www.w3.org/2000/01/rdf-schema#subClassOf> <${VOL}Organisation> .
`;
    await ontologyStore.commitWorking(project, await OntologyGraph.fromTurtle(ttl), 'Add Lender', { name: 'Test' });
    const parent = (await owner.post('/api/federations').send({ title: `Government ${Date.now()}`, members: [{ ontologyId: volId, version: '1.0.0' }] })).body;
    const child = (await owner.post('/api/federations').send({ title: `Financial services ${Date.now()}`, parentId: parent.id, members: [{ ontologyId: volId, version: '1.0.0' }, { ontologyId: fs.id, version: 'draft' }] })).body;

    // Only to an ontology of the parent, and only by the federation's owners.
    expect((await owner.post(`/api/federations/${child.slug}/upstream`).send({ ontologyId: fs.id, terms: [`${fs.namespace}Lender`] })).status).toBe(400);
    expect((await (await login('Someone else')).post(`/api/federations/${child.slug}/upstream`).send({ ontologyId: volId, terms: [`${fs.namespace}Lender`] })).status).toBe(403);

    const up = await owner.post(`/api/federations/${child.slug}/upstream`).send({ ontologyId: volId, terms: [`${fs.namespace}Lender`] });
    expect(up.status).toBe(201);
    expect(up.body.mapping).toEqual({ [`${fs.namespace}Lender`]: `${VOL}Lender` });
    const cr = up.body.changeRequest;
    expect(cr).toMatchObject({ ontologyId: volId, title: `Adopt a term from ${child.title}`, origin: { type: 'federation', federationId: child.id } });
    expect(cr.ops).toEqual([expect.objectContaining({ op: 'addClass', localName: 'Lender', subClassOf: [`${VOL}Organisation`], mappings: { 'http://www.w3.org/2004/02/skos/core#exactMatch': [`${fs.namespace}Lender`] } })]);
    expect(cr.description).toMatch(/Handed upstream from the federation/);
    expect(cr.validation.passed).toBe(true);
    const detail = (await owner.get(`/api/federations/${child.slug}`)).body;
    expect(detail.upstreamInfo).toEqual([expect.objectContaining({ changeRequestId: cr.id, ontologyId: volId, number: cr.number, status: cr.status })]);
  });

  // Trying a change in a federation before proposing it: a member can be one of the ontology's development forks.
  it("checks an ontology's development fork as a member, and won't release it", async () => {
    const owner = await login('Fork member owner');
    const fs = (await owner.post('/api/ontologies').send({ title: `Fork finance ${Date.now()}`, description: 'Financial services terms.', prefix: 'ffin' })).body;
    const fork = await owner.post(`/api/ontologies/${fs.id}/forks`).send({ name: 'lenders' });
    expect(fork.status).toBe(201);
    const edit = await owner.post(`/api/ontologies/${fs.id}/forks/${fork.body.slug}/edits`).send({
      ops: [{ op: 'addClass', localName: 'Lender', label: 'lender', definition: 'An organisation that lends money to good causes.' }],
    });
    expect(edit.status).toBe(200);
    expect((await owner.post('/api/federations').send({ title: 'No such fork', members: [{ ontologyId: fs.id, version: 'fork:nope' }] })).status).toBe(400);
    const fed = await owner.post('/api/federations').send({ title: `With a fork ${Date.now()}`, members: [{ ontologyId: volId, version: '1.0.0' }, { ontologyId: fs.id, version: `fork:${fork.body.slug}` }] });
    expect(fed.status).toBe(201);
    expect(fed.body.memberInfo[1]).toMatchObject({ version: `fork:${fork.body.slug}`, forks: [{ slug: fork.body.slug, title: 'lenders' }] });
    const check = (await owner.get(`/api/federations/${fed.body.slug}/check`)).body;
    expect(check.passed).toBe(true);
    const cmp = (await owner.get(`/api/federations/${fed.body.slug}/compare/${fed.body.slug}`)).body;
    expect(cmp.terms.map((t: { iri: string }) => t.iri)).toContain(`${fs.namespace}Lender`);
    const plan = (await owner.get(`/api/federations/${fed.body.slug}/release-plan`)).body;
    expect(plan.ready).toBe(false);
    expect(plan.blockers).toContain(`${fs.title} is a development fork: pick one of its releases to pin.`);
  });
});
