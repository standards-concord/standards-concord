import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { OntologyGraph } from '@concord/core';
import { createApp } from '../src/app.js';
import { openDb, put } from '../src/db.js';
import { findProject, getProject } from '../src/services/ontologies.js';
import { ontologyStore } from '../src/services/ontologyStore.js';
import { seedDemo } from '../src/services/simulation.js';
import { checkFederationNow, findFederation } from '../src/services/federations.js';

const app = createApp();
const VOL = 'https://w3id.org/odi/volunteering#';
type Agent = ReturnType<typeof request.agent>;

let volId: string;
beforeAll(async () => {
  await openDb();
  await seedDemo();
  volId = (await findProject('volunteering'))!.id;
});

async function login(name: string, role = 'contributor'): Promise<Agent> {
  const agent = request.agent(app);
  expect((await agent.post('/api/auth/demo').send({ name, role })).status).toBe(200);
  return agent;
}

let n = 0;
/** A new ontology whose draft uses (without importing) the volunteering ontology's Person and Organisation. */
async function coUser(agent: Agent, extra = '') {
  const created = await agent.post('/api/ontologies').send({ title: `Co-user ${++n} ${Date.now()}`, description: 'Agents that work with volunteering organisations.', prefix: `cu${n}` });
  expect(created.status).toBe(201);
  const project = await getProject(created.body.id);
  const g = await ontologyStore.working(project);
  const ttl = `${await g.toTurtle()}\n<${VOL}Person> a <http://www.w3.org/2002/07/owl#Class> .\n<${VOL}Organisation> a <http://www.w3.org/2002/07/owl#Class> .\n${extra}`;
  await ontologyStore.commitWorking(project, await OntologyGraph.fromTurtle(ttl), 'Use volunteering terms', { name: 'Test' });
  return project;
}

const hybrid = () => ({
  title: 'Something both a person and an organisation',
  kind: 'feature',
  ops: [{ op: 'addClass', localName: 'Hybrid', label: 'hybrid', definition: 'Something said to be both a person and an organisation.', subClassOf: [`${VOL}Person`, `${VOL}Organisation`] }],
});

