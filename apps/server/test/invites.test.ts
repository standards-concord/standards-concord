import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Invite, InviteInput, OntologyProject, Role, User } from '@concord/shared';
import { createApp } from '../src/app.js';
import { DAY_MS, clock } from '../src/clock.js';
import { config } from '../src/config.js';
import { closeDb, get, list, openDb, put, rawStore, remove } from '../src/db.js';
import { createProject, rolesFor, setRoles } from '../src/services/ontologies.js';
import { createSession } from '../src/services/users.js';
import type { InviteDoc } from '../src/services/invites.js';
import * as clockService from '../src/clock.js';
import * as appChecks from '../src/services/appChecks.js';
import * as users from '../src/services/users.js';
import * as solidOidc from '../src/solidOidc.js';

const app = createApp();
let sequence = 0;
let ontology: OntologyProject;
let owner: User;
let clientAddress = 0;
const cookie = new Map<string, string>();

// Exercise Express, auth and JSON parsing in memory: this also works in sandboxes without listening sockets.
async function api(method: string, path: string, user?: User, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any; headers: ReturnType<ServerResponse['getHeaders']> }> {
  if (user && !cookie.has(user.id)) cookie.set(user.id, `concord_session=${await createSession(user.id, 'demo')}`);
  return new Promise((resolve, reject) => {
    const req = new IncomingMessage(new Socket());
    req.method = method;
    req.url = path;
    req.headers = { host: 'localhost', ...(user ? { cookie: cookie.get(user.id) } : {}), ...headers };
    Object.defineProperty(req.socket, 'remoteAddress', { value: `192.0.2.${clientAddress}` });
    const json = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    if (json !== undefined) {
      req.headers['content-type'] ??= 'application/json';
      req.headers['content-length'] = String(Buffer.byteLength(json));
    }
    const res = new ServerResponse(req);
    res.end = ((chunk?: string | Buffer) => {
      try {
        const text = chunk?.toString();
        const body = text && String(res.getHeader('content-type')).includes('application/json') ? JSON.parse(text) : text;
        resolve({ status: res.statusCode, body, headers: res.getHeaders() });
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
const accept = (secret: string, user: User) => api('POST', `/api/invites/${secret}/accept`, user, {});

beforeAll(async () => {
  await openDb(process.env.TEST_DATABASE_URL ? { kind: 'postgres', url: process.env.TEST_DATABASE_URL } : undefined);
});
beforeEach(async () => {
  // Each test gets its own rate-limit count; requests within the test still share a client.
  clientAddress++;
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

  it.each(['used up', 'expired', 'revoked'] as const)('%s invitations cannot restore any removed roles on retry', async (state) => {
    // Previously usedBy bypassed exhaustion and silently restored removed stewardship.
    const created = await invite({ roles: ['steward', 'reviewer'], maxUses: state === 'used up' ? 1 : 5, expiresInDays: 1 });
    const recipient = await person();
    expect((await accept(created.secret, recipient)).status).toBe(200);
    if (state === 'expired') clock.advance(DAY_MS);
    if (state === 'revoked') await api('DELETE', `${endpoint()}/${created.invite.id}`, owner);
    for (const remaining of [['reviewer'], []] satisfies Role[][]) {
      await setRoles(ontology.id, recipient.id, remaining);
      const before = await (await rawStore()).rows();
      const reconcile = vi.spyOn(appChecks, 'reconcile');
      try {
        expect(await accept(created.secret, recipient)).toMatchObject({ status: 410 });
        expect(await rolesFor(ontology.id, recipient.id)).toEqual(remaining);
        expect(await (await rawStore()).rows()).toEqual(before);
        expect(reconcile).not.toHaveBeenCalled();
      } finally { reconcile.mockRestore(); }
    }
  });

  it.each(['used up', 'expired', 'revoked'] as const)('%s invitations allow only side-effect-free retries when every role is held', async (state) => {
    // An unchanged membership must succeed without recording a use, activity or autopilot work.
    const created = await invite({ roles: ['reviewer', 'member'], maxUses: state === 'used up' ? 1 : 5, expiresInDays: 1 });
    const recipient = await person();
    expect((await accept(created.secret, recipient)).status).toBe(200);
    if (state === 'expired') clock.advance(DAY_MS);
    if (state === 'revoked') await api('DELETE', `${endpoint()}/${created.invite.id}`, owner);
    const before = await (await rawStore()).rows();
    const reconcile = vi.spyOn(appChecks, 'reconcile');
    try {
      expect(await accept(created.secret, recipient)).toMatchObject({ status: 200, body: { ontologyId: ontology.id } });
      expect(await (await rawStore()).rows()).toEqual(before);
      expect(reconcile).not.toHaveBeenCalled();
    } finally { reconcile.mockRestore(); }
  });

  it('rejects form and bodyless acceptance requests before changing membership', async () => {
    // A sibling origin could previously submit a form with the recipient's same-site session cookie.
    const created = await invite();
    const recipient = await person();
    for (const contentType of [undefined, 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=test', 'text/plain']) {
      const response = await api('POST', `/api/invites/${created.secret}/accept`, recipient,
        contentType ? 'ignored=value' : undefined, contentType ? { 'content-type': contentType } : {});
      expect(response.status).toBe(415);
      expect(await rolesFor(ontology.id, recipient.id)).toEqual([]);
      expect(await get<InviteDoc>('invites', created.invite.id)).toMatchObject({ uses: 0, usedBy: [] });
    }
    expect((await api('POST', `/api/invites/${created.secret}/accept`, recipient, {})).status).toBe(200);
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
    expect((await api('POST', `/api/invites/${created.secret}/accept`, undefined, {})).status).toBe(401);
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

  it.each(['/api/invites/', '/api/INVITES/', '/JOIN/'])('redacts invitation secrets in %s even when an exception contains the request path', async (prefix) => {
    // Express accepts case variants; both path replacement and exception suppression must do so too.
    const created = await invite();
    const path = `${prefix}${created.secret}`;
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const sync = vi.spyOn(clockService, 'syncClock').mockRejectedValueOnce(new Error(`Could not load ${path}`));
    try {
      expect((await api('GET', path)).status).toBe(500);
      expect(log).toHaveBeenCalledWith(`[GET ${prefix}[redacted]]`, 'HTTP 500');
      expect(JSON.stringify(log.mock.calls)).not.toContain(created.secret);
    } finally {
      sync.mockRestore();
      log.mockRestore();
    }
  });

  it('builds the complete invitation URL from the web origin when the API is elsewhere', async () => {
    // The copied URL used to point at the API port, where the browser app need not be served.
    const saved = { webUrl: config.webUrl, publicUrl: config.publicUrl };
    Object.assign(config, { webUrl: 'https://concord.example.org', publicUrl: 'https://api.example.org' });
    try {
      const created = await invite();
      expect(created.link).toBe(`https://concord.example.org/join/${created.secret}`);
    } finally { Object.assign(config, saved); }
  });

  it('keeps an invitation return path in a short-lived HttpOnly Solid cookie, never in the database', async () => {
    // An abandoned Solid sign-in used to leave the plaintext invitation secret in a pending kv row.
    const created = await invite();
    const saved = config.publicUrl;
    config.publicUrl = 'https://concord.example.org';
    const issuer = vi.spyOn(solidOidc, 'resolveIssuer').mockResolvedValue({ as: {
      issuer: 'https://solid.example.org', authorization_endpoint: 'https://solid.example.org/authorize', scopes_supported: ['webid'],
    } });
    try {
      const result = await api('GET', `/auth/solid?${new URLSearchParams({ webId: 'https://solid.example.org', returnTo: `/join/${created.secret}` })}`);
      expect(result.status).toBe(302);
      // Check persistence first so this regression fails on the actual secret leak.
      expect(JSON.stringify(await (await rawStore()).rows())).not.toContain(created.secret);
      const cookies = result.headers['set-cookie'] as string[];
      const returnCookie = cookies.find((value) => value.startsWith('solid_return='))!;
      expect(decodeURIComponent(returnCookie.split(';')[0]!)).toBe(`solid_return=/join/${created.secret}`);
      expect(returnCookie).toContain('HttpOnly');
      expect(returnCookie).toContain('Max-Age=600');
      expect(returnCookie).toContain('SameSite=Lax');
      expect(returnCookie).toContain('Secure');
      expect(String(result.headers.location)).not.toContain(created.secret);
    } finally {
      config.publicUrl = saved;
      issuer.mockRestore();
    }
  });

  it.each(['/join/a-secret', '//elsewhere.example', '/\\elsewhere.example', '/\nelsewhere', '/\u0000elsewhere', '/\u007felsewhere', 'https://elsewhere.example'])('validates the Solid return cookie at callback: %j', async (returnTo) => {
    // Moving next into a cookie must preserve the existing same-site path checks in both directions.
    const recipient = await person('Solid invitee');
    await put('users', { ...recipient, providers: [{ provider: 'solid', subject: recipient.webId }] });
    const finished = { webId: recipient.webId, issuer: 'https://solid.example.org', name: recipient.name, returnTo: '/', login: {} as solidOidc.SolidLogin };
    const finish = vi.spyOn(solidOidc, 'finishLogin').mockResolvedValue(finished);
    try {
      const response = await api('GET', '/auth/solid/callback?code=test&state=test', undefined, undefined,
        { cookie: `solid_login=browser-login; solid_return=${encodeURIComponent(returnTo)}` });
      expect(response.status).toBe(302);
      expect(response.headers.location).toBe(`${config.webUrl}${returnTo === '/join/a-secret' ? returnTo : '/'}`);
      expect(finish).toHaveBeenCalledWith('browser-login', `${config.publicUrl}/auth/solid/callback?code=test&state=test`);
      expect(response.headers['set-cookie']).toEqual(expect.arrayContaining([
        expect.stringMatching(/^solid_login=;.*Expires=/), expect.stringMatching(/^solid_return=;.*Expires=/),
      ]));
    } finally { finish.mockRestore(); }
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
