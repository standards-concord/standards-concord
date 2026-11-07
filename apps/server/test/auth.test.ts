import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { openDb } from '../src/db.js';
import { seedDemo } from '../src/services/simulation.js';
import { createUser, upsertFederatedUser } from '../src/services/users.js';

const app = createApp();

beforeAll(async () => {
  await openDb();
  await seedDemo();
});

describe('Google and GitHub sign-in', () => {
  it('rejects a callback without the state this browser was given', async () => {
    const saved = { ...config.github };
    Object.assign(config.github, { clientId: 'test-client', clientSecret: 'test-secret' });
    try {
      // No state and no cookie: both missing must not count as a match.
      expect((await request(app).get('/auth/github/callback?code=abc')).status).toBe(400);
      // A state from somewhere else.
      expect((await request(app).get('/auth/github/callback?code=abc&state=theirs').set('Cookie', 'oauth_state=mine')).status).toBe(400);
      expect((await request(app).get('/auth/github/callback?code=abc&state=').set('Cookie', 'oauth_state=')).status).toBe(400);
      // Starting sign-in sets a single-use state cookie.
      const start = await request(app).get('/auth/github');
      expect(start.status).toBe(302);
      expect(String(start.headers['set-cookie'])).toMatch(/oauth_state=[^;]+;.*HttpOnly/);
    } finally {
      Object.assign(config.github, saved);
    }
  });

  it('never signs a new identity into an existing account just because the email matches', async () => {
    const owner = await upsertFederatedUser({ provider: 'github', subject: 'gh-owner-1', name: 'Owner', email: 'owner@example.org' });
    const other = await upsertFederatedUser({ provider: 'google', subject: 'g-stranger-1', name: 'Stranger', email: 'owner@example.org' });
    expect(other.id).not.toBe(owner.id);
    expect((await upsertFederatedUser({ provider: 'github', subject: 'gh-owner-1', name: 'Owner' })).id).toBe(owner.id);
  });
});

// A sign-out made with no connection is sent later, naming the session it meant. It must end that
// session only: by then the browser may hold a newer sign-in, or another account's session.
describe('a sign-out sent later', () => {
  it('ends only the session it names', async () => {
    const agent = request.agent(app);
    const first = (await agent.post('/api/auth/demo').send({ name: 'Leaver' })).body;
    expect(first.sessionId).toMatch(/^[\w-]{22}$/);
    expect((await agent.get('/api/session')).body.sessionId).toBe(first.sessionId);
    // Signed in again (as someone else) before the old sign-out got through: it ends nothing.
    const second = (await agent.post('/api/auth/demo').send({ name: 'Newcomer' })).body;
    expect(second.sessionId).not.toBe(first.sessionId);
    expect((await agent.post('/api/auth/logout').send({ session: first.sessionId })).body).toEqual({ ended: false });
    expect((await agent.get('/api/session')).body.user?.id).toBe(second.user.id);
    // Naming the current session ends it.
    expect((await agent.post('/api/auth/logout').send({ session: second.sessionId })).body).toEqual({ ended: true });
    expect((await agent.get('/api/session')).body.user).toBeUndefined();
    // With nobody signed in there is nothing to end.
    expect((await agent.post('/api/auth/logout').send({ session: second.sessionId })).body).toEqual({ ended: false });
  });

  it('a plain sign-out still ends the current session, and the session id is never the token', async () => {
    const agent = request.agent(app);
    const r = await agent.post('/api/auth/demo').send({ name: 'Plain leaver' });
    const cookie = String(r.headers['set-cookie']).match(/concord_session=([^;]+)/)![1];
    expect(r.body.sessionId).not.toContain(cookie);
    // Another site's form can't sign anyone out: only a JSON request can.
    const form = await agent.post('/api/auth/logout').type('form').send('session=');
    expect(form.status).toBe(415);
    expect(String(form.headers['set-cookie'] ?? '')).not.toContain('concord_session=;');
    expect((await agent.get('/api/session')).body.user?.id).toBe(r.body.user.id);
    expect((await agent.post('/api/auth/logout').send({})).body).toEqual({ ended: true });
    expect((await agent.get('/api/session')).body.user).toBeUndefined();
  });
});

describe('reading feedback', () => {
  it('is not possible by giving yourself an ontology role or playing a persona', async () => {
    const owner = request.agent(app);
    await owner.post('/api/auth/demo').send({ name: 'Self-made owner', role: 'owner' });
    expect((await owner.get('/api/feedback')).status).toBe(403);
    expect((await owner.get('/api/feedback/summary')).status).toBe(403);
    const odi = request.agent(app);
    await odi.post('/api/auth/demo').send({ name: 'Self-made ODI', role: 'odi' });
    expect((await odi.get('/api/feedback')).status).toBe(403);
    const personas = (await odi.get('/api/personas')).body as { id: string; roles: string[] }[];
    const priya = personas.find((p) => p.roles.includes('owner'))!;
    const playing = request.agent(app);
    await playing.post('/api/auth/demo').send({ userId: priya.id });
    expect((await playing.get('/api/feedback')).status).toBe(403);
  });

  it('is possible for an administrator who signed in with Google or GitHub', async () => {
    const saved = config.adminEmails.slice();
    config.adminEmails.push('admin@example.org');
    try {
      const admin = await upsertFederatedUser({ provider: 'github', subject: 'gh-admin-1', name: 'Admin', email: 'admin@example.org' });
      // A demo account with the same address is not an administrator.
      const demo = await createUser({ name: 'Pretend admin', email: 'admin@example.org', provider: 'demo', subject: 'demo-admin' });
      const { createSession } = await import('../src/services/users.js');
      const asAdmin = await request(app).get('/api/feedback').set('Cookie', `concord_session=${await createSession(admin.id, 'github')}`);
      expect(asAdmin.status).toBe(200);
      const asDemo = await request(app).get('/api/feedback').set('Cookie', `concord_session=${await createSession(demo.id, 'demo')}`);
      expect(asDemo.status).toBe(403);
    } finally {
      config.adminEmails.splice(0, config.adminEmails.length, ...saved);
    }
  });

  it('is possible for the account whose WebID is in ADMIN_WEBIDS, signed in with GitHub, and nobody else', async () => {
    const { createSession } = await import('../src/services/users.js');
    const admin = await upsertFederatedUser({ provider: 'github', subject: 'gh-webid-admin', name: 'Jesse' });
    const demo = await createUser({ name: 'Demo with a WebID', provider: 'demo', subject: 'demo-webid' });
    const persona = ((await request(app).get('/api/personas')).body as { id: string; webId: string }[])[0];
    const saved = config.adminWebIds.slice();
    config.adminWebIds.push(admin.webId!, demo.webId!, persona.webId);
    try {
      const get = async (id: string) => request(app).get('/api/feedback').set('Cookie', `concord_session=${await createSession(id, 'github')}`);
      expect((await get(admin.id)).status).toBe(200);
      const session = await request(app).get('/api/session').set('Cookie', `concord_session=${await createSession(admin.id, 'github')}`);
      expect(session.body.user.isPlatformAdmin).toBe(true);
      // Listing a demo account's or a persona's WebID does not make them administrators.
      expect((await get(demo.id)).status).toBe(403);
      expect((await get(persona.id)).status).toBe(403);
    } finally {
      config.adminWebIds.splice(0, config.adminWebIds.length, ...saved);
    }
    // Without the setting, the same account is an ordinary user.
    expect((await request(app).get('/api/feedback').set('Cookie', `concord_session=${await createSession(admin.id, 'github')}`)).status).toBe(403);
  });
});
