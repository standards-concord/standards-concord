import type { ChangeRequest, OntologyProject, Release, Review, User, Vote } from '@concord/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import { closeDb, get, list, openDb, put, remove } from '../src/db.js';
import { PAGE_GENERATOR } from '../src/public/render.js';
import { refreshReleasePages } from '../src/public/routes.js';
import { type DemoCopy, LEGACY_DEMO_COPY, refreshDemoCopy } from '../src/services/demoCopy.js';
import { createProject } from '../src/services/ontologies.js';
import { ontologyStore } from '../src/services/ontologyStore.js';
import { PERSONAS } from '../src/services/personas.js';
import { DEMO_REVIEW_COMMENT } from '../src/services/simulation.js';
import { createUser } from '../src/services/users.js';
import { defaultStartupTasks, runStartupTasks } from '../src/startup.js';

// Startup runs before the UI can reach this bug: old persisted demo wording survived every deployment.
const pgUrl = process.env.TEST_DATABASE_URL;
beforeAll(async () => {
  await openDb(pgUrl ? { kind: 'postgres', url: pgUrl, max: 4 } : undefined);
});
afterAll(() => closeDb());

// Stand-ins for the retired wording, so a failing assertion never prints that wording in a public CI log.
const copy: DemoCopy = {
  description: { from: ' One of the retired launch standards.', to: '' },
  readme: { from: 'Managed on the retired platform with Concord.', to: 'Managed with Concord.' },
  comment: { from: 'Checked against the retired quality bar.', to: DEMO_REVIEW_COMMENT },
};
const refresh = () => refreshDemoCopy(copy);
const description = 'An owner’s description.';
const oldDescription = description + copy.description.from;
const oldReadme = `# Demo\n\n${oldDescription}\n\n${copy.readme.from}\n\nOwner’s extra notes.\n`;
const newReadme = `# Demo\n\n${description}\n\n${copy.readme.to}\n\nOwner’s extra notes.\n`;
let n = 0;
async function project(owner: User, demo: boolean, desc = oldDescription, legacy = copy) {
  const p = await createProject({
    title: `Demo copy ${++n}`, description: desc, prefix: 'ex', demo,
    // The real demo uses a supplied ontology, whose metadata has its own description.
    seedTurtle: '@prefix owl: <http://www.w3.org/2002/07/owl#> . <urn:demo:> a owl:Ontology .',
  }, owner);
  const readme = legacy === copy ? oldReadme : `# Demo\n\n${desc}\n\n${legacy.readme.from}\n`;
  await ontologyStore.updateRepoFile(p, 'README.md', readme, 'Seed legacy demo wording');
  return p;
}

function change(p: OntologyProject, actor: User): ChangeRequest {
  return {
    id: `copy-cr-${++n}`, ontologyId: p.id, number: n, title: 'A proposal', description: 'Kept.',
    kind: 'editorial', origin: { type: 'direct' }, status: 'review', authorId: actor.id,
    ops: [], createdAt: actor.createdAt, updatedAt: actor.createdAt,
    statusSince: actor.createdAt,
    timeline: [
      { at: actor.createdAt, actorId: actor.id, type: 'comment', message: `commented: “${copy.comment.from}”` },
      { at: actor.createdAt, actorId: actor.id, type: 'vote', message: `voted abstain: “${copy.comment.from}”` },
    ],
  };
}

async function comments(p: OntologyProject, actor: User, comment = copy.comment.from) {
  const cr = change(p, actor);
  const review: Review = { id: `copy-review-${++n}`, changeRequestId: cr.id, userId: actor.id, roles: ['reviewer'], decision: 'comment', comment, at: actor.createdAt };
  const vote: Vote = { id: `copy-vote-${++n}`, subjectType: 'change-request', subjectId: cr.id, userId: actor.id, roles: ['reviewer'], choice: 'abstain', comment, at: actor.createdAt };
  if (comment !== copy.comment.from) cr.timeline = [{ at: actor.createdAt, actorId: actor.id, type: 'comment', message: `commented: “${comment}”` }];
  await put('changeRequests', cr, p.id);
  await put('reviews', review, cr.id);
  await put('votes', vote, cr.id);
  return { cr, review, vote };
}

