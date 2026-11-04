import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { openDb } from '../src/db.js';
import { seedDemo } from '../src/services/simulation.js';
import { createSession, createUser, upsertFederatedUser } from '../src/services/users.js';
import { recordVersion } from '../src/services/alpha.js';
import { solid } from '../src/services/solid.js';

/**
 * Sign-in with GitHub end to end (GitHub itself is faked), and what happens to
 * the sessions and the testing record of the demo account a tester was using.
 */

const app = createApp();
const realFetch = globalThis.fetch;

beforeAll(async () => {
  openDb();
  await seedDemo();
});
afterEach(() => vi.restoreAllMocks());

/** Fake GitHub's token, user and email endpoints for one identity. */
function fakeGitHub(id: number) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('https://github.com/login/oauth/access_token')) return Response.json({ access_token: `tok-${id}`, token_type: 'bearer', scope: 'read:user,user:email' });
    if (url === 'https://api.github.com/user') return Response.json({ id, login: `user${id}`, name: `GitHub user ${id}` });
    if (url === 'https://api.github.com/user/emails') return Response.json([]);
    return realFetch(input as RequestInfo, init);
  });
}

/** Run the GitHub callback in `agent`'s browser, as if GitHub had sent them back. */
async function signInWithGitHub(agent: ReturnType<typeof request.agent>, id: number) {
  fakeGitHub(id);
  const start = await agent.get('/auth/github');
  expect(start.status).toBe(302);
  const state = new URL(start.headers.location).searchParams.get('state')!;
  const done = await agent.get(`/auth/github/callback?code=ok&state=${state}`);
  expect(done.status, String(done.text)).toBe(302);
  return done;
}

const cookie = (res: request.Response, name: string) =>
  ([] as string[])
    .concat(res.headers['set-cookie'] ?? [])
    .map((c) => c.split(';')[0])
    .find((c) => c.startsWith(`${name}=`) && c.length > name.length + 1)
    ?.slice(name.length + 1);

async function withGitHub<T>(fn: () => Promise<T>) {
  const saved = { ...config.github };
  Object.assign(config.github, { clientId: 'test-client', clientSecret: 'test-secret' });
  try {
    return await fn();
  } finally {
    Object.assign(config.github, saved);
  }
}

