import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { openDb } from '../src/db.js';
import { clock } from '../src/clock.js';
import { createUser } from '../src/services/users.js';
import { createProject } from '../src/services/ontologies.js';
import { createChangeRequest, getCR, updateOps } from '../src/services/changeRequests.js';

beforeAll(() => { openDb(); });
afterEach(() => vi.restoreAllMocks());

// A browser/API regression also covers this, but their HTTP listeners are blocked in the build sandbox.
// Plain updateOps used to drop basis, overwriting edits saved since the page loaded.
it('a stale hand edit cannot overwrite a newer edit, even with the same simulated timestamp', async () => {
  vi.spyOn(clock, 'iso').mockReturnValue(clock.iso());
  const author = await createUser({ name: 'Hand edit service author', provider: 'github', subject: 'hand-edit-service' });
  const project = await createProject({ title: 'Hand edit service', description: 'Check concurrent edits.', prefix: 'hes', governanceTemplate: 'steward-led' }, author);
  const cr = await createChangeRequest(project, author, { title: 'Add a shift', description: '', kind: 'feature', origin: { type: 'direct' }, ops: [{ op: 'addClass', localName: 'Shift', label: 'shift', definition: 'A period of work.' }] });
  const basis = `${cr.opsUpdatedAt ?? cr.createdAt} ${JSON.stringify(cr.ops)}`;
  const op = cr.ops[0];
  if (op.op !== 'addClass') throw new Error('Expected a drafted class');
  const current = await updateOps(await getCR(cr.id), author, { ops: [{ ...op, definition: 'A scheduled period of work.' }] });
  // Pass through the public PATCH input, as the route does.
  const stale = { ops: cr.ops, basis };
  await expect(updateOps(await getCR(cr.id), author, stale)).rejects.toMatchObject({ status: 409, message: 'Someone changed the edits while they were being revised. Look at the latest edits and try again.' });
  expect((await getCR(cr.id)).ops).toEqual(current.ops);
});
