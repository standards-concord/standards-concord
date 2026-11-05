import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { APP_RELEASES, APP_VERSION, bumpFor, bumpVersion, changesFor, changesSince, compareVersions, lastTestedBefore, parseVersion, releasesSince } from '@concord/shared';
import { createApp } from '../src/app.js';
import { openDb, put } from '../src/db.js';
import { seedDemo } from '../src/services/simulation.js';
import { changeQuestions, FEEDBACK_QUESTIONS, questionsFor } from '../src/services/feedback.js';
import { createUser, upsertFederatedUser } from '../src/services/users.js';
import { mergeTesterRecords, normaliseVersions, recordVersion } from '../src/services/alpha.js';
import { solid } from '../src/services/solid.js';

const app = createApp();

beforeAll(async () => {
  openDb();
  await seedDemo();
});

describe('app release history', () => {
  it('numbers every release the way semantic-release would', () => {
    const oldestFirst = [...APP_RELEASES].reverse();
    expect(parseVersion(oldestFirst[0].version), 'first release').toBeTruthy();
    for (let i = 1; i < oldestFirst.length; i++) {
      const prev = oldestFirst[i - 1];
      const r = oldestFirst[i];
      const expected = bumpVersion(prev.version, bumpFor(r.changes));
      expect(r.version, `release "${r.title}" follows ${prev.version} with ${bumpFor(r.changes)} changes, so it should be ${expected}`).toBe(expected);
    }
    expect(APP_VERSION).toBe(APP_RELEASES[0].version);
  });

  it('has unique change ids, a date and something to say for every change', () => {
    const ids = APP_RELEASES.flatMap((r) => r.changes.map((c) => c.id));
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of APP_RELEASES) {
      expect(r.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(r.changes.length, r.version).toBeGreaterThan(0);
      for (const c of r.changes) {
        expect(c.title.length, c.id).toBeGreaterThan(5);
        expect(c.detail.length, c.id).toBeGreaterThan(10);
        if (c.to) expect(c.to, c.id).toMatch(/^(\/|\{o\})/);
      }
    }
  });

  it('dates never go backwards', () => {
    for (let i = 1; i < APP_RELEASES.length; i++) expect(APP_RELEASES[i - 1].date >= APP_RELEASES[i].date).toBe(true);
  });

  it('bumps majors, minors and patches', () => {
    expect(bumpFor([{ type: 'fix' }])).toBe('patch');
    expect(bumpFor([{ type: 'fix' }, { type: 'feat' }])).toBe('minor');
    expect(bumpFor([{ type: 'feat' }, { type: 'breaking' }])).toBe('major');
    expect(bumpVersion('0.8.1', 'minor')).toBe('0.9.0');
    expect(bumpVersion('0.8.1', 'major')).toBe('1.0.0');
    expect(compareVersions('0.10.0', '0.9.1')).toBeGreaterThan(0);
  });

  it('lists what changed since a version, newest first and not including it', () => {
    const since = APP_RELEASES[3].version;
    const rs = releasesSince(since);
    expect(rs.map((r) => r.version)).toEqual(APP_RELEASES.slice(0, 3).map((r) => r.version));
    expect(changesSince(since).every((c) => compareVersions(c.version, since) > 0)).toBe(true);
    expect(releasesSince(APP_VERSION)).toEqual([]);
    expect(releasesSince('not a version')).toEqual([]);
  });

  it('puts features first, and within them a role’s own changes, then everyone’s', () => {
    const all = changesSince('0.1.0');
    const forAgent = changesFor(all, 'agent');
    expect(forAgent.length).toBe(all.length);
    const firstFix = forAgent.findIndex((c) => c.type === 'fix');
    expect(forAgent.slice(firstFix).every((c) => c.type === 'fix')).toBe(true);
    const features = forAgent.slice(0, firstFix);
    const firstOther = features.findIndex((c) => !c.roles.includes('agent'));
    expect(firstOther).toBeGreaterThan(0);
    expect(features.slice(firstOther).some((c) => c.roles.includes('agent'))).toBe(false);
    // Everyone's changes come before other roles' changes.
    const rest = features.slice(firstOther);
    const firstOtherRole = rest.findIndex((c) => c.roles.length > 0);
    if (firstOtherRole >= 0) expect(rest.slice(firstOtherRole).every((c) => c.roles.length > 0)).toBe(true);
  });

  it('finds the last version tested before this one', () => {
    expect(lastTestedBefore([{ version: '0.2.0' }, { version: '0.6.1' }, { version: APP_VERSION }])).toBe('0.6.1');
    expect(lastTestedBefore([{ version: APP_VERSION }])).toBeUndefined();
    expect(lastTestedBefore([])).toBeUndefined();
  });
});