describe('a demo account that signs in with GitHub', () => {
  it('loses every session it had as a demo account, so none of them can become an administrator', () =>
    withGitHub(async () => {
      // The attack: keep the demo session, switch to a persona, then sign in with a new GitHub identity.
      const agent = request.agent(app);
      const joined = await agent.post('/api/auth/demo').send({ name: 'Keeps a token' });
      const demoToken = cookie(joined, 'concord_session')!;
      const demoId = joined.body.user.id as string;
      const persona = ((await agent.get('/api/personas')).body as { id: string }[])[0];
      await agent.post('/api/auth/demo').send({ userId: persona.id });
      await signInWithGitHub(agent, 7001);
      const me = (await agent.get('/api/session')).body;
      expect(me.user.id).toBe(demoId);
      expect(me.user.providers.map((p: { provider: string }) => p.provider)).toEqual(['demo', 'github']);

      const saved = config.adminWebIds.slice();
      config.adminWebIds.push(me.user.webId);
      try {
        // The GitHub session is an administrator...
        expect((await agent.get('/api/feedback')).status).toBe(200);
        // ...but the old demo session no longer exists.
        const old = await request(app).get('/api/session').set('Cookie', `concord_session=${demoToken}`);
        expect(old.body.user).toBeFalsy();
        expect((await request(app).get('/api/feedback').set('Cookie', `concord_session=${demoToken}`)).status).toBe(401);
        // And a session that wasn't signed in with Google or GitHub never counts, whatever the account.
        for (const method of ['demo', undefined] as const) {
          const s = await request(app).get('/api/feedback').set('Cookie', `concord_session=${createSession(demoId, method)}`);
          expect(s.status).toBe(403);
        }
      } finally {
        config.adminWebIds.splice(0, config.adminWebIds.length, ...saved);
      }
    }));

  it('keeps its testing record reachable when the record can’t be moved yet, and moves it later', () =>
    withGitHub(async () => {
      const existing = await upsertFederatedUser({ provider: 'github', subject: '7002', name: 'Existing account' });
      await recordVersion(existing, { version: '0.6.0' });
      const agent = request.agent(app);
      const joined = await agent.post('/api/auth/demo').send({ name: 'Tester with history' });
      const demoId = joined.body.user.id as string;
      await agent.post('/api/alpha/visit').send({ version: '0.7.0' });

      // Their pod is out of reach while they sign in.
      const readExisting = solid.readExisting.bind(solid);
      const spy = vi.spyOn(solid, 'readExisting').mockImplementation(async (userId, rel) => {
        if (userId === demoId) throw new Error('pod unavailable');
        return readExisting(userId, rel);
      });
      const done = await signInWithGitHub(agent, 7002);
      expect(cookie(done, 'concord_tester')).toBeTruthy();
      expect((await agent.get('/api/session')).body.user.id).toBe(existing.id);
      // Nothing was lost: the demo account is still the tester, and its record is untouched.
      const waiting = (await agent.get('/api/alpha/me')).body;
      expect(waiting.tester.id).toBe(demoId);
      expect(waiting.unreadable).toBe(true);
      const { versions: existingVersions } = await recordVersion(existing, { version: '0.6.0' });
      expect(existingVersions.map((v) => v.version)).toEqual(['0.6.0']);

      // Once the pod is back, the next visit moves the record and the GitHub account becomes the tester.
      spy.mockRestore();
      const moved = (await agent.get('/api/alpha/me')).body;
      expect(moved.tester.id).toBe(existing.id);
      expect(moved.versions.map((v: { version: string }) => v.version)).toEqual(['0.7.0', '0.6.0']);
      expect((await agent.get('/api/alpha/me')).body.tester.id).toBe(existing.id);
    }));
});

describe('a testing record that can’t be read', () => {
  it('is never written over', async () => {
    const u = await createUser({ name: 'Flaky pod', provider: 'demo', subject: 'flaky' });
    await recordVersion(u, { version: '0.7.0' });
    vi.spyOn(solid, 'readExisting').mockRejectedValueOnce(new Error('GET … → 500'));
    await expect(recordVersion(u, { version: '0.8.0' })).rejects.toMatchObject({ status: 503 });
    expect((await recordVersion(u, { version: '0.8.1' })).versions.map((v) => v.version)).toEqual(['0.8.1', '0.7.0']);
  });

  it('is reported as unreadable rather than empty, and a visit is refused', async () => {
    const agent = request.agent(app);
    const joined = await agent.post('/api/auth/demo').send({ name: 'Out of reach' });
    await agent.post('/api/alpha/visit').send({ version: '0.7.0' });
    const id = joined.body.user.id as string;
    const readExisting = solid.readExisting.bind(solid);
    vi.spyOn(solid, 'readExisting').mockImplementation(async (userId, rel) => {
      if (userId === id) throw new Error('pod unavailable');
      return readExisting(userId, rel);
    });
    const me = (await agent.get('/api/alpha/me')).body;
    expect(me).toMatchObject({ versions: [], unreadable: true });
    expect((await agent.post('/api/alpha/visit').send({ version: '0.8.0' })).status).toBe(503);
    vi.restoreAllMocks();
    expect((await agent.get('/api/alpha/me')).body.versions.map((v: { version: string }) => v.version)).toEqual(['0.7.0']);
  });

  it('keeps a record that isn’t JSON aside before starting a new one', async () => {
    const u = await createUser({ name: 'Garbled pod', provider: 'demo', subject: 'garbled' });
    await solid.write(u.id, 'alpha/testing.jsonld', 'not json');
    const writes = vi.spyOn(solid, 'write');
    expect((await recordVersion(u, { version: '0.8.0' })).versions.map((v) => v.version)).toEqual(['0.8.0']);
    expect(writes.mock.calls[0]).toEqual([u.id, expect.stringMatching(/^alpha\/testing\.unreadable-\d+\.jsonld$/), 'not json', 'text/plain']);
  });
});
