import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
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

const legacyDoc = (versions: string[], feedbackIds: string[] = []) =>
  JSON.stringify({ versions: versions.map((version) => ({ version, firstAt: '2026-11-01T00:00:00Z', lastAt: '2026-11-01T00:00:00Z', feedbackIds })) });
const versionsOf = (me: { versions: { version: string }[] }) => me.versions.map((v) => v.version);
const tester = (subject: string) => createUser({ name: `Tester ${subject}`, provider: 'demo', subject });

describe('upgrading from a record kept only in the pod', () => {
  // Before this server kept the history, the first visit after upgrading started an empty one and overwrote the pod.
  it('imports what the pod and this server’s files held, and keeps it', async () => {
    const u = await tester('legacy-both');
    vi.spyOn(solid, 'readLegacy').mockResolvedValueOnce({ pod: legacyDoc(['0.7.0'], ['fb_pod']), local: legacyDoc(['0.6.0']) });
    const me = await recordVersion(u, { version: '0.8.0' });
    expect(versionsOf(me)).toEqual(['0.8.0', '0.7.0', '0.6.0']);
    expect(me.versions[1].feedbackIds).toEqual(['fb_pod']);
    // Imported once: later visits don't read the pod again.
    const reads = vi.spyOn(solid, 'readLegacy');
    reads.mockClear();
    expect(versionsOf(await recordVersion(u, { version: '0.8.1' }))).toEqual(['0.8.1', '0.8.0', '0.7.0', '0.6.0']);
    expect(reads).not.toHaveBeenCalled();
  });

  it('imports a record left in this server’s files', async () => {
    const agent = request.agent(app);
    const id = (await agent.post('/api/auth/demo').send({ name: 'Old local record' })).body.user.id as string;
    await solid.write(id, 'alpha/testing.jsonld', legacyDoc(['0.7.0']), 'application/ld+json');
    // (The demo sign-in itself doesn't touch the record, so this is the first time it's read.)
    expect(versionsOf((await agent.get('/api/alpha/me')).body)).toEqual(['0.7.0']);
  });

  it('changes nothing while the old record can’t be read, rather than starting an empty one', async () => {
    const u = await tester('legacy-down');
    vi.spyOn(solid, 'readLegacy').mockRejectedValueOnce(new Error('GET … → 500'));
    await expect(recordVersion(u, { version: '0.8.0' })).rejects.toMatchObject({ status: 503 });
    expect(get('kv', `alpha-history:${u.id}`)).toBeUndefined();
    vi.spyOn(solid, 'readLegacy').mockResolvedValueOnce({ pod: legacyDoc(['0.7.0']) });
    expect(versionsOf(await recordVersion(u, { version: '0.8.0' }))).toEqual(['0.8.0', '0.7.0']);
  });

  it('finishes a move an older version left waiting, unless the demo account has since become someone else’s', async () => {
    const into = await upsertFederatedUser({ provider: 'github', subject: 'legacy-into', name: 'Waiting account' });
    const demo = await tester('legacy-from');
    const relinked = await tester('legacy-relinked');
    await upsertFederatedUser({ provider: 'github', subject: 'legacy-other', name: 'Someone else' }, relinked);
    put('kv', { id: `alpha-transfer:${into.id}`, from: [demo.id, relinked.id] });
    vi.spyOn(solid, 'readLegacy').mockImplementation(async (userId) =>
      userId === demo.id ? { pod: legacyDoc(['0.7.0']) } : userId === relinked.id ? { pod: legacyDoc(['0.5.0'], ['fb_private']) } : {},
    );
    const me = await recordVersion(into, { version: '0.8.0' });
    expect(versionsOf(me)).toEqual(['0.8.0', '0.7.0']);
    expect(get('kv', `alpha-transfer:${into.id}`)).toBeUndefined();
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
