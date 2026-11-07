import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { get, openDb, put, remove } from '../src/db.js';
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
  await openDb();
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

  // Locally, the copy used to be written over unconditionally, even if the file changed (or appeared) after it was checked.
  it('never writes over a local file that changed after it was kept', async () => {
    const u = await tester('local-changed');
    await solid.write(u.id, 'alpha/testing.jsonld', 'first', 'text/plain');
    const file = path.join(config.dataDir, 'private', u.id, 'alpha', 'testing.jsonld');
    const keep = solid.keepExisting.bind(solid);
    const spy = vi.spyOn(solid, 'keepExisting').mockImplementationOnce(async (...args) => {
      const when = await keep(...args);
      fs.writeFileSync(file, 'changed meanwhile');
      return when;
    });
    expect((await recordVersion(u, { version: '0.8.0' })).podBehind).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe('changed meanwhile');
    spy.mockRestore();
    expect((await recordVersion(u, { version: '0.8.1' })).podBehind).toBeUndefined();
    const dir = path.dirname(file);
    const kept = fs.readdirSync(dir).filter((f) => f.includes('.previous-')).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).sort();
    expect(kept).toEqual(['changed meanwhile', 'first']);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).versions.map((v: { version: string }) => v.version)).toEqual(['0.8.1', '0.8.0']);
  });

  it('never writes over a local file that appeared after it found nothing there', async () => {
    const u = await tester('local-appeared');
    const file = path.join(config.dataDir, 'private', u.id, 'alpha', 'testing.jsonld');
    const keep = solid.keepExisting.bind(solid);
    vi.spyOn(solid, 'keepExisting').mockImplementationOnce(async (...args) => {
      const when = await keep(...args);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'appeared meanwhile');
      return when;
    });
    expect((await recordVersion(u, { version: '0.8.0' })).podBehind).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe('appeared meanwhile');
    expect((await recordVersion(u, { version: '0.8.1' })).podBehind).toBeUndefined();
    const dir = path.dirname(file);
    expect(fs.readdirSync(dir).filter((f) => f.includes('.previous-')).map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))).toEqual(['appeared meanwhile']);
    expect(fs.readdirSync(dir).filter((f) => f.includes('tmp'))).toEqual([]);
  });

  // The copy and the replacement used to get default permissions, so a private (0600) file became world-readable.
  it('keeps a private file’s permissions on its copy and on the record that replaces it', async () => {
    const u = await tester('local-private');
    await solid.write(u.id, 'alpha/testing.jsonld', 'private', 'text/plain');
    const file = path.join(config.dataDir, 'private', u.id, 'alpha', 'testing.jsonld');
    fs.chmodSync(file, 0o600);
    expect((await recordVersion(u, { version: '0.8.0' })).podBehind).toBeUndefined();
    const dir = path.dirname(file);
    const aside = fs.readdirSync(dir).find((f) => f.includes('.previous-'))!;
    expect(fs.statSync(path.join(dir, aside)).mode & 0o777).toBe(0o600);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  // The temporary file used to be written with default permissions and only then narrowed, so a crash in between
  // left the content world-readable.
  it('never writes content into a temporary file anyone else could read', async () => {
    const u = await tester('local-tmp-mode');
    await solid.write(u.id, 'alpha/testing.jsonld', 'private', 'text/plain');
    const dir = path.join(config.dataDir, 'private', u.id, 'alpha');
    fs.chmodSync(path.join(dir, 'testing.jsonld'), 0o600);
    // A leftover temporary file with loose permissions, as a crash might leave.
    fs.writeFileSync(path.join(dir, '.testing.jsonld.concord-tmp'), 'old', { mode: 0o644 });
    fs.chmodSync(path.join(dir, '.testing.jsonld.concord-tmp'), 0o644);
    const modesAtWrite: number[] = [];
    // Only writes to files in the tester's folder count: on PGlite the database writes its own files the same way.
    const theirs = new Set<number>();
    const open = fs.openSync.bind(fs);
    vi.spyOn(fs, 'openSync').mockImplementation(((file: fs.PathLike, ...rest: unknown[]) => {
      const fd = (open as (...a: unknown[]) => number)(file, ...rest);
      if (String(file).startsWith(dir)) theirs.add(fd);
      return fd;
    }) as typeof fs.openSync);
    const write = fs.writeSync.bind(fs);
    vi.spyOn(fs, 'writeSync').mockImplementation(((fd: number, ...rest: unknown[]) => {
      if (theirs.has(fd)) modesAtWrite.push(fs.fstatSync(fd).mode & 0o777);
      return (write as (...a: unknown[]) => number)(fd, ...rest);
    }) as typeof fs.writeSync);
    expect((await recordVersion(u, { version: '0.8.0' })).podBehind).toBeUndefined();
    expect(modesAtWrite.length).toBeGreaterThan(0);
    expect(modesAtWrite.every((m) => (m & 0o077) === 0)).toBe(true);
  });

  // A short write (fewer bytes written than asked) used to be ignored, renaming a truncated record over the original.
  it('writes every byte of the record even when the system writes only part of it at a time', async () => {
    const u = await tester('local-short-write');
    await solid.write(u.id, 'alpha/testing.jsonld', 'theirs', 'text/plain');
    const write = fs.writeSync.bind(fs) as (...a: unknown[]) => number;
    vi.spyOn(fs, 'writeSync').mockImplementation(((fd: number, buf: Buffer, off = 0, len = buf.length - off) =>
      write(fd, buf, off, Math.min(len, 7))) as unknown as typeof fs.writeSync);
    const me = await recordVersion(u, { version: '0.8.0' });
    expect(me.podBehind).toBeUndefined();
    vi.restoreAllMocks();
    const file = path.join(config.dataDir, 'private', u.id, 'alpha', 'testing.jsonld');
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).versions.map((v: { version: string }) => v.version)).toEqual(['0.8.0']);
  });

  // A failed rename (or a crash before it) used to leave a new temporary file behind on every try.
  it('leaves no temporary file behind when replacing fails, and reuses one a crash left', async () => {
    const u = await tester('local-tmp');
    await solid.write(u.id, 'alpha/testing.jsonld', 'theirs', 'text/plain');
    const dir = path.join(config.dataDir, 'private', u.id, 'alpha');
    const leftovers = () => fs.readdirSync(dir).filter((f) => f.includes('tmp'));
    const rename = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' });
    });
    expect((await recordVersion(u, { version: '0.8.0' })).podBehind).toBe(true);
    expect(leftovers()).toEqual([]);
    rename.mockRestore();
    // As if the server had been killed between writing the temporary file and renaming it.
    fs.writeFileSync(path.join(dir, '.testing.jsonld.concord-tmp'), 'half written');
    expect((await recordVersion(u, { version: '0.8.1' })).podBehind).toBeUndefined();
    expect(leftovers()).toEqual([]);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'testing.jsonld'), 'utf8')).versions.map((v: { version: string }) => v.version)).toEqual(['0.8.1', '0.8.0']);
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
    await put('kv', { id: `alpha-history:${u.id}`, versions: Array.from({ length: MAX_VERSIONS }, (_, i) => ({ version: `50.0.${i}`, firstAt: '2026-11-01T00:00:00Z', lastAt: '2026-11-01T00:00:00Z', feedbackIds: [] })), rev: 1, mirroredRev: 1 });
    const before = (await (await import('../src/services/feedback.js')).listFeedback()).length;
    await expect(submitFeedback(u, { pathway: 'general', usedVoice: false, answers, transcript: [], appVersion: '0.8.0' })).rejects.toMatchObject({ status: 409 });
    expect(await (await import('../src/services/feedback.js')).listFeedback()).toHaveLength(before);
  });

  it('is refused, and not stored, when that version already has its limit of feedback', async () => {
    const u = await tester('full-feedback');
    await put('kv', { id: `alpha-history:${u.id}`, versions: [{ version: '0.8.0', firstAt: '2026-11-01T00:00:00Z', lastAt: '2026-11-01T00:00:00Z', feedbackIds: Array.from({ length: MAX_FEEDBACK_PER_VERSION }, (_, i) => `fb_${i}`) }], rev: 1, mirroredRev: 1 });
    await expect(submitFeedback(u, { pathway: 'general', usedVoice: false, answers, transcript: [], appVersion: '0.8.0' })).rejects.toMatchObject({ status: 409 });
  });

  it('is refused, and not stored, once the record has moved into another account', async () => {
    const demo = await tester('moved-feedback');
    const into = await upsertFederatedUser({ provider: 'github', subject: 'moved-feedback-into', name: 'Moved into' });
    await recordVersion(demo, { version: '0.7.0' });
    await mergeTesterRecords(demo, into);
    const before = (await (await import('../src/services/feedback.js')).listFeedback()).length;
    await expect(submitFeedback(demo, { pathway: 'general', usedVoice: false, answers, transcript: [] })).rejects.toMatchObject({ status: 409 });
    expect(await (await import('../src/services/feedback.js')).listFeedback()).toHaveLength(before);
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
    await mergeTesterRecords((await getUser(demoId))!, into);
    const { listFeedback } = await import('../src/services/feedback.js');
    const before = (await listFeedback()).length;
    const fb = await agent.post('/api/feedback').send({ pathway: 'general', usedVoice: false, answers: { overall: 4 }, transcript: [] });
    expect(fb.status).toBe(409);
    expect(String(fb.headers['set-cookie'])).toMatch(/concord_tester=;/);
    expect(await listFeedback()).toHaveLength(before);
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
    await put('kv', { ...(await get<{ id: string }>('kv', `alpha-history:${demo.id}`))!, movedTo: into.id });
    const token = await createSession(demo.id, 'demo');
    expect((await sessionUser(token))?.id).toBe(demo.id);
    await mergeTesterRecords(demo, into);
    expect(await sessionUser(token)).toBeUndefined();
  });
});

