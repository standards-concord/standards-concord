import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { get, openDb, put } from '../src/db.js';
import { seedDemo } from '../src/services/simulation.js';
import { createSession, createUser, sessionUser, upsertFederatedUser } from '../src/services/users.js';
import { MAX_FEEDBACK_PER_VERSION, MAX_VERSIONS, mergeTesterRecords, recordVersion, runSerially } from '../src/services/alpha.js';
import { submitFeedback } from '../src/services/feedback.js';
import { solid } from '../src/services/solid.js';

/**
 * The testing record kept on this server: importing what older versions left
 * in pods, storing feedback together with its place in the record, moving a
 * record in one step, and a mirror queue that survives failures.
 */

const app = createApp();
beforeAll(async () => {
  openDb();
  await seedDemo();
});
afterEach(() => vi.restoreAllMocks());

const tester = (subject: string) => createUser({ name: `Tester ${subject}`, provider: 'demo', subject });

describe('the first copy in a tester’s pod', () => {
  // Writing the mirror used to replace whatever was already at that path in their pod, even if this server hadn't written it.
  it('keeps anything already at that path, word for word, beside it', async () => {
    const u = await tester('already-there');
    const theirs = '@prefix ex: <https://example.org/> .\nex:mine ex:says "keep me" .\n';
    await solid.write(u.id, 'alpha/testing.jsonld', theirs, 'text/turtle');
    await recordVersion(u, { version: '0.8.0' });
    const dir = path.join(config.dataDir, 'private', u.id, 'alpha');
    const aside = fs.readdirSync(dir).filter((f) => /^testing\.previous-\d+-\d+\.jsonld$/.test(f));
    expect(aside).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, aside[0]), 'utf8')).toBe(theirs);
    expect(JSON.parse((await solid.read(u.id, 'alpha/testing.jsonld'))!).versions.map((v: { version: string }) => v.version)).toEqual(['0.8.0']);
    // Only the first time: later copies are this server's own.
    await recordVersion(u, { version: '0.8.1' });
    expect(fs.readdirSync(dir).filter((f) => f.includes('.previous-'))).toHaveLength(1);
  });

  it('never replaces a file already using the name it would keep a copy under', async () => {
    const u = await tester('name-taken');
    await solid.write(u.id, 'alpha/testing.jsonld', 'theirs', 'text/plain');
    const dir = path.join(config.dataDir, 'private', u.id, 'alpha');
    fs.writeFileSync(path.join(dir, 'testing.previous-1234-0.jsonld'), 'already here');
    vi.spyOn(Date, 'now').mockReturnValue(1234);
    await recordVersion(u, { version: '0.8.0' });
    expect(fs.readFileSync(path.join(dir, 'testing.previous-1234-0.jsonld'), 'utf8')).toBe('already here');
    expect(fs.readFileSync(path.join(dir, 'testing.previous-1234-1.jsonld'), 'utf8')).toBe('theirs');
  });

  it('writes nothing while the pod can’t say whether something is there, and catches up later', async () => {
    const u = await tester('pod-unsure');
    const keep = vi.spyOn(solid, 'keepExisting').mockRejectedValueOnce(new Error('GET … → 500'));
    const write = vi.spyOn(solid, 'writeExisting');
    const me = await recordVersion(u, { version: '0.8.0' });
    expect(me.podBehind).toBe(true);
    expect(write).not.toHaveBeenCalled();
    keep.mockRestore();
    expect((await recordVersion(u, { version: '0.8.1' })).podBehind).toBeUndefined();
    expect(write).toHaveBeenCalled();
  });
});

