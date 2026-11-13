import { beforeAll, expect, it } from 'vitest';
import { openDb, put } from '../src/db.js';
import { createProject, summary } from '../src/services/ontologies.js';
import { createUseCase } from '../src/services/useCases.js';
import { createUser } from '../src/services/users.js';

beforeAll(async () => { await openDb(); });

it('counts only visible, non-withdrawn, non-archived use cases that say something towards first steps', async () => {
  const owner = await createUser({ name: 'Summary owner', provider: 'demo', subject: 'summary-owner' });
  const other = await createUser({ name: 'Summary author', provider: 'demo', subject: 'summary-author' });
  const p = await createProject({ title: 'Summary cases', prefix: 'sc', description: '' }, owner);
  const count = async () => (await summary(p, { withHealth: false, viewer: owner })).stats.activeUseCases;
  expect(await count()).toBe(0);
  const said = { sections: { goal: 'Find a shift to cover.' } };
  const privateCase = await createUseCase(p, other, { source: 'chat', visibility: 'private', ...said });
  expect(await count()).toBe(0);
  expect((await summary(p, { withHealth: false, viewer: other })).stats.activeUseCases).toBe(1);
  const shared = await createUseCase(p, other, { visibility: 'group', status: 'draft', ...said });
  expect(await count()).toBe(1);
  await put('useCases', { ...shared, status: 'archived' }, p.id);
  expect(await count()).toBe(0);
  await put('useCases', { ...privateCase, withdrawnAt: new Date().toISOString() }, p.id);
  expect((await summary(p, { withHealth: false, viewer: other })).stats.activeUseCases).toBe(0);
  // Starting an interview makes an empty draft at once. Leaving without saying anything used to tick
  // "Describe a use case" as done.
  await createUseCase(p, owner, { source: 'chat', visibility: 'private' });
  expect(await count()).toBe(0);
  await createUseCase(p, owner, { visibility: 'private', ...said });
  expect(await count()).toBe(1);
});