describe('federations', () => {
  it('checks members alone and together, and only owners change one', async () => {
    const owner = await login('Federation owner');
    const o = await coUser(owner);
    const created = await owner.post('/api/federations').send({ title: 'Volunteering and friends', members: [{ ontologyId: volId, version: '1.0.0' }, { ontologyId: o.id, version: 'draft' }] });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ slug: 'volunteering-and-friends', canEdit: true, members: [{ ontologyId: volId, version: '1.0.0' }, { ontologyId: o.id, version: 'draft' }] });

    const check = await owner.get(`/api/federations/${created.body.slug}/check`);
    expect(check.status).toBe(200);
    expect(check.body).toMatchObject({ passed: true, joint: { consistent: true, checked: 'complete', unsatisfiable: [] } });
    expect(check.body.members.map((m: { ontologyId: string; passed: boolean }) => [m.ontologyId, m.passed])).toEqual([[volId, true], [o.id, true]]);

    const other = await login('Someone else');
    expect((await other.patch(`/api/federations/${created.body.id}`).send({ title: 'Mine now' })).status).toBe(403);
    expect((await other.get(`/api/federations/${created.body.id}`)).body.canEdit).toBe(false);
    expect((await owner.patch(`/api/federations/${created.body.id}`).send({ members: [{ ontologyId: volId, version: '9.9.9' }] })).status).toBe(400);
    expect((await request(app).get('/api/federations')).status).toBe(401);
  });

  // A change can be fine in its own ontology and still break a federation its ontology is in.
  it('says what a change does to the federations following its draft, and fails it only for a committed one', async () => {
    const owner = await login('Committed owner');
    const o = await coUser(owner);
    const fed = (await owner.post('/api/federations').send({ title: `Agents together ${Date.now()}`, members: [{ ontologyId: volId, version: '1.0.0' }, { ontologyId: o.id, version: 'draft' }] })).body;

    const advisory = await owner.post(`/api/ontologies/${o.id}/change-requests`).send(hybrid());
    expect(advisory.status).toBe(201);
    expect(advisory.body.validation.federations).toEqual([
      { federationId: fed.id, slug: fed.slug, title: fed.title, committed: false, passedBefore: true, passedAfter: false, newlyUnsatisfiable: [`${o.namespace}Hybrid`], becomesInconsistent: false },
    ]);
    // Advisory: the ontology hasn't committed to the federation, so its own checks decide.
    expect(advisory.body.validation.passed).toBe(true);

    // A contributor can't commit the ontology; its owner can.
    const contributor = await login('Contributor');
    expect((await contributor.post(`/api/ontologies/${o.id}/federations/${fed.id}/commitment`).send({ committed: true })).status).toBe(403);
    const committed = await owner.post(`/api/ontologies/${o.id}/federations/${fed.id}/commitment`).send({ committed: true });
    expect(committed.status).toBe(200);
    expect(committed.body.memberInfo.find((m: { ontologyId: string }) => m.ontologyId === o.id)).toMatchObject({ committed: true, canCommit: true });

    const blocked = await owner.post(`/api/ontologies/${o.id}/change-requests`).send(hybrid());
    expect(blocked.body.validation.federations[0]).toMatchObject({ committed: true, passedAfter: false });
    expect(blocked.body.validation.passed).toBe(false);
  });

  it('leaves federations that pin a release alone', async () => {
    const owner = await login('Pinning owner');
    const o = await coUser(owner);
    await owner.post('/api/federations').send({ title: `Pinned ${Date.now()}`, members: [{ ontologyId: o.id, version: 'draft' }] });
    // The volunteering ontology is pinned at 1.0.0 in every federation above, so its changes affect none of them.
    const cr = await (await login('Vol editor', 'editor')).post(`/api/ontologies/${volId}/change-requests`).send({
      title: 'Clarify a label',
      kind: 'editorial',
      ops: [{ op: 'addClass', localName: `Thing${Date.now()}`, label: 'new thing', definition: 'A thing added to test federations that pin a release.' }],
    });
    expect(cr.status).toBe(201);
    expect(cr.body.validation.federations).toBeUndefined();
  });

  it('extends a parent federation and says, term by term, how far the two agree', async () => {
    const owner = await login('Sub-federation owner');
    const ns = `https://example.org/fin${Date.now()}#`;
    // The child refines the parent's Organisation (it can never be a Robot) and adds a term of its own.
    const o = await coUser(owner, `<${ns}Robot> a <http://www.w3.org/2002/07/owl#Class> .\n<${VOL}Organisation> <http://www.w3.org/2002/07/owl#disjointWith> <${ns}Robot> .\n`);
    const parent = (await owner.post('/api/federations').send({ title: `Parent ${Date.now()}`, members: [{ ontologyId: volId, version: '1.0.0' }] })).body;
    const child = (await owner.post('/api/federations').send({ title: `Child ${Date.now()}`, parentId: parent.id, members: [{ ontologyId: volId, version: '1.0.0' }, { ontologyId: o.id, version: 'draft' }] })).body;
    expect(child.parent).toEqual({ id: parent.id, slug: parent.slug, title: parent.title });
    expect((await owner.get(`/api/federations/${parent.slug}`)).body.children).toEqual([{ id: child.id, slug: child.slug, title: child.title }]);
    // No loops.
    expect((await owner.patch(`/api/federations/${parent.slug}`).send({ parentId: child.id })).status).toBe(400);

    const cmp = await owner.get(`/api/federations/${child.slug}/compare/${parent.slug}`);
    expect(cmp.status).toBe(200);
    const rel = (iri: string) => cmp.body.terms.find((t: { iri: string }) => t.iri === iri)?.relation;
    expect(rel(`${VOL}Person`)).toBe('same');
    expect(rel(`${VOL}Organisation`)).toBe('tightened');
    expect(rel(`${ns}Robot`)).toBe('only-b');
    expect(cmp.body.terms.find((t: { iri: string }) => t.iri === `${VOL}Organisation`).onlyInB).toEqual(['disjointWith Robot']);
    // Every one of the parent's terms is kept or refined, so they agree on all shared terms.
    expect(cmp.body.agreeing).toBe(cmp.body.shared);
    expect(cmp.body.counts['only-a']).toBe(0);
  });

  // Review r1: the list of federations following a draft was cut to five (sorted by title) before
  // commitments were read, so advisory federations could push a committed one out and its breakage
  // never failed the change.
  it('checks every federation an ontology is committed to, however many others follow its draft', async () => {
    const owner = await login('Many federations owner');
    const o = await coUser(owner);
    for (let i = 0; i < 6; i++) await owner.post('/api/federations').send({ title: `A advisory ${i} ${Date.now()}`, members: [{ ontologyId: volId, version: '1.0.0' }, { ontologyId: o.id, version: 'draft' }] });
    const fed = (await owner.post('/api/federations').send({ title: `Z committed ${Date.now()}`, members: [{ ontologyId: volId, version: '1.0.0' }, { ontologyId: o.id, version: 'draft' }] })).body;
    expect((await owner.post(`/api/ontologies/${o.id}/federations/${fed.id}/commitment`).send({ committed: true })).status).toBe(200);
    const cr = await owner.post(`/api/ontologies/${o.id}/change-requests`).send(hybrid());
    const impacts = cr.body.validation.federations as { federationId: string; committed: boolean }[];
    expect(impacts.find((i) => i.federationId === fed.id)).toMatchObject({ committed: true, passedAfter: false });
    expect(impacts.filter((i) => !i.committed)).toHaveLength(5);
    expect(cr.body.validation.passed).toBe(false);
  });

  // Review r1: an import Concord can't load was left out of the check, which could still pass, so a
  // committed federation vouched for a union it never saw in full.
  it('fails a change for a committed federation it could check only in part', async () => {
    const owner = await login('Unresolved import owner');
    const o = await coUser(owner);
    const project = await getProject(o.id);
    const g = await ontologyStore.working(project);
    const ttl = `${await g.toTurtle()}\n<${project.ontologyIRI}> <http://www.w3.org/2002/07/owl#imports> <https://elsewhere.example/vocab> .`;
    await ontologyStore.commitWorking(project, await OntologyGraph.fromTurtle(ttl), 'Import something hosted elsewhere', { name: 'Test' });
    const fed = (await owner.post('/api/federations').send({ title: `Partly checked ${Date.now()}`, members: [{ ontologyId: volId, version: '1.0.0' }, { ontologyId: o.id, version: 'draft' }] })).body;
    expect((await owner.post(`/api/ontologies/${o.id}/federations/${fed.id}/commitment`).send({ committed: true })).status).toBe(200);
    const cr = await owner.post(`/api/ontologies/${o.id}/change-requests`).send({
      title: 'A harmless class',
      kind: 'feature',
      ops: [{ op: 'addClass', localName: 'Harmless', label: 'harmless', definition: 'A class that breaks nothing, for testing partial checks.' }],
    });
    expect(cr.status).toBe(201);
    expect(cr.body.validation.federations[0]).toMatchObject({ committed: true, error: expect.stringContaining('https://elsewhere.example/vocab') });
    expect(cr.body.validation.passed).toBe(false);
  });

  // Review r1: members were read without the public hold check (imports always had it), so a version
  // waiting for a steward's approval could reach checks, comparisons and upstream proposals.
  it('never reads a version that is waiting for approval', async () => {
    const owner = await login('Held member owner');
    const o = await coUser(owner);
    const fed = (await owner.post('/api/federations').send({ title: `Held ${Date.now()}`, members: [{ ontologyId: o.id, version: 'draft' }] })).body;
    await put('kv', { id: `public-hold:${o.id}`, ontologyId: o.id, versions: ['draft'], since: '2026-11-07T00:00:00Z' });
    const check = await owner.get(`/api/federations/${fed.slug}/check`);
    expect(check.status).toBe(409);
    expect(check.body.error).toMatch(/being reviewed/);
    const add = await owner.post('/api/federations').send({ title: `Held again ${Date.now()}`, members: [{ ontologyId: o.id, version: 'draft' }] });
    expect(add.status).toBe(400);
  });

  // Review r2: a proposal was swapped in for its draft only after another member's imports were
  // resolved, so what the proposal newly imports was missing from that member's own check.
  it('follows what a proposed change imports wherever another member imports its draft', async () => {
    const owner = await login('Nested proposal owner');
    const b = await coUser(owner);
    const a = await coUser(owner);
    const pa = await getProject(a.id);
    await ontologyStore.commitWorking(pa, await OntologyGraph.fromTurtle(`${await (await ontologyStore.working(pa)).toTurtle()}\n<${pa.ontologyIRI}> <http://www.w3.org/2002/07/owl#imports> <${b.ontologyIRI}> .`), 'Import B', { name: 'Test' });
    const fed = (await owner.post('/api/federations').send({ title: `Nested ${Date.now()}`, members: [{ ontologyId: a.id, version: 'draft' }, { ontologyId: b.id, version: 'draft' }] })).body;
    const pb = await getProject(b.id);
    const proposal = await OntologyGraph.fromTurtle(`${await (await ontologyStore.working(pb)).toTurtle()}\n<${pb.ontologyIRI}> <http://www.w3.org/2002/07/owl#imports> <https://w3id.org/odi/volunteering> .`);
    const check = await checkFederationNow(await findFederation(fed.id), { ontologyId: b.id, graph: proposal });
    expect(check.members.find((m) => m.ontologyId === a.id)?.imports).toBe(2);
  });
});