describe('feedback about what changed', () => {
  it('asks about each new feature since the version, then the overall questions', () => {
    const qs = changeQuestions('0.6.0', 'agent');
    const newIds = qs.filter((q) => q.id.startsWith('new:') && q.id !== 'new:other').map((q) => q.id);
    const expected = changesFor(changesSince('0.6.0'), 'agent').filter((c) => c.type !== 'fix' || c.ask);
    expect(newIds).toEqual(expected.slice(0, 6).map((c) => `new:${c.id}`));
    // The agent's own changes come first, newest first.
    const agentsOwn = expected.filter((c) => c.roles.includes('agent')).map((c) => `new:${c.id}`);
    expect(agentsOwn).toEqual(expect.arrayContaining(['new:chatgpt', 'new:agent-pages', 'new:mcp-oauth']));
    expect(newIds.slice(0, Math.min(6, agentsOwn.length))).toEqual(agentsOwn.slice(0, 6));
    expect(qs.map((q) => q.id)).toEqual(expect.arrayContaining(['new:other', 'overall', 'missing', 'comments']));
    // Nothing from the full questionnaire about the whole app (e.g. governance) is asked again.
    expect(qs.some((q) => q.id.startsWith('gov_'))).toBe(false);
    // A change's own question is asked as written (whichever changes are newest when this runs).
    const asked = expected.slice(0, 6).find((c) => c.ask)!;
    expect(qs.find((q) => q.id === `new:${asked.id}`)?.text).toBe(`New in ${asked.version}: ${asked.ask}`);
  });

  it('falls back to the full questionnaire when nothing has changed', () => {
    expect(questionsFor({ pathway: 'changes', since: APP_VERSION })).toBe(FEEDBACK_QUESTIONS);
    expect(questionsFor({ pathway: 'structured', since: '0.1.0' })).toBe(FEEDBACK_QUESTIONS);
  });

  it('serves the change questions and walks through them in the chat', async () => {
    const q = await request(app).get('/api/feedback/questions').query({ pathway: 'changes', since: '0.7.0', role: 'agent' });
    expect(q.status).toBe(200);
    const firstForAgents = changesFor(changesSince('0.7.0'), 'agent').filter((c) => c.type !== 'fix' || c.ask)[0];
    expect(firstForAgents.roles).toContain('agent');
    expect(q.body[0].id).toBe(`new:${firstForAgents.id}`);
    const chat = await request(app).post('/api/feedback/chat').send({ pathway: 'changes', since: '0.7.0', role: 'agent', messages: [], answers: {} });
    expect(chat.status).toBe(200);
    expect(chat.body.nextQuestionId).toBe(`new:${firstForAgents.id}`);
    expect(chat.body.reply).toMatch(/What’s new since 0\.7\.0/);
  });
});

