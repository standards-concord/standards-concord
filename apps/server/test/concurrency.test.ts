import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ChangeRequest, User } from '@concord/shared';
import { createApp } from '../src/app.js';
import { get, openDb, put } from '../src/db.js';
import { accountForIdentity } from '../src/auth.js';
import { mergeTesterRecords, recordVersion } from '../src/services/alpha.js';
import { createChangeRequest } from '../src/services/changeRequests.js';
import { createProject, getProject, members, transferOwnership } from '../src/services/ontologies.js';
import { draftRelease, listReleases } from '../src/services/releases.js';
import { seedDemo } from '../src/services/simulation.js';
import { createUseCase, getUseCase, updateUseCase } from '../src/services/useCases.js';
import { allUsers, createSession, createUser, findByProvider, getUser, sessionUser, upsertFederatedUser } from '../src/services/users.js';

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

  // Signing in looked the identity up and attached it in separate steps (r9 review): two sign-ins at once could
  // attach one GitHub identity to two demo accounts, or two identities to one account with one overwriting the other.
  it('attaches an identity to one account, and refuses a second identity linking the same demo account at once', async () => {
    const demo = (n: string) => createUser({ name: `Demo ${n}`, provider: 'demo', subject: `race-demo-${n}` });
    const [a, b] = await Promise.all([demo('a'), demo('b')]);
    const id = { provider: 'github' as const, subject: 'race-gh-1', name: 'Racer' };
    await Promise.all([upsertFederatedUser(id, a), upsertFederatedUser(id, b)]);
    const holders = [await getUser(a.id), await getUser(b.id)].filter((u) => u!.providers.some((p) => p.subject === 'race-gh-1'));
    expect(holders).toHaveLength(1);

    // Two identities at once for one demo account: one is attached to it, and the other is refused rather than given
    // a new account. A new account used to make the sign-in move the demo account's testing record into it, closing
    // the record the first identity now holds (r10 review).
    const c = await demo('c');
    const results = await Promise.allSettled([
      upsertFederatedUser({ provider: 'github', subject: 'race-gh-2', name: 'Racer two' }, c),
      upsertFederatedUser({ provider: 'google', subject: 'race-go-2', name: 'Racer two' }, c),
    ]);
    const done = results.filter((r): r is PromiseFulfilledResult<User> => r.status === 'fulfilled');
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(done.map((r) => r.value.id)).toEqual([c.id]);
    expect(refused.map((r) => (r.reason as { status?: number }).status)).toEqual([409]);
    const attached = (await getUser(c.id))!.providers.filter((p) => p.provider !== 'demo');
    expect(attached).toHaveLength(1);
    // Signing in again with the refused identity, now that the account isn't a demo one, makes its own account.
    const again = attached[0].provider === 'github' ? { provider: 'google' as const, subject: 'race-go-2' } : { provider: 'github' as const, subject: 'race-gh-2' };
    const fresh = await upsertFederatedUser({ ...again, name: 'Racer two' });
    expect(fresh.id).not.toBe(c.id);
    expect(await findByProvider(again.provider, again.subject)).toMatchObject({ id: fresh.id });
  });

  it('leaves alone a demo account another identity has just attached to, when an existing account signs in from the same browser', async () => {
    // The browser's demo account D is read before either sign-in. Identity A is new and is attached to D; identity B
    // already has account E. B's sign-in, holding the stale demo copy of D, used to be let through: it returned E,
    // and the caller then moved D's testing record into E, closing the record A now holds and ending A's sessions
    // (r11 review).
    const d = await createUser({ name: 'Demo stale', provider: 'demo', subject: 'race-demo-stale' });
    await recordVersion(d, { version: '0.8.0' });
    const e = await upsertFederatedUser({ provider: 'google', subject: 'race-go-existing', name: 'Existing E' });
    await recordVersion(e, { version: '0.6.0' });
    const a = { provider: 'github' as const, subject: 'race-gh-stale', name: 'Racer A' };
    expect((await accountForIdentity(a, d)).id).toBe(d.id);
    const aSession = await createSession(d.id, 'github');
    const historyOf = async (id: string) => await get<{ movedTo?: string; versions: { version: string }[] }>('kv', `alpha-history:${id}`);
    const before = { users: (await allUsers()).length, d: await historyOf(d.id), e: await historyOf(e.id) };

    await expect(accountForIdentity({ provider: 'google', subject: 'race-go-existing', name: 'Existing E' }, d)).rejects.toMatchObject({ status: 409 });
    expect((await allUsers()).length).toBe(before.users);
    expect(await historyOf(d.id)).toEqual(before.d);
    expect((await historyOf(d.id))?.movedTo).toBeUndefined();
    expect(await historyOf(e.id)).toEqual(before.e);
    expect((await sessionUser(aSession))?.id).toBe(d.id);
    // The move itself also re-checks, for an identity attached between the lookup and the move.
    await expect(mergeTesterRecords(d, e)).rejects.toMatchObject({ status: 409 });
    expect(await historyOf(d.id)).toEqual(before.d);
    expect((await sessionUser(aSession))?.id).toBe(d.id);

    // A signing in again with the same stale copy is a retry into the account it is already attached to.
    expect((await accountForIdentity(a, d)).id).toBe(d.id);
    expect((await allUsers()).length).toBe(before.users);
    expect((await sessionUser(aSession))?.id).toBe(d.id);
  });

  it('refuses to attach an identity to a demo account whose record has already moved into another account', async () => {
    // B (with account E) signs in from the browser first and takes over demo account D's record. A's sign-in, started
    // from the same browser with the copy of D read before, used to attach A to D and sign it in, although D's record
    // was closed, so every later visit or feedback was refused (r12 review).
    const d = await createUser({ name: 'Demo moved', provider: 'demo', subject: 'race-demo-moved' });
    await recordVersion(d, { version: '0.8.0' });
    const bId = { provider: 'google' as const, subject: 'race-go-moved', name: 'Existing E2' };
    const e = await upsertFederatedUser(bId);
    expect((await accountForIdentity(bId, d)).id).toBe(e.id);
    const before = { users: (await allUsers()).length, d: await getUser(d.id), e: await getUser(e.id) };

    await expect(accountForIdentity({ provider: 'github', subject: 'race-gh-moved', name: 'Racer A2' }, d)).rejects.toMatchObject({ status: 409 });
    expect((await allUsers()).length).toBe(before.users);
    expect(await getUser(d.id)).toEqual(before.d);
    expect(await findByProvider('github', 'race-gh-moved')).toBeUndefined();
    // B signing in again with the same copy is a retry into the account the record moved to.
    expect((await accountForIdentity(bId, d)).id).toBe(e.id);
    expect(await getUser(e.id)).toEqual(before.e);
  });

  it('changes nothing on an existing account whose sign-in is refused because another identity took the demo account first', async () => {
    // Both sign-ins start from one browser's demo account D. B's account E used to be updated (its missing avatar
    // filled in) before the record move was refused, so a refused sign-in still changed E (r12 review).
    const d = await createUser({ name: 'Demo both', provider: 'demo', subject: 'race-demo-both' });
    await recordVersion(d, { version: '0.8.0' });
    const bId = { provider: 'google' as const, subject: 'race-go-both', name: 'Existing E3' };
    const e = await upsertFederatedUser(bId);
    const before = { users: (await allUsers()).length, d: await getUser(d.id), e: await getUser(e.id) };
    const historyOf = async (id: string) => await get<{ movedTo?: string }>('kv', `alpha-history:${id}`);
    const results = await Promise.allSettled([
      accountForIdentity({ ...bId, avatarUrl: 'https://example.org/b.png' }, d),
      accountForIdentity({ provider: 'github', subject: 'race-gh-both', name: 'Racer A3' }, d),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected').map((r) => ((r as PromiseRejectedResult).reason as { status?: number }).status)).toEqual([409]);
    expect((await allUsers()).length).toBe(before.users);
    if (results[0].status === 'rejected') {
      // A was attached to D: E is exactly as it was, and D's record stays with D.
      expect(await getUser(e.id)).toEqual(before.e);
      expect((await historyOf(d.id))?.movedTo).toBeUndefined();
    } else {
      // B took over D's record: D is still a demo account, with no identity attached.
      expect(await getUser(d.id)).toEqual(before.d);
      expect((await historyOf(d.id))?.movedTo).toBe(e.id);
    }
  });
});
