import { beforeAll, expect, it } from 'vitest';
import type { ChangeRequestStatus, OntologyProject } from '@concord/shared';
import { openDb, put } from '../src/db.js';
import { createProject, membersWithUsers, setRoles, summary } from '../src/services/ontologies.js';
import { createUser, logActivity } from '../src/services/users.js';
import { getUseCase, interviewTurn, startInterview, updateUseCase } from '../src/services/useCases.js';

beforeAll(async () => { await openDb(); });

it('counts submitted open requests, excluding drafts and every closed status', async () => {
  // The header counted drafts while the Overview said nothing was in progress.
  const p = { id: 'counted-ontology' } as OntologyProject;
  const statuses: ChangeRequestStatus[] = ['draft', 'triage', 'review', 'needs-work', 'voting', 'approved', 'merged', 'released', 'rejected', 'withdrawn'];
  for (const status of statuses) await put('changeRequests', { id: `cr-${status}`, ontologyId: p.id, status }, p.id);
  expect((await summary(p, { withGraph: false, withHealth: false })).stats.openChangeRequests).toBe(5);
});

it('derives the latest member activity without persisting a new member field', async () => {
  const id = 'active-ontology';
  const user = await createUser({ name: 'Active member', provider: 'demo', subject: id });
  await setRoles(id, user.id, ['member']);
  await logActivity({ ontologyId: id, actorId: user.id, type: 'cr.review', message: 'reviewed a change', at: '2026-11-09T12:00:00Z' });
  await logActivity({ ontologyId: id, actorId: user.id, type: 'cr.review', message: 'reviewed another change', at: '2026-11-08T12:00:00Z' });
  await logActivity({ ontologyId: 'another-ontology', actorId: user.id, type: 'cr.review', message: 'elsewhere', at: '2026-11-10T12:00:00Z' });
  expect(await membersWithUsers(id)).toMatchObject([{ userId: user.id, lastActiveAt: '2026-11-09T12:00:00Z' }]);
});

it('names a first interview answer and preserves a title on later answers and resumed interviews', async () => {
  // The offline interviewer used to truncate at 80 characters, in the middle of a word.
  const user = await createUser({ name: 'Title author', provider: 'demo', subject: 'interview-title' });
  const p = await createProject({ title: 'Interview title', description: 'Title regression', prefix: 'ititle' }, user);
  const s = await startInterview(p, user);
  const answer = 'Find volunteering opportunities for students who need accessible transport nearby. Then apply.';
  const first = await interviewTurn(s, user, answer);
  expect(first.useCase.sections.name).toBe('Find volunteering opportunities for students who need');
  const second = await interviewTurn(first.session, user, 'Students and schools.');
  expect(second.useCase.sections.name).toBe(first.useCase.sections.name);
  const u = await updateUseCase(await getUseCase(s.useCaseId), user, { sections: { name: 'A title chosen by the author' } });
  const resumed = await startInterview(p, user, u.id);
  expect((await interviewTurn(resumed, user, 'A new detail.')).useCase.sections.name).toBe('A title chosen by the author');
  const legacy = await startInterview(p, user);
  await updateUseCase(legacy.useCaseId, user, { sections: { name: `${user.name}'s use case` } });
  expect((await interviewTurn(legacy, user, 'Match students to shifts.')).useCase.sections.name).toBe('Match students to shifts');
});
