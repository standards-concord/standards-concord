import type { Meeting } from '@concord/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeDb, openDb, put } from '../src/db.js';
import { advanceSimulation, analyseMeeting, getMeeting, mutateMeeting, SIMULATED_CALL } from '../src/services/meetings.js';
import { findProject } from '../src/services/ontologies.js';
import { seedDemo } from '../src/services/simulation.js';

/**
 * Changes to one meeting from two servers at once (step 5). The meeting lock was a lock in one process, so on
 * Vercel two function instances could both read a meeting, change it and write it back, and one change was lost.
 *
 * The second "server" is a fresh copy of the modules (its own locks), on the same database. With
 * TEST_DATABASE_URL both are on a real Postgres, on separate connections.
 */
const pgUrl = process.env.TEST_DATABASE_URL;
let other: { mutateMeeting: typeof mutateMeeting; advanceSimulation: typeof advanceSimulation; closeDb: typeof closeDb };

beforeAll(async () => {
  if (pgUrl) await openDb({ kind: 'postgres', url: pgUrl, max: 4 });
  else await openDb();
  await seedDemo();
  vi.resetModules();
  const db = await import('../src/db.js');
  if (pgUrl) await db.openDb({ kind: 'postgres', url: pgUrl, max: 4 });
  else await db.openDb();
  const meetings = await import('../src/services/meetings.js');
  other = { mutateMeeting: meetings.mutateMeeting, advanceSimulation: meetings.advanceSimulation, closeDb: db.closeDb };
});
afterAll(async () => {
  await other?.closeDb();
  if (pgUrl) await closeDb();
});

let n = 0;
async function meeting(extra: Partial<Meeting>) {
  const ontologyId = (await findProject('volunteering'))!.id;
  const m = {
    id: `instances-${Date.now()}-${++n}`,
    ontologyId,
    title: 'Two servers',
    source: 'upload',
    transcript: [{ speaker: 'Mei Chen', text: 'Which volunteers gave how many hours last quarter?' }],
    facilitatorPrompts: [],
    createdBy: 'test',
    createdAt: new Date().toISOString(),
    ...extra,
  } as Meeting;
  await put('meetings', m, m.ontologyId);
  return m;
}

describe('a meeting changed on two servers at once', () => {
  it('keeps every change', async () => {
    const { id } = await meeting({ status: 'live' });
    const servers = [mutateMeeting, other.mutateMeeting];
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        servers[i % 2](id, (x) => {
          x.transcript.push({ speaker: `server ${i % 2}`, text: `line ${i}` });
        }),
      ),
    );
    expect((await getMeeting(id)).transcript).toHaveLength(21);
  });
});

describe('analysing a call on several servers', () => {
  // "Processing" was the only mark, and only one process remembered who was analysing: a second server analysed
  // the call again, and a server that died mid-analysis left it "processing" for good.
  it('leaves a call to the server already analysing it', async () => {
    const m = await meeting({ status: 'processing', analysisClaim: { token: 'another-server', until: Date.now() + 60_000 } });
    const out = await analyseMeeting(m);
    expect(out.status).toBe('processing');
    expect(out.analysis).toBeUndefined();
    expect((await getMeeting(m.id)).analysisClaim?.token).toBe('another-server');
  });

  it('takes over an analysis whose server stopped, and saves only its own result', async () => {
    const m = await meeting({ status: 'processing', analysisClaim: { token: 'gone', until: Date.now() - 1 } });
    const out = await analyseMeeting(m);
    expect(out.status).toBe('analysed');
    expect(out.analysis?.competencyQuestions.length).toBeGreaterThan(0);
    expect(out.analysisClaim).toBeUndefined();
  });

  // Review r1 of step 5: a takeover only happened if someone asked for the analysis again, and the page keeps its
  // analyse button off while a call is "processing", so a call whose analysing instance died stayed stuck.
  // Reading the call now starts it again (the page polls while it shows "processing").
  it('starts a stuck analysis again when the call is read, and leaves one still running alone', async () => {
    const { recoverAnalysis } = await import('../src/services/meetings.js');
    const running = await meeting({ status: 'processing', analysisClaim: { token: 'another-server', until: Date.now() + 60_000 } });
    recoverAnalysis(await getMeeting(running.id));
    const stuck = await meeting({ status: 'processing', analysisClaim: { token: 'gone', until: Date.now() - 1 } });
    recoverAnalysis(await getMeeting(stuck.id));
    await expect.poll(async () => (await getMeeting(stuck.id)).status, { timeout: 5000 }).toBe('analysed');
    expect((await getMeeting(running.id))).toMatchObject({ status: 'processing', analysisClaim: { token: 'another-server' } });
  });
});

describe('a simulated call on several servers', () => {
  // The replay was a loop in the process that started it, so on Vercel, where an instance may stop once it has
  // answered, the call stopped mid-way and stayed "live". Its progress is now on the record, carried on by
  // whichever server is asked, each line exactly once.
  it('is carried on by any server, each line once and in order, and ends analysed', async () => {
    const m = await meeting({ source: 'simulation', status: 'live', transcript: [], bot: { provider: 'simulated', status: 'in-call' }, simulation: { startedAt: Date.now() - 60_000, delayMs: 1, next: 0 } });
    await Promise.all([advanceSimulation(m.id), other.advanceSimulation(m.id), advanceSimulation(m.id)]);
    for (let i = 0; i < 100 && (await getMeeting(m.id)).status !== 'analysed'; i++) await new Promise((r) => setTimeout(r, 20));
    const done = await getMeeting(m.id);
    expect(done.transcript.map((l) => l.text)).toEqual(SIMULATED_CALL.map((l) => l.text));
    expect(done).toMatchObject({ status: 'analysed', bot: { status: 'done' }, simulation: { finished: true } });
  });

  it('adds only the lines whose time has come', async () => {
    const m = await meeting({ source: 'simulation', status: 'live', transcript: [], bot: { provider: 'simulated', status: 'in-call' }, simulation: { startedAt: Date.now() - 3 * 60_000 - 1000, delayMs: 60_000, next: 0 } });
    expect(await other.advanceSimulation(m.id)).toBe(true);
    expect((await getMeeting(m.id)).transcript).toHaveLength(3);
  });
});
