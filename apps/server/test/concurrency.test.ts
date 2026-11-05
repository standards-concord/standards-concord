import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ChangeRequest, User } from '@concord/shared';
import { createApp } from '../src/app.js';
import { openDb, put } from '../src/db.js';
import { createChangeRequest } from '../src/services/changeRequests.js';
import { createProject, getProject, members, transferOwnership } from '../src/services/ontologies.js';
import { draftRelease, listReleases } from '../src/services/releases.js';
import { seedDemo } from '../src/services/simulation.js';
import { createUseCase, getUseCase, updateUseCase } from '../src/services/useCases.js';

/**
 * Requests that arrive at the same time. Since the store became async, a request can pause between reading a
 * document and writing it back, and another can run in that gap; each check-then-write below used to do that.
 *
 * The competing calls go straight to the services, started in the same tick. Over HTTP the two requests reach
 * the handlers a socket read apart, and on SQLite each critical section finishes within that gap, so the race
 * shows only on a networked database (Postgres), which these tests can't rely on.
 */

const app = createApp();
type Agent = ReturnType<typeof request.agent>;

async function login(name: string, role = 'contributor'): Promise<{ agent: Agent; user: User }> {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/demo').send({ name, role });
  expect(res.status).toBe(200);
  return { agent, user: res.body.user };
}

let n = 0;
async function newOntology(owner: Agent) {
  n++;
  const res = await owner.post('/api/ontologies').send({ title: `Concurrency ${n} ${Date.now()}`, prefix: `cc${n}`, governanceTemplate: 'steward-led' });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

beforeAll(async () => {
  await openDb();
  await seedDemo();
});

describe('requests made at the same time', () => {
  // Two transfers by the same owner could both pass the "is an owner" check before either demoted them, so both
  // recipients became owners of a single-owner project.
  it('two ownership transfers at once leave exactly one owner', async () => {
    const owner = await login('Owner Olu');
    const a = await login('Recipient Ada');
    const b = await login('Recipient Bo');
    const id = await newOntology(owner.agent);
    for (const m of [a, b]) expect((await owner.agent.put(`/api/ontologies/${id}/members/${m.user.id}`).send({ roles: ['member'] })).status).toBe(200);

    const results = await Promise.allSettled([a, b].map((m) => transferOwnership(id, owner.user, m.user.id)));
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason.status).toBe(403);

    const owners = (await members(id)).filter((m) => m.roles.includes('owner')).map((m) => m.userId);
    expect(owners).toHaveLength(1);
    expect((await getProject(id)).ownerIds).toEqual(owners);

    // The route still works end to end.
    const back = await login('Recipient Cy');
    const holder = owners[0] === a.user.id ? a : b;
    expect((await holder.agent.put(`/api/ontologies/${id}/members/${back.user.id}`).send({ roles: ['member'] })).status).toBe(200);
    const res = await holder.agent.post(`/api/ontologies/${id}/ownership-transfer`).send({ toUserId: back.user.id });
    expect(res.body).toEqual({ status: 'transferred' });
  });

  // A platform admin passes the owner check without being an owner, and each transfer used to demote only the
  // caller, so two admin transfers at once left the first recipient (and the real owner) still owners.
  it('two ownership transfers by an admin at once leave exactly one owner', async () => {
    const owner = await login('Owner Ode');
    const admin = { ...(await login('Admin Ama')).user, isPlatformAdmin: true };
    const a = await login('Recipient Abe');
    const b = await login('Recipient Bea');
    const id = await newOntology(owner.agent);
    for (const m of [a, b]) expect((await owner.agent.put(`/api/ontologies/${id}/members/${m.user.id}`).send({ roles: ['member'] })).status).toBe(200);

    const results = await Promise.all([a, b].map((m) => transferOwnership(id, admin, m.user.id)));
    expect(results.map((r) => r.status)).toEqual(['transferred', 'transferred']);

    const owners = (await members(id)).filter((m) => m.roles.includes('owner')).map((m) => m.userId);
    expect(owners).toHaveLength(1);
    expect([a.user.id, b.user.id]).toContain(owners[0]);
    expect((await getProject(id)).ownerIds).toEqual(owners);
  });

  // Each request counted the existing change requests and took the next number, and both could count before
  // either saved.
  it('change requests opened at once get different numbers', async () => {
    const owner = await login('Owner Num', 'steward');
    const project = await getProject(await newOntology(owner.agent));
    const crs = await Promise.all(
      Array.from({ length: 4 }, (_, i) => createChangeRequest(project, owner.user, { title: `Change ${i}`, description: 'Concurrent', kind: 'feature', origin: { type: 'chat' }, ops: [] })),
    );
    expect(new Set(crs.map((c) => c.number)).size).toBe(4);
  });

  // Each request looked for an open draft, found none, and created its own.
  it('drafting a release twice at once makes one draft', async () => {
    const { user } = await login('Owner Rel', 'steward');
    const project = await createProject({ title: `Release race ${Date.now()}`, description: '', prefix: 'rr', governanceTemplate: 'steward-led' }, user);
    const now = new Date().toISOString();
    const cr = {
      id: `cr_race_${Date.now()}`,
      number: 1,
      ontologyId: project.id,
      title: 'Merged change',
      description: '',
      kind: 'feature',
      origin: 'human',
      authorId: user.id,
      ops: [],
      status: 'merged',
      classification: { level: 'minor', reasons: [] },
      timeline: [],
      createdAt: now,
      updatedAt: now,
      statusSince: now,
    } as unknown as ChangeRequest;
    await put('changeRequests', cr, project.id);

    await Promise.all([draftRelease(project, user), draftRelease(project, user)]);
    const open = (await listReleases(project.id)).filter((r) => r.status === 'draft' || r.status === 'voting');
    expect(open).toHaveLength(1);
  });

  // The route read the use case before the update's transaction began, so two edits to different sections each
  // wrote back a copy without the other's change.
  it('edits to different sections of a use case at once both survive', async () => {
    const { agent, user } = await login('Author Uma', 'editor');
    const project = await getProject(await newOntology(agent));
    const uc = await createUseCase(project, user, { sections: { name: 'Race', goal: 'before' } });
    await Promise.all([updateUseCase(uc.id, user, { sections: { goal: 'goal edited' } }), updateUseCase(uc.id, user, { sections: { actors: 'actors edited' } })]);
    const now = await getUseCase(uc.id);
    expect(now.sections).toMatchObject({ name: 'Race', goal: 'goal edited', actors: 'actors edited' });
  });
});
