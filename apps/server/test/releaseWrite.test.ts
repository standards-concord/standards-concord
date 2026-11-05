import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { findProject } from '../src/services/ontologies.js';
import { ontologyStore } from '../src/services/ontologyStore.js';
import { seedDemo } from '../src/services/simulation.js';

/**
 * Publishing checks, just before writing, that the working draft is still the one captured for the release.
 * When the store became async, that check was briefly an async callback: its throw arrived after the files were
 * written, so a release could carry a draft nobody approved. The check's type now refuses async functions.
 */
describe('the check made just before a release is written', () => {
  beforeAll(async () => {
    await openDb();
    await seedDemo();
  });

  it('writes nothing when it throws', async () => {
    const project = (await findProject('volunteering'))!;
    const graph = await ontologyStore.working(project);
    const head = ontologyStore.head(project);
    const dir = path.join(ontologyStore.dir(project), 'releases', '99.0.0');
    await expect(
      ontologyStore.writeRelease(project, '99.0.0', graph, { 'RELEASE_NOTES.md': 'x' }, 'x', { name: 'Test' }, () => {
        throw new Error('the draft changed');
      }),
    ).rejects.toThrow('the draft changed');
    expect(fs.existsSync(dir)).toBe(false);
    expect(ontologyStore.head(project)).toBe(head);
  });

  it('cannot be an async function, whose throw would come after the write', () => {
    const project = { slug: 'never-called' } as never;
    // Only typechecked, never run: `pnpm typecheck` fails if the parameter ever accepts a promise again.
    const _unused = () =>
      // @ts-expect-error an async check is refused
      ontologyStore.writeRelease(project, '0.0.0', undefined as never, {}, '', { name: 'x' }, async () => {
        throw new Error('too late');
      });
    expect(_unused).toBeTypeOf('function');
  });
});
