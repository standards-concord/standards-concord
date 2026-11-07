import type { Meeting } from '@concord/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeDb, openDb, put } from '../src/db.js';
import { analyseMeeting, getMeeting, mutateMeeting } from '../src/services/meetings.js';
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
let other: { mutateMeeting: typeof mutateMeeting; closeDb: typeof closeDb };

beforeAll(async () => {
  if (pgUrl) await openDb({ kind: 'postgres', url: pgUrl, max: 4 });
  else await openDb();
  await seedDemo();
  vi.resetModules();
  const db = await import('../src/db.js');
  if (pgUrl) await db.openDb({ kind: 'postgres', url: pgUrl, max: 4 });
  else await db.openDb();
  other = { mutateMeeting: (await import('../src/services/meetings.js')).mutateMeeting, closeDb: db.closeDb };
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
});
