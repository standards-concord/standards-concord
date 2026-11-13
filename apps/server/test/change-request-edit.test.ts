import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ChangeRequest, GovernancePolicy } from '@concord/shared';
import { createApp } from '../src/app.js';
import { openDb, put } from '../src/db.js';
import { getCR } from '../src/services/changeRequests.js';
import { seedDemo } from '../src/services/simulation.js';

const app = createApp();
let n = 0;
async function person(role: string) {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/demo').send({ name: `Hand edit ${role} ${++n}`, role });
  expect(res.status).toBe(200);
  return { agent, id: res.body.user.id as string };
}
async function setup() {
  const owner = await person('steward');
  const project = await owner.agent.post('/api/ontologies').send({ title: `Hand edits ${++n}`, prefix: `he${n}`, description: 'A standard for the hand edit tests.', governanceTemplate: 'steward-led' });
  expect(project.status).toBe(201);
  const policy = structuredClone(project.body.governance) as GovernancePolicy;
  policy.changes.minor = { ...policy.changes.minor, approverRoles: ['reviewer'], minApprovals: 2, reviewPeriodDays: 0, autoMerge: false, lazyConsensus: false, vote: undefined };
  policy.automation.autoDraftRelease = false;
  expect((await owner.agent.put(`/api/ontologies/${project.body.id}/governance`).send({ policy })).status).toBe(200);
  const author = await person('contributor');
  const created = await author.agent.post(`/api/ontologies/${project.body.id}/change-requests`).send({ title: 'Add a shift', description: 'Plan work.', kind: 'feature', ops: [{ op: 'addClass', localName: 'Shift', label: 'shift', definition: 'A period of scheduled work.' }] });
  expect(created.status).toBe(201);
  return { owner, author, cr: created.body as ChangeRequest, project: project.body };
}
beforeAll(async () => { openDb(); await seedDemo(); });

describe('direct hand edits', () => {
  // Plain PATCH used to discard basis, silently replacing edits saved since the page loaded.
  it('refuses a stale PATCH with the same 409 as a stale AI revision', async () => {
    const { author, cr } = await setup();
    const seen = (await author.agent.get(`/api/change-requests/${cr.id}`)).body;
    // This is the existing AI revision token, also computable from the page's loaded response.
    const basis = `${seen.opsUpdatedAt ?? seen.createdAt} ${JSON.stringify(seen.ops)}`;
    const first = await author.agent.patch(`/api/change-requests/${cr.id}`).send({ basis, ops: [{ ...cr.ops[0], definition: 'Work scheduled for a volunteer.' }] });
    expect(first.status).toBe(200);
    const stale = await author.agent.patch(`/api/change-requests/${cr.id}`).send({ basis, ops: cr.ops });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe('Someone changed the edits while they were being revised. Look at the latest edits and try again.');
    expect((await getCR(cr.id)).ops).toEqual(first.body.ops);
  });

  it('title and reason edits keep the round and the earlier approval', async () => {
    const { owner, author, cr, project } = await setup();
    const reviewer = await person('reviewer');
    await owner.agent.put(`/api/ontologies/${project.id}/members/${reviewer.id}`).send({ roles: ['reviewer'] });
    const submitted = await author.agent.post(`/api/change-requests/${cr.id}/submit`);
    const approved = await reviewer.agent.post(`/api/change-requests/${cr.id}/reviews`).send({ decision: 'approve', round: submitted.body.round });
    expect(approved.status).toBe(200);
    const edited = await author.agent.patch(`/api/change-requests/${cr.id}`).send({ title: 'Add volunteer shifts', description: 'Plan volunteer work.' });
    expect(edited.status).toBe(200);
    expect(edited.body.round).toBe(approved.body.round);
    expect(edited.body.editsVersion).toBe(approved.body.editsVersion);
    expect(edited.body.governance.approvals).toBe(1);
    expect(edited.body.reviews[0].stale).toBe(false);
  });

  it.each(['editor', 'steward', 'owner'])('%s can PATCH another author’s edits and is no longer an independent approver', async (role) => {
    const { owner, author, cr, project } = await setup();
    const editor = await person('reviewer');
    await owner.agent.put(`/api/ontologies/${project.id}/members/${editor.id}`).send({ roles: [role, 'reviewer'] });
    const changed = await editor.agent.patch(`/api/change-requests/${cr.id}`).send({ ops: [{ ...cr.ops[0], definition: 'A scheduled volunteering period.' }] });
    expect(changed.status).toBe(200);
    expect(changed.body.revisedBy).toContain(editor.id);
    const submitted = await author.agent.post(`/api/change-requests/${cr.id}/submit`);
    const approved = await editor.agent.post(`/api/change-requests/${cr.id}/reviews`).send({ decision: 'approve', round: submitted.body.round });
    expect(approved.body.governance.approvals).toBe(0);
  });

  it.each(['contributor', 'reviewer'])('a non-author %s cannot PATCH', async (role) => {
    const { owner, cr, project } = await setup();
    const other = await person(role);
    await owner.agent.put(`/api/ontologies/${project.id}/members/${other.id}`).send({ roles: [role] });
    expect((await other.agent.patch(`/api/change-requests/${cr.id}`).send({ title: 'Not allowed', ops: [] })).status).toBe(403);
    expect((await request(app).patch(`/api/change-requests/${cr.id}`).send({ title: 'Signed out' })).status).toBe(401);
  });

  it.each(['merged', 'released', 'rejected', 'withdrawn'] as const)('refuses PATCH on a %s request', async (status) => {
    const { owner, author, cr } = await setup();
    // Isolate state guards from the merge/release workflows, covered in their own suites.
    await put('changeRequests', { ...await getCR(cr.id), status }, cr.ontologyId);
    for (const p of [owner, author]) expect((await p.agent.patch(`/api/change-requests/${cr.id}`).send({ title: 'Too late', ops: [] })).status).toBe(409);
  });

  it.each(['title', 'ops'] as const)('PATCH changing %s clears approval for publication', async (field) => {
    const { author, cr } = await setup();
    await put('changeRequests', { ...await getCR(cr.id), privacyCleared: { by: author.id, at: cr.createdAt, fingerprint: 'approved', title: cr.title, kgcl: [] } }, cr.ontologyId);
    const edited = await author.agent.patch(`/api/change-requests/${cr.id}`).send(field === 'title' ? { title: 'Retitled shifts' } : { ops: [{ ...cr.ops[0], definition: 'A period of volunteering.' }] });
    expect(edited.status).toBe(200);
    expect((await getCR(cr.id)).privacyCleared).toBeUndefined();
  });
});
