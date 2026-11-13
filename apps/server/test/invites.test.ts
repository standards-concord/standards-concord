import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Invite, InviteInput, OntologyProject, Role, User } from '@concord/shared';
import { createApp } from '../src/app.js';
import { DAY_MS, clock } from '../src/clock.js';
import { closeDb, get, list, openDb, put, rawStore, remove } from '../src/db.js';
import { createProject, rolesFor, setRoles } from '../src/services/ontologies.js';
import { createSession } from '../src/services/users.js';
import type { InviteDoc } from '../src/services/invites.js';
import * as inviteService from '../src/services/invites.js';
import * as appChecks from '../src/services/appChecks.js';
import * as users from '../src/services/users.js';

const app = createApp();
let sequence = 0;
let ontology: OntologyProject;
let owner: User;
const cookie = new Map<string, string>();

// Exercise Express, auth and JSON parsing in memory: this also works in sandboxes without listening sockets.
async function api(method: string, path: string, user?: User, body?: unknown): Promise<{ status: number; body: any; headers: ReturnType<ServerResponse['getHeaders']> }> {
  if (user && !cookie.has(user.id)) cookie.set(user.id, `concord_session=${await createSession(user.id, 'demo')}`);
  return new Promise((resolve, reject) => {
    const req = new IncomingMessage(new Socket());
    req.method = method;
    req.url = path;
    req.headers = { host: 'localhost', ...(user ? { cookie: cookie.get(user.id) } : {}) };
    Object.defineProperty(req.socket, 'remoteAddress', { value: '127.0.0.1' });
    const json = body === undefined ? undefined : JSON.stringify(body);
    if (json !== undefined) {
      req.headers['content-type'] = 'application/json';
      req.headers['content-length'] = String(Buffer.byteLength(json));
    }
    const res = new ServerResponse(req);
    res.end = ((chunk?: string | Buffer) => {
      try {
        resolve({ status: res.statusCode, body: chunk ? JSON.parse(chunk.toString()) : undefined, headers: res.getHeaders() });
      } catch (error) { reject(error); }
      return res;
    }) as typeof res.end;
    app(req, res);
    if (json !== undefined) req.push(json);
    req.push(null);
  });
}

async function person(name = 'Real member', simulated = false) {
  const id = `usr_invite_${++sequence}`;
  return put('users', { id, name: `${name} ${sequence}`, webId: `https://example.org/${id}`, providers: [{ provider: 'demo', subject: id }], simulated, createdAt: clock.iso() } satisfies User);
}
const endpoint = () => `/api/ontologies/${ontology.id}/invites`;
async function invite(input: Partial<InviteInput> = {}, by = owner) {
  const result = await api('POST', endpoint(), by, { roles: ['reviewer'], ...input });
  expect(result.status).toBe(201);
  return { ...result.body, secret: result.body.link.split('/join/')[1] } as { invite: Invite; link: string; secret: string };
}
const accept = (secret: string, user: User) => api('POST', `/api/invites/${secret}/accept`, user);

beforeAll(async () => {
  await openDb(process.env.TEST_DATABASE_URL ? { kind: 'postgres', url: process.env.TEST_DATABASE_URL } : undefined);
});
beforeEach(async () => {
  clock.reset();
  owner = await person('Invite owner');
  ontology = await createProject({ title: `Invite test ${++sequence}`, description: 'A group inviting people.', prefix: `iv${sequence}` }, owner);
});
afterAll(closeDb);

