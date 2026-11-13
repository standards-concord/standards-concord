import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Release } from '@concord/shared';
import { get, list, openDb, put, remove } from '../src/db.js';
import { findProject } from '../src/services/ontologies.js';
import { ontologyStore } from '../src/services/ontologyStore.js';
import { seedDemo } from '../src/services/simulation.js';
import { publishedVersionIRI, projectVersionIRI } from '../src/services/releaseIri.js';
import { publishRelease } from '../src/services/releases.js';
import { createUser, getUser } from '../src/services/users.js';
import { createUseCase, getUseCase } from '../src/services/useCases.js';
import * as requirements from '../src/services/requirements.js';
import { pageInput } from '../src/public/routes.js';
import { renderOntologyPage } from '../src/public/render.js';

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

  it('reads historical identity from committed files when a release record lacks its IRI or published status', async () => {
    const project = (await findProject('volunteering'))!;
    const release = (await list<Release>('releases', project.id))[0];
    const expected = (await ontologyStore.at(project, release.version)).metadata().versionIRI;
    const { versionIRI: _iri, ...legacy } = release;
    try {
      await put('releases', legacy, project.id);
      expect(await publishedVersionIRI(project, release.version)).toBe(expected);
      await put('releases', { ...legacy, status: 'draft' }, project.id);
      expect(await publishedVersionIRI(project, release.version)).toBe(expected);
      await remove('releases', release.id);
      expect(await publishedVersionIRI(project, release.version)).toBe(expected);
    } finally { await put('releases', release, project.id); }
  });

  it('keeps ordinary public version links and validation examples at the served page URL', async () => {
    const project = (await findProject('volunteering'))!;
    const input = await pageInput(project, '1.0.0', 'https://concord.example');
    const html = renderOntologyPage(input);
    expect(html).toContain('<a href="https://concord.example/def/volunteering/1.0.0"><code>https://w3id.org/odi/volunteering/1.0.0</code></a>');
    expect(html).toContain('Closed in <a href="https://concord.example/def/volunteering/1.0.0">1.0.0</a>');
    expect(html).toContain('curl -X POST https://concord.example/def/volunteering/1.0.0');
  });

  it('reaches the final consent check with a legacy prior release and no requirements document', async () => {
    const project = (await findProject('volunteering'))!;
    const prior = (await list<Release>('releases', project.id))[0];
    const { versionIRI: _iri, ...legacy } = prior;
    const owner = (await getUser(project.ownerIds[0]))!;
    const author = await createUser({ name: 'Snapshot author', provider: 'demo', subject: 'legacy-snapshot-author' });
    const useCase = await createUseCase(project, author, { status: 'triage', visibility: 'public', sections: { name: 'Legacy snapshot consent' } });
    const release: Release = { ...prior, id: 'rel_legacy_consent', version: '1.0.1', versionIRI: projectVersionIRI(project, '1.0.1'), status: 'draft', changeRequestIds: [], notes: '', notesBy: owner.id };
    const prepare = vi.spyOn(requirements, 'prepareForRelease').mockResolvedValue(undefined);
    const write = ontologyStore.writeRelease.bind(ontologyStore);
    const commit = vi.spyOn(ontologyStore, 'writeRelease').mockImplementation(async (...args) => {
      expect(args[3]['USE_CASES.md']).toBeUndefined();
      expect(args[3]['requirements.json']).toContain('Legacy snapshot consent');
      await put('useCases', { ...(await getUseCase(useCase.id)), visibility: 'private' }, project.id);
      return write(...args);
    });
    try {
      await put('releases', legacy, project.id);
      await put('releases', release, project.id);
      await expect(publishRelease(release, owner)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('stopped being public') });
      expect(commit).toHaveBeenCalledOnce();
      expect((await get<Release>('releases', release.id))?.status).toBe('draft');
    } finally {
      prepare.mockRestore(); commit.mockRestore();
      await put('releases', prior, project.id);
      await remove('releases', release.id);
    }
  });
});