describe('alpha tester records', () => {
  it('is empty for someone who is not signed in', async () => {
    const res = await request(app).get('/api/alpha/me');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ versions: [] });
    expect((await request(app).post('/api/alpha/visit').send({ version: APP_VERSION })).status).toBe(401);
  });

  it('saves the version to the tester’s pod and keeps it while they play a persona', async () => {
    const agent = request.agent(app);
    const me = await agent.post('/api/auth/demo').send({ name: 'Returning tester', role: 'member' });
    const testerId = me.body.user.id;
    expect((await agent.post('/api/alpha/visit').send({ version: 'nope' })).status).toBe(400);
    expect((await agent.post('/api/alpha/visit').send({ version: '0.0.1' })).status).toBe(400);
    // A web build a little ahead of this server is fine.
    expect((await agent.post('/api/alpha/visit').send({ version: '99.0.0' })).status).toBe(200);
    const v1 = await agent.post('/api/alpha/visit').send({ version: '0.7.0', commit: 'abc1234', role: 'member' });
    expect(v1.status).toBe(200);
    expect(v1.body.tester).toMatchObject({ id: testerId, name: 'Returning tester', lasting: false });
    expect(v1.body.storedIn).toBe('local');
    expect(v1.body.versions).toContainEqual(expect.objectContaining({ version: '0.7.0', commit: 'abc1234', roles: ['member'], feedbackIds: [] }));

    // Become a persona: the session is theirs now, but the tester is still the same person.
    const personas = (await agent.get('/api/personas')).body as { id: string; name: string }[];
    const persona = personas[0];
    const s = await agent.post('/api/auth/demo').send({ userId: persona.id });
    expect(s.body.user.id).toBe(persona.id);
    const after = await agent.get('/api/alpha/me');
    expect(after.body.tester.id).toBe(testerId);
    expect(after.body.versions.map((v: { version: string }) => v.version)).toEqual(['99.0.0', '0.7.0']);

    // Feedback given as the persona is recorded against the tester's version, in the tester's pod.
    const fb = await agent.post('/api/feedback').send({ pathway: 'changes', answers: { overall: 4 }, transcript: [], appVersion: APP_VERSION, sinceVersion: '0.7.0', role: 'member' });
    expect(fb.status).toBe(201);
    expect(fb.body).toMatchObject({ userId: persona.id, testerId, appVersion: APP_VERSION, sinceVersion: '0.7.0', pathway: 'changes' });
    expect(fb.body.savedTo.url).toContain(`/people/${testerId}/private/feedback/`);
    expect(fb.body.name).toBeUndefined();
    const record = await agent.get('/api/alpha/me');
    const current = record.body.versions.find((v: { version: string }) => v.version === APP_VERSION);
    expect(current.feedbackIds).toEqual([fb.body.id]);
    expect(lastTestedBefore(record.body.versions)).toBe('0.7.0');

    // Switching persona again keeps the same tester; signing out forgets both.
    await agent.post('/api/auth/demo').send({ userId: personas[1].id });
    expect((await agent.get('/api/alpha/me')).body.tester.id).toBe(testerId);
    await agent.post('/api/auth/logout');
    expect((await agent.get('/api/alpha/me')).body).toEqual({ versions: [] });
  });

  it('keeps the same tester when they join the demo again in another role', async () => {
    const agent = request.agent(app);
    const a = await agent.post('/api/auth/demo').send({ name: 'First', role: 'member' });
    const b = await agent.post('/api/auth/demo').send({ name: 'Second', role: 'agent' });
    expect(b.body.user.id).not.toBe(a.body.user.id);
    expect((await agent.get('/api/alpha/me')).body.tester.id).toBe(a.body.user.id);
    // A fresh browser is a fresh tester.
    const other = request.agent(app);
    const c = await other.post('/api/auth/demo').send({ name: 'Third', role: 'member' });
    expect((await other.get('/api/alpha/me')).body.tester.id).toBe(c.body.user.id);
  });

  it('keeps a demo tester’s records when they then sign in with Google or GitHub', async () => {
    const demo = await createUser({ name: 'Alpha tester', provider: 'demo', subject: 'tester_link' });
    const linked = await upsertFederatedUser({ provider: 'github', subject: 'gh-link-1', name: 'Real Name', email: 'real@example.org' }, demo);
    expect(linked.id).toBe(demo.id);
    expect(linked.name).toBe('Real Name');
    expect(linked.providers.map((p) => p.provider)).toEqual(['demo', 'github']);
    // Signing in again finds the same account; an existing account is never merged into someone else's demo account.
    expect((await upsertFederatedUser({ provider: 'github', subject: 'gh-link-1', name: 'Real Name' })).id).toBe(demo.id);
    const other = await createUser({ name: 'Alpha tester', provider: 'demo', subject: 'tester_link_2' });
    expect((await upsertFederatedUser({ provider: 'github', subject: 'gh-link-1', name: 'Real Name' }, other)).id).toBe(demo.id);
  });

  it('tidies malformed version lists, merging duplicates rather than dropping them', () => {
    const tidy = normaliseVersions([
      { version: '0.7.0', roles: {}, feedbackIds: 'x' },
      { version: 42 },
      null,
      { version: '0.7.0', roles: ['agent', 'nope'], firstAt: 'yesterday', feedbackIds: ['fb_a', 'bad id!'] },
      { version: '0.8.0', feedbackIds: ['fb_b'] },
    ]);
    expect(tidy).toEqual([
      expect.objectContaining({ version: '0.8.0', feedbackIds: ['fb_b'] }),
      expect.objectContaining({ version: '0.7.0', roles: ['agent'], feedbackIds: ['fb_a'] }),
    ]);
    expect(normaliseVersions({ versions: 1 })).toEqual([]);
  });

  it('mirrors the record to the tester’s pod, and never reads it back', async () => {
    const u = await createUser({ name: 'Edits their pod', provider: 'demo', subject: 'mirror' });
    await recordVersion(u, { version: '0.7.0' });
    expect(JSON.parse((await solid.read(u.id, 'alpha/testing.jsonld'))!).versions.map((v: { version: string }) => v.version)).toEqual(['0.7.0']);
    // Whatever happens to the pod copy, the history here is what counts, and the mirror is rewritten from it.
    await solid.write(u.id, 'alpha/testing.jsonld', 'not json');
    expect((await recordVersion(u, { version: '0.8.0' })).versions.map((v) => v.version)).toEqual(['0.8.0', '0.7.0']);
    expect(JSON.parse((await solid.read(u.id, 'alpha/testing.jsonld'))!).versions.map((v: { version: string }) => v.version)).toEqual(['0.8.0', '0.7.0']);
  });

  it('keeps every update when several arrive at once', async () => {
    const u = await createUser({ name: 'Many tabs', provider: 'demo', subject: 'tabs' });
    await Promise.all([
      recordVersion(u, { version: '0.6.0' }),
      recordVersion(u, { version: '0.7.0', role: 'agent' }),
      recordVersion(u, { version: '0.7.0', role: 'member' }),
      recordVersion(u, { version: '0.8.0', feedbackId: 'fb_one' }),
      recordVersion(u, { version: '0.8.0', feedbackId: 'fb_two' }),
    ]);
    const all = (await recordVersion(u, { version: '0.8.1' })).versions;
    expect(all.map((v) => v.version)).toEqual(['0.8.1', '0.8.0', '0.7.0', '0.6.0']);
    expect(all.find((v) => v.version === '0.7.0')?.roles?.sort()).toEqual(['agent', 'member']);
    expect(all.find((v) => v.version === '0.8.0')?.feedbackIds.sort()).toEqual(['fb_one', 'fb_two']);
  });

  it('moves a demo tester’s record into the existing account they sign in to', async () => {
    const existing = await upsertFederatedUser({ provider: 'github', subject: 'gh-existing-1', name: 'Existing' });
    await recordVersion(existing, { version: '0.6.0', feedbackId: 'fb_old' });
    const demo = await createUser({ name: 'Alpha tester', provider: 'demo', subject: 'tester_merge' });
    put('feedback', { id: 'fb_new', pathway: 'general', answers: {}, transcript: [], createdAt: new Date().toISOString() });
    await recordVersion(demo, { version: '0.8.0', role: 'agent', feedbackId: 'fb_new' });
    await mergeTesterRecords(demo, existing);
    const after = (await recordVersion(existing, { version: '0.6.0' })).versions;
    expect(after.map((v) => v.version)).toEqual(['0.8.0', '0.6.0']);
    expect(after[0]).toMatchObject({ roles: ['agent'], feedbackIds: ['fb_new'] });
    expect(JSON.parse((await solid.read(existing.id, 'feedback/fb_new.json'))!).id).toBe('fb_new');
  });
});
