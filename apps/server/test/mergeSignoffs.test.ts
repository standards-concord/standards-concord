import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createApp, baselineRevision, reportAs, revisionOf, startRunAs } from '../src/services/appChecks.js';
import { addReview, createChangeRequest, detail, getCR, merge } from '../src/services/changeRequests.js';
import { createProject, removeMember, setRoles, updateProject } from '../src/services/ontologies.js';
import { createUser } from '../src/services/users.js';
import { createUseCase, crForViewer, withdrawUseCase } from '../src/services/useCases.js';

// Exercise the real merge and autopilot services without an HTTP listener, on either ontology store.
it.each(['human', 'autopilot'] as const)('records %s sign-offs at merge and keeps the name after the member leaves', async (mode) => {
  // Moving the draft used to erase autopilot sign-offs; removing members erased human sign-offs too.
  const person = (name: string) => createUser({ name, provider: 'demo', subject: randomUUID(), simulated: true });
  const owner = await person('History owner');
  const reviewer = await person(`Historical ${mode} approver`);
  const outsider = await person('Outside reader');
  const project = await createProject({ title: `Sign-off history ${randomUUID()}`, description: 'Record the decision.', prefix: 'history' }, owner);
  project.governance.requireValidation = false;
  project.governance.automation.autoDraftRelease = false;
  for (const rule of Object.values(project.governance.changes)) Object.assign(rule, {
    minApprovals: 1, reviewPeriodDays: 0, autoMerge: false, lazyConsensus: false, vote: undefined,
  });
  await updateProject(project);
  await setRoles(project.id, reviewer.id, ['reviewer']);
  const source = await createUseCase(project, owner, { status: 'triage', visibility: 'public', sections: { name: 'Sign-off source' } });
  const cr = await createChangeRequest(project, owner, {
    title: `Record a ${mode} sign-off`, description: 'Keep the decision after the merge.', kind: 'feature',
    origin: { type: 'chat', useCaseId: source.id }, submit: true,
    ops: [{ op: 'addClass', localName: 'Recorded', label: 'Recorded', definition: 'A recorded term.' }],
  });
  expect(cr.status).toBe('review');
  if (mode === 'autopilot') {
    const app = await createApp(project, reviewer, { name: 'Historical approver’s app', autopilot: { enabled: true } });
    const attempt = await startRunAs(app.id);
    await reportAs(app.id, { attempt, target: 'baseline', revision: await baselineRevision(project), outcome: 'passed' });
    const result = await reportAs(app.id, { attempt, target: cr.id, revision: await revisionOf(cr), outcome: 'passed' });
    expect(result).toMatchObject({ autopilot: { action: 'approved' } });
  } else {
    await addReview(await getCR(cr.id), reviewer, 'approve', undefined, cr.round);
  }
  const approved = await detail(await getCR(cr.id));
  expect(approved.status).toBe('approved');
  expect(approved.governance.approvedBy).toEqual([reviewer.id]);
  expect((await merge(await getCR(cr.id), owner)).status).toBe('merged');
  const record = [{ userId: reviewer.id, name: reviewer.name }];
  const merged = await detail(await getCR(cr.id));
  expect(merged.approvedAs?.approvers).toEqual(record);
  if (mode === 'autopilot') {
    expect(merged.revision).not.toBe(approved.revision);
    expect(merged.governance.approvedBy).toEqual([]);
  }
  await removeMember(project.id, reviewer.id);
  const afterDeparture = await detail(await getCR(cr.id));
  expect(afterDeparture.governance.approvedBy).toEqual([]);
  expect(afterDeparture.approvedAs?.approvers).toEqual(record);

  await withdrawUseCase(source, owner);
  const hidden = await crForViewer(merged, outsider);
  expect(hidden.withheld).toBe(true);
  expect(hidden.reviews).toEqual([]);
  expect(hidden.governance.approvedBy).toEqual([]);
  expect(hidden.governance.vetoedBy).toEqual([]);
  expect(hidden.approvedAs).toBeUndefined();
  expect(JSON.stringify(hidden)).not.toContain(reviewer.id);
  expect(JSON.stringify(hidden)).not.toContain(reviewer.name);
  expect((await crForViewer(merged, owner)).approvedAs?.approvers).toEqual(record);
  expect((await getCR(cr.id)).approvedAs?.approvers).toEqual(record);
});