describe('the pod mirror queue', () => {
  // On Vercel each function instance has a queue of its own, so two instances can copy one tester's record at
  // once. A lease (review r1 of step 5) didn't fence the write: a holder that overran it could put an older
  // revision over a newer one and still record the newer as copied. Now each write replaces exactly the version it
  // read, and the copy names its revision.
  const copy = async (id: string) => JSON.parse((await solid.read(id, 'alpha/testing.jsonld'))!) as { revision: number; versions: { version: string }[] };
  const otherServerWrites = (revision: number, versions: string[]) => {
    const real = solid.readTagged.bind(solid);
    return vi.spyOn(solid, 'readTagged').mockImplementationOnce(async (id, rel) => {
      const seen = await real(id, rel);
      // Between this server's read and its write, another server replaces the copy.
      await solid.writeExisting(id, rel, JSON.stringify({ '@type': 'concord:AlphaTestingRecord', revision, versions: versions.map((version) => ({ version })) }), 'application/ld+json', { ifMatch: seen.tag! });
      return seen;
    });
  };
  afterEach(() => vi.restoreAllMocks());

  it('never puts an older revision over a newer one that another server wrote meanwhile', async () => {
    const u = await tester('mirror-newer');
    await recordVersion(u, { version: '0.8.0' });
    expect((await copy(u.id)).revision).toBe(1);
    otherServerWrites(50, ['0.9.0', '0.8.1', '0.8.0']);
    const me = await recordVersion(u, { version: '0.8.1' });
    expect((await copy(u.id)).revision).toBe(50);
    expect(me.podBehind).toBeUndefined();
  });

  // Review r2 of step 5: the first copy still went through keepExisting alone. A server that read the history
  // before another server made the first copy (a newer revision) then kept that copy aside and replaced it with its
  // older revision, and the newer one was recorded as copied, so it was never repaired.
  it('never puts its first copy over a newer one that another server made meanwhile', async () => {
    const u = await tester('mirror-first-race');
    const keep = solid.keepExisting.bind(solid);
    vi.spyOn(solid, 'keepExisting').mockImplementationOnce(async (id, rel, opts) => {
      // Between this server reading the history and looking at the pod, another server copies revision 7.
      await solid.write(id, rel, JSON.stringify({ '@type': 'concord:AlphaTestingRecord', revision: 7, versions: [{ version: '0.9.0' }, { version: '0.8.0' }] }), 'application/ld+json');
      return keep(id, rel, opts);
    });
    const me = await recordVersion(u, { version: '0.8.0' });
    expect((await copy(u.id)).revision).toBe(7);
    expect(me.podBehind).toBeUndefined();
    // Concord's own record isn't kept aside as if it were someone else's document.
    const dir = path.join(config.dataDir, 'private', u.id, 'alpha');
    expect(fs.readdirSync(dir).filter((f) => f.includes('.previous-'))).toEqual([]);
  });

  // Review r3 of step 5: any JSON naming a positive revision was taken for Concord's own record, so a person's own
  // document at that path that happened to have a "revision" was replaced without being kept aside first.
  it('keeps a person’s own JSON that names a revision aside, word for word, before the first copy', async () => {
    const u = await tester('own-json-revision');
    const theirs = JSON.stringify({ revision: 1, notes: 'my own testing notes' });
    await solid.write(u.id, 'alpha/testing.jsonld', theirs, 'application/json');
    await recordVersion(u, { version: '0.8.0' });
    const dir = path.join(config.dataDir, 'private', u.id, 'alpha');
    const aside = fs.readdirSync(dir).filter((f) => /^testing\.previous-\d+-\d+\.jsonld$/.test(f));
    expect(aside).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, aside[0]), 'utf8')).toBe(theirs);
    expect((await copy(u.id)).versions.map((v) => v.version)).toEqual(['0.8.0']);
  });

  it('writes its revision again over an older one that a stalled server put back meanwhile', async () => {
    const u = await tester('mirror-older');
    await recordVersion(u, { version: '0.8.0' });
    otherServerWrites(1, ['0.8.0']);
    const me = await recordVersion(u, { version: '0.8.1' });
    const doc = await copy(u.id);
    expect(doc.revision).toBe(2);
    expect(doc.versions.map((v) => v.version)).toEqual(['0.8.1', '0.8.0']);
    expect(me.podBehind).toBeUndefined();
  });

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