describe('refreshing persisted demo copy', () => {
  it('updates only demo records, preserves history, and changes nothing on a second run', async () => {
    const people = await Promise.all(PERSONAS.map((p) => createUser({
      name: p.name, simulated: true, provider: 'demo', subject: `persona:${p.key}`,
      persona: p.key === 'priya' || p.key === 'daniel' ? `An older description of ${p.name}.` : p.persona,
    })));
    const priya = people[0];
    const daniel = people.find((u) => u.name === 'Daniel Brooks')!;
    const real = await createUser({ name: priya.name, provider: 'demo', subject: 'persona:priya', persona: 'An older description of Priya.' });
    const unknown = await createUser({ name: 'Another simulation', simulated: true, provider: 'demo', subject: 'persona:unknown', persona: 'An older description of Daniel.' });
    const demo = await project(priya, true);
    const other = await project(real, false);
    const edited = await project(priya, true, `${oldDescription} Owner added a sentence.`);
    const simulated = await comments(demo, daniel);
    const realComment = await comments(demo, real);
    const otherComment = await comments(other, daniel);
    const similarComment = await comments(demo, daniel, `${copy.comment.from} Extra detail.`);
    const oldHead = await ontologyStore.head(demo);
    const turtle = await ontologyStore.readWorkingText(demo);

    expect(await refresh()).toMatchObject({ personas: 2, descriptions: 1, readmes: 2, reviews: 1, votes: 1, timeline: 2 });
    for (const [i, p] of PERSONAS.entries()) expect((await get<User>('users', people[i].id))?.persona).toBe(p.persona);
    expect(await get('users', real.id)).toEqual(real);
    expect(await get('users', unknown.id)).toEqual(unknown);
    expect((await get<OntologyProject>('ontologies', demo.id))?.description).toBe(description);
    expect(await get('ontologies', other.id)).toEqual(other);
    expect(await get('ontologies', edited.id)).toEqual(edited);
    expect(await ontologyStore.readRepoFile(demo, 'README.md')).toBe(newReadme);
    expect(await ontologyStore.readRepoFile(other, 'README.md')).toBe(oldReadme);
    expect(await ontologyStore.readRepoFile(demo, 'README.md', oldHead)).toBe(oldReadme);
    expect(await ontologyStore.readWorkingText(demo)).toBe(turtle);
    expect((await ontologyStore.commitOf(demo, await ontologyStore.head(demo))).parent).toBe(oldHead);
    expect((await get<Review>('reviews', simulated.review.id))?.comment).toBe(copy.comment.to);
    expect((await get<Vote>('votes', simulated.vote.id))?.comment).toBe(copy.comment.to);
    expect((await get<ChangeRequest>('changeRequests', simulated.cr.id))?.timeline.map((e) => e.message)).toEqual([
      `commented: “${copy.comment.to}”`, `voted abstain: “${copy.comment.to}”`,
    ]);
    for (const kept of [realComment, otherComment, similarComment]) {
      expect(await get('reviews', kept.review.id)).toEqual(kept.review);
      expect(await get('votes', kept.vote.id)).toEqual(kept.vote);
      expect(await get('changeRequests', kept.cr.id)).toEqual(kept.cr);
    }
    const head = await ontologyStore.head(demo);
    const records = await list('ontologies');
    // The shared per-worker database may hold demo ontologies from other test files whose repositories are gone.
    expect(await refresh()).toEqual({ personas: 0, descriptions: 0, readmes: 0, reviews: 0, votes: 0, timeline: 0, releasePages: 0, unreadable: expect.any(Number) });
    expect(await ontologyStore.head(demo)).toBe(head);
    expect(await list('ontologies')).toEqual(records);
  });

  it('has the release-pages task re-render demo release pages that embed the old description, and no others', async () => {
    const owner = await createUser({ name: 'Release owner', provider: 'demo', subject: 'copy-release-owner' });
    const demo = await project(owner, true, description);
    const other = await project(owner, false);
    const snapshot = '{"useCases":[]}\n';
    const oldPage = `<p>${oldDescription}</p>`;
    const releases: Release[] = [];
    for (const p of [demo, other]) {
      const commit = await ontologyStore.writeRelease(p, '1.0.0', await ontologyStore.working(p), { 'index.html': oldPage, 'requirements.json': snapshot, 'examples.json': '[]\n' }, 'First release', { name: 'Concord' });
      const release: Release = {
        id: `copy-release-${++n}`, ontologyId: p.id, version: '1.0.0', versionIRI: `${p.ontologyIRI}/1.0.0`,
        level: 'minor', status: 'published', notes: 'First release', changeRequestIds: [], commit,
        createdAt: owner.createdAt, createdBy: owner.id, statusSince: owner.createdAt, publishedAt: owner.createdAt,
      };
      await put('releases', release, p.id);
      releases.push(release);
    }
    // An ontology whose repository is gone (in CI: one left in the shared per-worker database by an earlier test file,
    // whose data directory was removed) used to make refreshReleasePages throw before reaching any other ontology.
    await put('ontologies', { ...other, id: `copy-missing-${++n}`, slug: `copy-missing-${n}`, demo: false });
    // Both ontologies' pages count as written by the current renderer, so only a stale mark re-renders one.
    const pages = (await get<{ id: string; state: Record<string, string> }>('kv', 'public-pages'))?.state ?? {};
    await put('kv', { id: 'public-pages', state: { ...pages, [demo.slug]: PAGE_GENERATOR, [other.slug]: PAGE_GENERATOR } });

    // An earlier start-up may already have recorded release-pages as done for this version.
    await put('kv', { id: 'startup:release-pages', appVersion: 'test', deployment: 'test', at: owner.createdAt });
    expect((await refresh()).releasePages).toBe(1);
    expect(await get('kv', 'startup:release-pages')).toBeUndefined();
    // demo-copy itself writes no release files: the release-pages task (which runs after it) does.
    expect(await ontologyStore.readReleaseFile(demo, '1.0.0', 'index.html')).toBe(oldPage);
    await refreshReleasePages();
    const html = await ontologyStore.readReleaseFile(demo, '1.0.0', 'index.html');
    expect(html).toContain('An owner');
    expect(html).not.toContain(copy.description.from);
    expect(await ontologyStore.readReleaseFile(other, '1.0.0', 'index.html')).toBe(oldPage);
    expect(await ontologyStore.readReleaseFile(demo, '1.0.0', 'requirements.json')).toBe(snapshot);
    expect(await ontologyStore.readReleaseFile(demo, '1.0.0', 'examples.json')).toBe('[]\n');
    for (const r of releases) expect(await get('releases', r.id)).toEqual(r);
    expect((await refresh()).releasePages).toBe(0);
  });

  it('registers the task after the seed and serialises concurrent startup instances', async () => {
    const tasks = await defaultStartupTasks();
    const copyTask = tasks.find((t) => t.name === 'demo-copy');
    expect(copyTask).toBeDefined();
    expect(tasks.findIndex((t) => t.name === 'demo-copy')).toBeGreaterThan(tasks.findIndex((t) => t.name === 'demo-seed'));
    // release-pages re-renders what demo-copy marks stale, so it must run after it.
    expect(tasks.findIndex((t) => t.name === 'release-pages')).toBeGreaterThan(tasks.findIndex((t) => t.name === 'demo-copy'));
    const owner = await createUser({ name: 'Concurrency owner', provider: 'demo', subject: 'copy-concurrency-owner' });
    // The task repairs the real retired wording; compare without printing it.
    const demo = await project(owner, true, description + LEGACY_DEMO_COPY.description.from, LEGACY_DEMO_COPY);
    const head = await ontologyStore.head(demo);
    // An earlier run on the same database (CI runs the server tests twice, once per ontology store) recorded the task as done.
    await remove('kv', 'startup:demo-copy');
    await Promise.all([runStartupTasks([copyTask!], { appVersion: '0.48.1' }), runStartupTasks([copyTask!], { appVersion: '0.48.1' })]);
    const stored = await get<OntologyProject>('ontologies', demo.id);
    expect(stored?.description === description, 'the description still ends with the retired sentence').toBe(true);
    const readme = await ontologyStore.readRepoFile(demo, 'README.md');
    expect(readme === `# Demo\n\n${description}\n\n${LEGACY_DEMO_COPY.readme.to}\n`, 'the README still has the retired wording').toBe(true);
    expect((await ontologyStore.commitOf(demo, await ontologyStore.head(demo))).parent).toBe(head);
    expect(await runStartupTasks([copyTask!], { appVersion: '0.48.1' })).toEqual([]);
  });

  it('retries a partial repair without overwriting a concurrent README edit', async () => {
    const owner = await createUser({ name: 'README owner', provider: 'demo', subject: 'copy-readme-owner' });
    const demo = await project(owner, true);
    const read = ontologyStore.readRepoFile.bind(ontologyStore);
    const ownerReadme = '# Owner’s replacement\n';
    const spy = vi.spyOn(ontologyStore, 'readRepoFile').mockImplementation(async (...args) => {
      const content = await read(...args);
      if (args[0].slug === demo.slug) {
        spy.mockRestore();
        await ontologyStore.updateRepoFile(demo, 'README.md', ownerReadme, 'Owner edits README');
      }
      return content;
    });
    try {
      await expect(refresh()).rejects.toMatchObject({ status: 409 });
    } finally {
      spy.mockRestore();
    }
    expect((await get<OntologyProject>('ontologies', demo.id))?.description).toBe(description);
    expect(await ontologyStore.readRepoFile(demo, 'README.md')).toBe(ownerReadme);
    const head = await ontologyStore.head(demo);
    expect((await refresh()).readmes).toBe(0);
    expect(await ontologyStore.head(demo)).toBe(head);
  });

  it('keeps repairing other demo ontologies when one demo ontology’s repository can’t be read', async () => {
    // In CI the database-backed store run reused demo ontologies the git-store run left behind; reading the first
    // one's README threw, so no demo ontology after it was repaired and the start-up task failed every time.
    const owner = await createUser({ name: 'Unreadable owner', provider: 'demo', subject: 'copy-unreadable-owner' });
    const template = await project(owner, false, description);
    const missing = { ...template, id: `copy-unreadable-${++n}`, slug: `copy-unreadable-${n}`, demo: true, description: oldDescription };
    await put('ontologies', missing);
    const demo = await project(owner, true);
    const counts = await refresh();
    expect(counts.unreadable).toBeGreaterThanOrEqual(1);
    expect((await get<OntologyProject>('ontologies', demo.id))?.description).toBe(description);
    expect(await ontologyStore.readRepoFile(demo, 'README.md')).toBe(newReadme);
    // Its database record is still repaired; its README waits for a run that can read it.
    expect((await get<OntologyProject>('ontologies', missing.id))?.description).toBe(description);
  });

  it('does not register a copy refresh outside demo mode', async () => {
    const demoMode = config.demoMode;
    config.demoMode = false;
    try {
      expect((await defaultStartupTasks()).map((t) => t.name)).not.toContain('demo-copy');
    } finally {
      config.demoMode = demoMode;
    }
  });
});
