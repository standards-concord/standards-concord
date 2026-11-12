import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { OntologyGraph, rdfcHash } from '@concord/core';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { config } from '../src/config.js';
import { findProject } from '../src/services/ontologies.js';
import { ontologyStore } from '../src/services/ontologyStore.js';
import { seedDemo } from '../src/services/simulation.js';
import { createUser } from '../src/services/users.js';
import { createFederation } from '../src/services/federations.js';
import { publishFederationRelease } from '../src/services/federationReleases.js';

const app = createApp();
let volId: string;
beforeAll(async () => {
  await openDb();
  await seedDemo();
  volId = (await findProject('volunteering'))!.id;
});

async function login(name: string) {
  const agent = request.agent(app);
  expect((await agent.post('/api/auth/demo').send({ name, role: 'contributor' })).status).toBe(200);
  return agent;
}

describe('federation releases', () => {
  it('keeps the previous manifest version IRI when PUBLIC_URL changes', async () => {
    const owner = await createUser({ name: 'Federation ancestry owner', provider: 'demo', subject: 'fed-ancestry' });
    const fed = await createFederation(owner, { title: 'Federation ancestry', members: [{ ontologyId: volId, version: '1.0.0' }] });
    const originalUrl = config.publicUrl;
    try {
      config.publicUrl = 'https://old.concord.example';
      const first = await publishFederationRelease(fed, owner, {});
      const previousIRI = (await OntologyGraph.fromTurtle(first.manifest)).metadata().versionIRI;
      expect(previousIRI).toBe(`https://old.concord.example/def/fed/${fed.slug}/1.0.0`);
      config.publicUrl = 'https://new.concord.example';
      const second = await publishFederationRelease(fed, owner, {});
      expect((await OntologyGraph.fromTurtle(second.manifest)).metadata()).toMatchObject({
        versionIRI: `https://new.concord.example/def/fed/${fed.slug}/1.0.1`,
        priorVersion: previousIRI,
      });
    } finally { config.publicUrl = originalUrl; }
  });

  it('pins every member to its release and RDFC-1.0 hash, and publishes the manifest at /def/fed', async () => {
    const owner = await login('Release owner');
    const mine = (await owner.post('/api/ontologies').send({ title: `Draft only ${Date.now()}`, description: 'Not released yet.', prefix: 'dro' })).body;
    const fed = (await owner.post('/api/federations').send({ title: `Released ${Date.now()}`, members: [{ ontologyId: volId, version: '1.0.0' }, { ontologyId: mine.id, version: 'draft' }] })).body;

    // A member that follows its working draft can't be pinned.
    const blocked = await owner.get(`/api/federations/${fed.slug}/release-plan`);
    expect(blocked.body.ready).toBe(false);
    expect(blocked.body.blockers).toEqual([expect.stringMatching(/follows its working draft/)]);
    expect((await owner.post(`/api/federations/${fed.slug}/releases`).send({})).status).toBe(409);

    await owner.patch(`/api/federations/${fed.slug}`).send({ members: [{ ontologyId: volId, version: '1.0.0' }] });
    const plan = await owner.get(`/api/federations/${fed.slug}/release-plan`);
    expect(plan.body).toMatchObject({ ready: true, blockers: [], suggested: { version: '1.0.0' } });
    const volHash = await rdfcHash(await ontologyStore.at((await findProject('volunteering'))!, '1.0.0'));
    expect(plan.body.pins).toEqual([{ role: 'member', ontologyId: volId, title: expect.any(String), ontologyIRI: 'https://w3id.org/odi/volunteering', version: '1.0.0', versionIRI: 'https://w3id.org/odi/volunteering/1.0.0', hash: volHash }]);

    // Only an owner releases it.
    expect((await (await login('Not an owner')).post(`/api/federations/${fed.slug}/releases`).send({})).status).toBe(403);
    const rel = await owner.post(`/api/federations/${fed.slug}/releases`).send({ notes: 'First cut' });
    expect(rel.status).toBe(201);
    expect(rel.body).toMatchObject({ version: '1.0.0', notes: 'First cut', shapesHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/), hash: expect.stringMatching(/^sha256:/) });
    expect(rel.body.manifest).toBeUndefined();

    // Public, without signing in: the latest release, a version, and its derived shapes.
    const latest = await request(app).get(`/def/fed/${fed.slug}`);
    expect(latest.status).toBe(200);
    expect(latest.type).toBe('text/turtle');
    const manifest = await OntologyGraph.fromTurtle(latest.text);
    expect(manifest.ontologyIRI).toBe(`${config.publicUrl}/def/fed/${fed.slug}`);
    // It imports only the frozen closure (every pinned graph merged as checked), and lists the pinned member.
    expect(manifest.metadata().imports).toEqual([`${config.publicUrl}/def/fed/${fed.slug}/1.0.0/closure`]);
    expect(latest.text).toContain('dcterms:hasPart <https://w3id.org/odi/volunteering/1.0.0>');
    expect(latest.text).toContain(volHash.slice('sha256:'.length));
    expect(await rdfcHash(manifest)).toBe(rel.body.hash);
    expect((await request(app).get(`/def/fed/${fed.slug}/1.0.0`)).text).toBe(latest.text);
    const shapes = await request(app).get(`/def/fed/${fed.slug}/1.0.0/shapes`);
    expect(shapes.status).toBe(200);
    expect(await rdfcHash(await OntologyGraph.fromTurtle(shapes.text))).toBe(rel.body.shapesHash);
    // Derived from the member's OWL: a node shape for each of its classes.
    expect(shapes.text).toMatch(/sh:targetClass <https:\/\/w3id\.org\/odi\/volunteering#Person>/);
    // Review r1: importing members' version IRIs didn't freeze what they import without a version. The
    // closure is the frozen content: no owl:imports, the member's terms, and the hash the manifest pins.
    const closure = await request(app).get(`/def/fed/${fed.slug}/1.0.0/closure`);
    expect(closure.status).toBe(200);
    const frozen = await OntologyGraph.fromTurtle(closure.text);
    expect(frozen.metadata().imports).toEqual([]);
    expect(frozen.isDeclared('https://w3id.org/odi/volunteering#Person')).toBe(true);
    expect(await rdfcHash(frozen)).toBe(rel.body.closureHash);
    expect(latest.text).toContain(rel.body.closureHash.slice('sha256:'.length));
    expect((await request(app).get(`/def/fed/${fed.slug}/9.9.9`)).status).toBe(404);

    // The next release: nothing moved, so a patch, and it must come after 1.0.0.
    expect((await owner.get(`/api/federations/${fed.slug}/release-plan`)).body.suggested.version).toBe('1.0.1');
    expect((await owner.post(`/api/federations/${fed.slug}/releases`).send({ version: '1.0.0' })).status).toBe(400);
    const second = await owner.post(`/api/federations/${fed.slug}/releases`).send({});
    expect(second.body).toMatchObject({ version: '1.0.1', previousVersion: '1.0.0' });
    expect((await request(app).get(`/def/fed/${fed.slug}`)).text).toContain(`owl:priorVersion <${config.publicUrl}/def/fed/${fed.slug}/1.0.0>`);
    expect((await owner.get(`/api/federations/${fed.slug}/releases`)).body.map((r: { version: string }) => r.version)).toEqual(['1.0.1', '1.0.0']);
  });
});