describe('invitation API', () => {
  it('allows owners and stewards to create, list and revoke; refuses contributors and signed-out users', async () => {
    const steward = await person('Steward');
    const contributor = await person('Contributor');
    await setRoles(ontology.id, steward.id, ['steward']);
    await setRoles(ontology.id, contributor.id, ['contributor']);
    const first = await invite();
    const second = await invite({ roles: ['steward'] }, steward);
    for (const user of [owner, steward]) {
      const result = await api('GET', endpoint(), user);
      expect(result.status).toBe(200);
      expect(result.body.map((i: Invite) => i.id)).toEqual([second.invite.id, first.invite.id]);
    }
    for (const [user, status] of [[undefined, 401], [contributor, 403]] as const) {
      expect((await api('POST', endpoint(), user, { roles: ['reviewer'] })).status).toBe(status);
      expect((await api('GET', endpoint(), user)).status).toBe(status);
      expect((await api('DELETE', `${endpoint()}/${first.invite.id}`, user)).status).toBe(status);
    }
    expect((await api('DELETE', `${endpoint()}/${first.invite.id}`, steward)).status).toBe(204);
    expect((await api('DELETE', `${endpoint()}/${first.invite.id}`, owner)).status).toBe(204);
    const other = await createProject({ title: `Other group ${++sequence}`, description: '', prefix: 'other' }, owner);
    expect((await api('DELETE', `/api/ontologies/${other.id}/invites/${second.invite.id}`, owner)).status).toBe(404);
  });

  it('refuses owner, agent, unknown and empty roles; ODI needs oversight or platform authority', async () => {
    for (const roles of [[], ['owner'], ['agent'], ['unknown'], ['reviewer', 'owner']])
      expect((await api('POST', endpoint(), owner, { roles })).status).toBe(400);
    expect((await api('POST', endpoint(), owner, { roles: ['odi'] })).status).toBe(403);
    await setRoles(ontology.id, owner.id, ['owner', 'odi']);
    await invite({ roles: ['odi'] });
    const admin = await person('Admin');
    await put('users', { ...admin, isPlatformAdmin: true });
    await invite({ roles: ['odi'] }, admin);
  });

  it('validates duration, use limits and notes, with seven-day and one-use defaults', async () => {
    for (const input of [{ expiresInDays: 0 }, { expiresInDays: 31 }, { expiresInDays: 1.5 }, { maxUses: 0 }, { maxUses: 51 }, { maxUses: '5' }, { note: 'x'.repeat(121) }])
      expect((await api('POST', endpoint(), owner, { roles: ['reviewer'], ...input })).status).toBe(400);
    const created = await invite();
    expect(created.invite.maxUses).toBe(1);
    expect(Date.parse(created.invite.expiresAt) - Date.parse(created.invite.createdAt)).toBe(7 * DAY_MS);
    await invite({ maxUses: 50, expiresInDays: 30, note: 'x'.repeat(120) });
  });

  it('stores only the secret hash and never returns it from create or list', async () => {
    const created = await invite({ roles: ['reviewer', 'member'] });
    expect(created.secret).toMatch(/^[\w-]{43}$/);
    expect(created.invite).not.toHaveProperty('hash');
    const stored = await get<InviteDoc>('invites', created.invite.id);
    expect(stored?.hash).toBe(createHash('sha256').update(created.secret).digest('hex'));
    expect(JSON.stringify((await (await rawStore()).rows()))).not.toContain(created.secret);
    const response = await api('GET', endpoint(), owner);
    expect(response.body[0]).not.toHaveProperty('hash');
    expect(JSON.stringify(response.body)).not.toContain(created.secret);
    const lookup = await api('GET', `/api/invites/${created.secret}`);
    expect(lookup.status).toBe(200);
    expect(lookup.headers['cache-control']).toContain('no-store');
    expect(lookup.body).toMatchObject({ ontology: { id: ontology.id, slug: ontology.slug }, roles: ['reviewer', 'member'], invitedBy: owner.name, state: 'active' });
  });

  it('unions roles, records an activity and use once, and reconciles autopilot', async () => {
    const created = await invite({ roles: ['reviewer', 'member'] });
    const recipient = await person();
    await setRoles(ontology.id, recipient.id, ['editor', 'contributor']);
    const reconcile = vi.spyOn(appChecks, 'reconcile');
    expect((await accept(created.secret, recipient)).status).toBe(200);
    expect((await accept(created.secret, recipient)).status).toBe(200);
    expect(await rolesFor(ontology.id, recipient.id)).toEqual(['editor', 'contributor', 'reviewer', 'member']);
    expect(await get<InviteDoc>('invites', created.invite.id)).toMatchObject({ uses: 1, usedBy: [{ userId: recipient.id }] });
    expect((await list<{ type: string; message: string; actorName: string }>('activity', ontology.id)).filter((a) => a.type === 'member.joined'))
      .toEqual([expect.objectContaining({ actorName: recipient.name, message: `joined as reviewer, member, invited by ${owner.name}` })]);
    expect(reconcile).toHaveBeenCalledWith(ontology.id, [recipient.id]);
    reconcile.mockRestore();
  });

  it('does not consume a use when all the roles are already held', async () => {
    const created = await invite({ roles: ['editor'] });
    expect((await accept(created.secret, owner)).status).toBe(200);
    expect((await get<InviteDoc>('invites', created.invite.id))?.uses).toBe(0);
  });

  it('enforces maximum uses and lets only one of two concurrent people take the last use', async () => {
    const created = await invite();
    const a = await person();
    const b = await person();
    const results = await Promise.all([accept(created.secret, a), accept(created.secret, b)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 410]);
    const winner = results[0].status === 200 ? a : b;
    const loser = winner.id === a.id ? b : a;
    expect(await rolesFor(ontology.id, winner.id)).toEqual(['reviewer']);
    expect(await rolesFor(ontology.id, loser.id)).toEqual([]);
    const lookup = await api('GET', `/api/invites/${created.secret}`);
    expect(lookup.status).toBe(410);
    expect(lookup.body.state).toBe('used up');
  });

  it('allows the configured number of different people and no more', async () => {
    const created = await invite({ maxUses: 2 });
    for (const status of [200, 200, 410]) expect((await accept(created.secret, await person())).status).toBe(status);
    expect((await get<InviteDoc>('invites', created.invite.id))?.uses).toBe(2);
  });

  it('expires on the governance clock and refuses revoked links immediately', async () => {
    const created = await invite({ expiresInDays: 1 });
    clock.advance(DAY_MS);
    expect(await api('GET', `/api/invites/${created.secret}`)).toMatchObject({ status: 410, body: { state: 'expired' } });
    expect((await accept(created.secret, await person())).status).toBe(410);
    const revoked = await invite();
    expect((await api('DELETE', `${endpoint()}/${revoked.invite.id}`, owner)).status).toBe(204);
    const gone = await api('GET', `/api/invites/${revoked.secret}`);
    expect(gone).toMatchObject({ status: 410, body: { state: 'revoked' } });
    // A dead link names the standard only: not who sent it or the roles it carried.
    expect(Object.keys(gone.body).sort()).toEqual(['error', 'ontology', 'state']);
    expect((await accept(revoked.secret, await person())).status).toBe(410);
  });

  it('answers malformed and unknown secrets identically, and requires sign-in to accept', async () => {
    for (const secret of ['unknown', 'x'.repeat(43), 'bad!']) {
      expect(await api('GET', `/api/invites/${secret}`)).toMatchObject({ status: 404, body: { error: 'This invitation link is not valid.' } });
      expect((await accept(secret, owner)).status).toBe(404);
    }
    const created = await invite();
    expect((await api('POST', `/api/invites/${created.secret}/accept`)).status).toBe(401);
  });

  it('refuses personas and agents while allowing an Alpha tester', async () => {
    const created = await invite();
    const simulated = await person('Simulated persona', true);
    expect((await accept(created.secret, simulated)).status).toBe(403);
    const agent = await person('Agent');
    await setRoles(ontology.id, agent.id, ['agent']);
    expect((await accept(created.secret, agent)).status).toBe(403);
    expect((await accept(created.secret, await person('Alpha tester'))).status).toBe(200);
  });

  it('uses a former member for a deleted inviter and invalidates links to a removed ontology', async () => {
    const created = await invite();
    await remove('users', owner.id);
    expect((await api('GET', `/api/invites/${created.secret}`)).body.invitedBy).toBe('a former member');
    await remove('ontologies', ontology.id);
    expect((await api('GET', `/api/invites/${created.secret}`)).status).toBe(404);
  });

  it('redacts invitation secrets even when an exception contains the request path', async () => {
    const created = await invite();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const lookup = vi.spyOn(inviteService, 'lookupInvite').mockRejectedValueOnce(new Error(`Could not load /api/invites/${created.secret}`));
    try {
      expect((await api('GET', `/api/invites/${created.secret}`)).status).toBe(500);
      expect(log).toHaveBeenCalledWith('[GET /api/invites/[redacted]]', 'HTTP 500');
      expect(JSON.stringify(log.mock.calls)).not.toContain(created.secret);
    } finally {
      lookup.mockRestore();
      log.mockRestore();
    }
  });

  it('rolls back roles and the use together if recording the activity fails', async () => {
    const created = await invite();
    const recipient = await person();
    const activity = vi.spyOn(users, 'logActivity').mockRejectedValueOnce(new Error('Activity unavailable'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await accept(created.secret, recipient)).status).toBe(500);
      expect(await rolesFor(ontology.id, recipient.id)).toEqual([]);
      expect(await get<InviteDoc>('invites', created.invite.id)).toMatchObject({ uses: 0, usedBy: [] });
    } finally {
      activity.mockRestore();
      log.mockRestore();
    }
    expect((await accept(created.secret, recipient)).status).toBe(200);
  });

  it('rate limits public lookups without exposing the link in the response', async () => {
    let result;
    for (let attempt = 0; attempt <= 60; attempt++) {
      result = await api('GET', '/api/invites/unknown');
      if (result.status === 429) break;
    }
    expect(result).toMatchObject({ status: 429, body: { error: 'Too many invitation requests. Try again in a minute.' } });
    expect(result?.headers['retry-after']).toBeDefined();
  });
});
