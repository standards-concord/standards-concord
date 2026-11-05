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
  await openDb();
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
          const s = await request(app).get('/api/feedback').set('Cookie', `concord_session=${await createSession(demoId, method)}`);
          expect(s.status).toBe(403);
        }
      } finally {
        config.adminWebIds.splice(0, config.adminWebIds.length, ...saved);
      }
    }));

  it('moves its testing record into an existing account in one step, and closes the demo record everywhere', () =>
    withGitHub(async () => {
      const existing = await upsertFederatedUser({ provider: 'github', subject: '7002', name: 'Existing account' });
      await recordVersion(existing, { version: '0.6.0' });
      const device1 = request.agent(app);
      const joined = await device1.post('/api/auth/demo').send({ name: 'Tester with history' });
      const demoId = joined.body.user.id as string;
      const demoToken = cookie(joined, 'concord_session')!;
      await device1.post('/api/alpha/visit').send({ version: '0.7.0' });

      await signInWithGitHub(device1, 7002);
      const me = (await device1.get('/api/alpha/me')).body;
      expect(me.tester.id).toBe(existing.id);
      expect(me.versions.map((v: { version: string }) => v.version)).toEqual(['0.7.0', '0.6.0']);

      // Another browser still holding the demo account's session is signed out, and the old record takes no more changes.
      const device2 = () => request(app).post('/api/alpha/visit').set('Cookie', `concord_session=${demoToken}`).send({ version: '0.8.0' });
      expect((await device2()).status).toBe(401);
      await expect(recordVersion((await (await import('../src/services/users.js')).getUser(demoId))!, { version: '0.8.0' })).rejects.toMatchObject({ status: 409 });
      // Moving again (say, a retried sign-in) changes nothing.
      expect((await device1.get('/api/alpha/me')).body.versions.map((v: { version: string }) => v.version)).toEqual(['0.7.0', '0.6.0']);
    }));
});

describe('a testing record when the pod can’t be written to', () => {
  it('keeps every visit and piece of feedback on this server, and the pod catches up later', async () => {
    const agent = request.agent(app);
    const id = (await agent.post('/api/auth/demo').send({ name: 'Pod is down' })).body.user.id as string;
    await agent.post('/api/alpha/visit').send({ version: '0.7.0' });
    const writeExisting = solid.writeExisting.bind(solid);
    const down = vi.spyOn(solid, 'writeExisting').mockImplementation(async (userId, ...rest) => {
      if (userId === id) throw new Error('PUT → 500');
      return writeExisting(userId, ...rest);
    });
    expect((await agent.post('/api/alpha/visit').send({ version: '0.8.0' })).status).toBe(200);
    const fb = await agent.post('/api/feedback').send({ pathway: 'general', answers: { overall: 4 }, transcript: [], appVersion: '0.8.0' });
    expect(fb.status).toBe(201);
    const behind = (await agent.get('/api/alpha/me')).body;
    expect(behind.podBehind).toBe(true);
    expect(behind.versions.map((v: { version: string }) => v.version)).toEqual(['0.8.0', '0.7.0']);
    expect(behind.versions[0].feedbackIds).toEqual([fb.body.id]);

    down.mockRestore();
    const caughtUp = (await agent.get('/api/alpha/me')).body;
    expect(caughtUp.podBehind).toBeUndefined();
    const mirror = JSON.parse((await solid.read(id, 'alpha/testing.jsonld'))!);
    expect(mirror.versions.map((v: { version: string }) => v.version)).toEqual(['0.8.0', '0.7.0']);
    expect(JSON.parse((await solid.read(id, `feedback/${fb.body.id}.json`))!).id).toBe(fb.body.id);
  });

  it('still moves everything into the account a tester signs in to, feedback included', () =>
    withGitHub(async () => {
      const existing = await upsertFederatedUser({ provider: 'github', subject: '7004', name: 'Existing account' });
      const agent = request.agent(app);
      const demoId = (await agent.post('/api/auth/demo').send({ name: 'Pod refuses writes' })).body.user.id as string;
      const writeExisting = solid.writeExisting.bind(solid);
      const down = vi.spyOn(solid, 'writeExisting').mockImplementation(async (userId, ...rest) => {
        if (userId === demoId || userId === existing.id) throw new Error('PUT → 500');
        return writeExisting(userId, ...rest);
      });
      const fb = await agent.post('/api/feedback').send({ pathway: 'general', answers: { overall: 3 }, transcript: [], appVersion: '0.7.0' });
      expect(fb.status).toBe(201);
      await signInWithGitHub(agent, 7004);
      const moved = (await agent.get('/api/alpha/me')).body;
      expect(moved.tester.id).toBe(existing.id);
      expect(moved.versions).toEqual([expect.objectContaining({ version: '0.7.0', feedbackIds: [fb.body.id] })]);
      expect(moved.podBehind).toBe(true);
      down.mockRestore();
      expect((await agent.get('/api/alpha/me')).body.podBehind).toBeUndefined();
      expect(JSON.parse((await solid.read(existing.id, `feedback/${fb.body.id}.json`))!).id).toBe(fb.body.id);
    }));
});

describe('the limits on a testing record', () => {
  it('never drop anything when two records merge, and refuse rather than drop when full', async () => {
    const { MAX_VERSIONS, mergeTesterRecords } = await import('../src/services/alpha.js');
    const a = await createUser({ name: 'Full record A', provider: 'demo', subject: 'full-a' });
    const b = await upsertFederatedUser({ provider: 'github', subject: 'full-b', name: 'Full record B' });
    for (let i = 0; i < MAX_VERSIONS; i++) {
      await recordVersion(a, { version: `50.0.${i}` });
      await recordVersion(b, { version: `60.0.${i}` });
    }
    await expect(recordVersion(b, { version: '70.0.0' })).rejects.toMatchObject({ status: 409 });
    await mergeTesterRecords(a, b);
    const merged = (await recordVersion(b, { version: '60.0.0' })).versions;
    expect(merged).toHaveLength(MAX_VERSIONS * 2);
    expect(merged.at(-1)?.version).toBe('50.0.0');
  });
});
