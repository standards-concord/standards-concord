import request from 'supertest';
import { beforeAll, expect, it } from 'vitest';
import type { Role } from '@concord/shared';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { seedDemo } from '../src/services/simulation.js';
import { findProject, getProject, setRoles } from '../src/services/ontologies.js';
import { ontologyStore } from '../src/services/ontologyStore.js';

const app = createApp();
beforeAll(async () => { await openDb(); await seedDemo(); });
async function setup() {
  const owner = request.agent(app);
  const login = await owner.post('/api/auth/demo').send({ name: `Details ${Math.random()}`, role: 'steward' });
  const made = await owner.post('/api/ontologies').send({ title: `Details ${Math.random()}`, description: 'Original description', prefix: 'dt', domain: 'Original subject' });
  expect(made.status).toBe(201);
  return { owner, userId: login.body.user.id as string, o: made.body };
}

it.each(['owner', 'steward'] as Role[])('%s can edit listing details without changing the ontology header or its addresses', async (role) => {
  const { owner, userId, o } = await setup();
  const p = await getProject(o.id);
  const before = await (await ontologyStore.working(p)).toTurtle();
  const head = await ontologyStore.head(p);
  await setRoles(o.id, userId, [role]);
  const saved = await owner.patch(`/api/ontologies/${o.id}`).send({ title: '  A clearer title  ', description: '  A clearer description  ', domain: '  Data exchange  ', prefix: 'evil', namespace: 'https://example.org/evil#', slug: 'evil', ontologyIRI: 'https://example.org/evil', ownerIds: [], unknown: true });
  expect(saved.status).toBe(200);
  expect(saved.body).toMatchObject({ id: o.id, title: 'A clearer title', description: 'A clearer description', domain: 'Data exchange', prefix: o.prefix, namespace: o.namespace, slug: o.slug, ontologyIRI: o.ontologyIRI, ownerIds: o.ownerIds, stats: { releases: 0 } });
  expect(await (await ontologyStore.working(await getProject(o.id))).toTurtle()).toBe(before);
  expect(await ontologyStore.head(p)).toBe(head);
  const feed = await owner.get(`/api/activity?ontologyId=${o.id}`);
  expect(feed.status).toBe(200);
  expect(feed.body.some((a: { message: string }) => a.message === 'changed the title to “A clearer title”')).toBe(true);
  expect((await owner.patch(`/api/ontologies/${o.id}`).send({ domain: '' })).body.domain).toBe('');
});

it.each(['editor', 'contributor', 'reviewer', 'member', 'odi', 'agent'] as Role[])('%s cannot edit ontology details', async (role) => {
  const { owner, userId, o } = await setup();
  await setRoles(o.id, userId, [role]);
  expect((await owner.patch(`/api/ontologies/${o.id}`).send({ title: 'Refused' })).status).toBe(403);
  expect((await getProject(o.id)).title).toBe(o.title);
});

it('requires a session and membership, validates trimmed titles and text, and ignores unknown fields', async () => {
  const { owner, o } = await setup();
  expect((await request(app).patch(`/api/ontologies/${o.id}`).send({ title: 'No session' })).status).toBe(401);
  const outsider = request.agent(app);
  await outsider.post('/api/auth/demo').send({ name: `Outside ${Math.random()}`, role: 'steward' });
  expect((await outsider.patch(`/api/ontologies/${o.id}`).send({ title: 'No role here' })).status).toBe(403);
  for (const title of ['', '   ', 'a'.repeat(201), 123, null]) expect((await owner.patch(`/api/ontologies/${o.id}`).send({ title })).status).toBe(400);
  expect((await owner.patch(`/api/ontologies/${o.id}`).send({ title: `  ${'a'.repeat(200)}  ` })).status).toBe(200);
  expect((await owner.patch(`/api/ontologies/${o.id}`).send({ title: 'x' })).status).toBe(200);
  for (const body of [{ description: null }, { description: 2 }, { domain: [] }]) expect((await owner.patch(`/api/ontologies/${o.id}`).send(body)).status).toBe(400);
  // Creation has no per-field description limit; editing accepts the same long text.
  const description = 'd'.repeat(20_001);
  expect((await owner.patch(`/api/ontologies/${o.id}`).send({ description })).body.description).toBe(description);
  expect((await owner.patch(`/api/ontologies/${o.id}`).send({ prefix: 'ignored', unknown: 'ignored' })).body).toMatchObject({ title: 'x', prefix: o.prefix, description });
  expect((await owner.patch(`/api/ontologies/${o.id}`).send({ description: '' })).body.description).toBe('');
});

it('a new ontology defers its two address checks and a released ontology keeps its usual checks', async () => {
  const { owner, o } = await setup();
  const fresh = await owner.get(`/api/ontologies/${o.id}/validation`);
  expect(fresh.status).toBe(200);
  for (const id of ['A1-rdf', 'A1-html']) expect(fresh.body.fair.checks.find((c: { id: string }) => c.id === id)).toMatchObject({ status: 'not-checked', message: 'Checked once the first version is published.' });
  const demo = (await findProject('volunteering'))!;
  const released = await owner.get(`/api/ontologies/${demo.id}/validation`);
  expect(released.status).toBe(200);
  for (const id of ['A1-rdf', 'A1-html']) expect(released.body.fair.checks.find((c: { id: string }) => c.id === id)).toMatchObject({ status: 'not-checked', message: 'not checked: the IRI was not looked up' });
  const publicSummary = await request(app).get(`/api/ontologies/${o.id}`);
  expect(publicSummary.body.stats).not.toHaveProperty('activeUseCases');
});