describe('feedback from a tester', () => {
  const answers = { overall: 4 };
  // Feedback used to be stored first, so a full or closed record answered 201 and the feedback never reached the record.
  it('is refused, and not stored, when the record already has its limit of versions', async () => {
    const u = await tester('full-versions');
    put('kv', { id: `alpha-history:${u.id}`, versions: Array.from({ length: MAX_VERSIONS }, (_, i) => ({ version: `50.0.${i}`, firstAt: '2026-11-01T00:00:00Z', lastAt: '2026-11-01T00:00:00Z', feedbackIds: [] })), rev: 1, mirroredRev: 1 });
    const before = (await import('../src/services/feedback.js')).listFeedback().length;
    await expect(submitFeedback(u, { pathway: 'general', usedVoice: false, answers, transcript: [], appVersion: '0.8.0' })).rejects.toMatchObject({ status: 409 });
    expect((await import('../src/services/feedback.js')).listFeedback()).toHaveLength(before);
  });

  it('is refused, and not stored, when that version already has its limit of feedback', async () => {
    const u = await tester('full-feedback');
    put('kv', { id: `alpha-history:${u.id}`, versions: [{ version: '0.8.0', firstAt: '2026-11-01T00:00:00Z', lastAt: '2026-11-01T00:00:00Z', feedbackIds: Array.from({ length: MAX_FEEDBACK_PER_VERSION }, (_, i) => `fb_${i}`) }], rev: 1, mirroredRev: 1 });
    await expect(submitFeedback(u, { pathway: 'general', usedVoice: false, answers, transcript: [], appVersion: '0.8.0' })).rejects.toMatchObject({ status: 409 });
  });

  it('is refused, and not stored, once the record has moved into another account', async () => {
    const demo = await tester('moved-feedback');
    const into = await upsertFederatedUser({ provider: 'github', subject: 'moved-feedback-into', name: 'Moved into' });
    await recordVersion(demo, { version: '0.7.0' });
    await mergeTesterRecords(demo, into);
    const before = (await import('../src/services/feedback.js')).listFeedback().length;
    await expect(submitFeedback(demo, { pathway: 'general', usedVoice: false, answers, transcript: [] })).rejects.toMatchObject({ status: 409 });
    expect((await import('../src/services/feedback.js')).listFeedback()).toHaveLength(before);
  });

  it('is stored with its place in the record, and comes back over the API with a link to the pod copy', async () => {
    const agent = request.agent(app);
    await agent.post('/api/auth/demo').send({ name: 'Gives feedback' });
    const fb = await agent.post('/api/feedback').send({ pathway: 'general', usedVoice: false, answers, transcript: [], appVersion: '0.8.0' });
    expect(fb.status).toBe(201);
    const me = (await agent.get('/api/alpha/me')).body;
    expect(me.versions).toEqual([expect.objectContaining({ version: '0.8.0', feedbackIds: [fb.body.id] })]);
  });
});

describe('feedback sent while playing a persona', () => {
  // When the tester's record moved while the request was on its way, the feedback used to be stored as the persona's, with no tester.
  it('is refused, not stored without its tester, when the remembered tester’s session has ended', async () => {
    const agent = request.agent(app);
    const demoId = (await agent.post('/api/auth/demo').send({ name: 'Plays a persona' })).body.user.id as string;
    const persona = ((await agent.get('/api/personas')).body as { id: string }[])[0];
    await agent.post('/api/auth/demo').send({ userId: persona.id });
    expect((await agent.get('/api/alpha/me')).body.tester.id).toBe(demoId);
    const into = await upsertFederatedUser({ provider: 'github', subject: 'persona-move-into', name: 'Moved into' });
    const { getUser } = await import('../src/services/users.js');
    await mergeTesterRecords(getUser(demoId)!, into);
    const { listFeedback } = await import('../src/services/feedback.js');
    const before = listFeedback().length;
    const fb = await agent.post('/api/feedback').send({ pathway: 'general', usedVoice: false, answers: { overall: 4 }, transcript: [] });
    expect(fb.status).toBe(409);
    expect(String(fb.headers['set-cookie'])).toMatch(/concord_tester=;/);
    expect(listFeedback()).toHaveLength(before);
    // With the stale cookie gone, the persona can send feedback as anyone signed out of a tester account would.
    expect((await agent.post('/api/feedback').send({ pathway: 'general', usedVoice: false, answers: { overall: 4 }, transcript: [] })).status).toBe(201);
  });
});

describe('moving a record', () => {
  // A move that stopped after closing the record left the demo account's sessions working, and retries never ended them.
  it('ends the demo account’s sessions even when an earlier attempt didn’t get that far', async () => {
    const demo = await tester('half-moved');
    const into = await upsertFederatedUser({ provider: 'github', subject: 'half-moved-into', name: 'Half moved into' });
    await recordVersion(demo, { version: '0.7.0' });
    put('kv', { ...get<{ id: string }>('kv', `alpha-history:${demo.id}`)!, movedTo: into.id });
    const token = createSession(demo.id, 'demo');
    expect(sessionUser(token)?.id).toBe(demo.id);
    await mergeTesterRecords(demo, into);
    expect(sessionUser(token)).toBeUndefined();
  });
});

describe('the pod mirror queue', () => {
  // A failed job used to break the queue for good, and its cleanup crashed the process with an unhandled rejection.
  it('keeps going after a job fails, without unhandled rejections', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const queues = new Map<string, Promise<void>>();
      const ran: string[] = [];
      const failed = runSerially(queues, 'k', async () => {
        throw new Error('database read failed');
      });
      const next = runSerially(queues, 'k', async () => {
        ran.push('next');
      });
      await expect(failed).rejects.toThrow('database read failed');
      await next;
      expect(ran).toEqual(['next']);
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).not.toHaveBeenCalled();
      expect(queues.size).toBe(0);
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});
