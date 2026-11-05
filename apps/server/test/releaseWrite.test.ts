import { beforeAll, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { findProject } from '../src/services/ontologies.js';
import { ontologyStore } from '../src/services/ontologyStore.js';
import { seedDemo } from '../src/services/simulation.js';

/**
 * A release's own bookkeeping (`record`) runs inside the transaction that moves the working draft to the release
 * commit. When the store became async, a check made just before writing was briefly an async callback whose throw
 * arrived after the files were written, so a release could carry a draft nobody approved. With `record` awaited
 * inside the transaction, a refusal (sync, or after an await) means the draft never moves, so nothing is published.
 */
describe('a release refused by its own bookkeeping', () => {
  beforeAll(async () => {
    await openDb();
    await seedDemo();
  });

  it('writes nothing when it throws', async () => {
    const project = (await findProject('volunteering'))!;
    const graph = await ontologyStore.working(project);
    const head = await ontologyStore.head(project);
    await expect(
      ontologyStore.writeRelease(project, '99.0.0', graph, { 'RELEASE_NOTES.md': 'x' }, 'x', { name: 'Test' }, head, () => {
        throw new Error('the draft changed');
      }),
    ).rejects.toThrow('the draft changed');
    expect(await ontologyStore.readReleaseFile(project, '99.0.0', 'RELEASE_NOTES.md')).toBeUndefined();
    expect(await ontologyStore.versions(project)).not.toContain('99.0.0');
    expect(await ontologyStore.head(project)).toBe(head);
  });

  it('writes nothing when it throws after an await, too', async () => {
    const project = (await findProject('volunteering'))!;
    const graph = await ontologyStore.working(project);
    const head = await ontologyStore.head(project);
    await expect(
      ontologyStore.writeRelease(project, '99.0.1', graph, { 'RELEASE_NOTES.md': 'x' }, 'x', { name: 'Test' }, head, async () => {
        await new Promise((r) => setTimeout(r, 20));
        throw new Error('too late?');
      }),
    ).rejects.toThrow('too late?');
    expect(await ontologyStore.readReleaseFile(project, '99.0.1', 'RELEASE_NOTES.md')).toBeUndefined();
    expect(await ontologyStore.versions(project)).not.toContain('99.0.1');
    expect(await ontologyStore.head(project)).toBe(head);
  });
});
