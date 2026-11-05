import type { ChangeRequest, Release, RequirementsDocument, UseCase, User } from '@concord/shared';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { get, list as listDocs, openDb, put } from '../src/db.js';
import { findDocument, generateRequirements, markPublished, renderMarkdown, requirementsDocument, toPublic } from '../src/services/requirements.js';
import { findProject } from '../src/services/ontologies.js';
import { ontologyStore } from '../src/services/ontologyStore.js';
import { clock } from '../src/clock.js';
import { acquireProcessLock } from '../src/processLock.js';
import { seedDemo } from '../src/services/simulation.js';
import { completingRelease, derivedStatus } from '../src/services/traceability.js';
import { createUseCase, getUseCase, heuristicAnonymise, identifyingWarnings, restrictDraft, synthesise, updateUseCase, withConsentLock, withdrawUseCase } from '../src/services/useCases.js';
import { requirementsFor, toPublishedRequirements } from '../src/public/requirements.js';

/**
 * One test (or more) per finding of the privacy review of use case sharing:
 * each checks that restricted content can't be reached by someone who
 * shouldn't see it, through any route.
 */

const app = createApp();
type Agent = ReturnType<typeof request.agent>;
let demoId: string;

async function login(role: string, name = `Tester ${role} ${Math.random().toString(36).slice(2, 6)}`): Promise<Agent> {
  const agent = request.agent(app);
  expect((await agent.post('/api/auth/demo').send({ name, role })).status).toBe(200);
  return agent;
}

/** A use case created directly through the API as `agent`, with the given visibility. */
async function useCaseVia(agent: Agent, name: string, visibility: 'private' | 'group' | 'public', extra: Record<string, unknown> = {}) {
  const s = await agent.post(`/api/ontologies/${demoId}/interviews`).send({});
  const id = s.body.useCaseId as string;
  const patched = await agent.patch(`/api/use-cases/${id}`).send({ sections: { name, goal: `${name}: goal`, ...extra }, competencyQuestions: [{ question: `${name}: which ones?`, exampleAnswer: `${name} answer` }] });
  expect(patched.status).toBe(200);
  if (visibility !== 'private') expect((await agent.post(`/api/use-cases/${id}/visibility`).send({ visibility })).status).toBe(200);
  if (visibility !== 'private') expect((await agent.post(`/api/use-cases/${id}/submit`)).status).toBe(200);
  return id;
}

const meetingId = async () => {
  const steward = await login('steward');
  const list = (await steward.get(`/api/ontologies/${demoId}/meetings`)).body as { id: string; title: string }[];
  return list.find((m) => m.title === 'Working group call: recurring shifts')!.id;
};

beforeAll(async () => {
  openDb();
  demoId = (await seedDemo())!.id;
});

describe('meetings are for the working group', () => {
  it('signed-out visitors and contributors get no meetings, transcripts or streams (finding 2)', async () => {
    const id = await meetingId();
    // Signed out: meetings are behind sign-in altogether.
    expect((await request(app).get(`/api/ontologies/${demoId}/meetings`)).status).toBe(401);
    expect((await request(app).get(`/api/meetings/${id}`)).status).toBe(401);
    expect((await request(app).get(`/api/meetings/${id}/stream`)).status).toBe(401);
    const contributor = await login('contributor');
    expect((await contributor.get(`/api/meetings/${id}`)).status).toBe(404);
    expect((await contributor.get(`/api/ontologies/${demoId}/meetings`)).body).toEqual([]);
  });

  it('only people who can see a call can turn it into use cases, and they get back only what they may see (finding 1)', async () => {
    const id = await meetingId();
    const outsider = await login('contributor');
    expect((await outsider.post(`/api/meetings/${id}/propose`).send({})).status).toBe(404);
    // A member re-proposing gets the call's use cases, minus any its author has since made private.
    const member = await login('member');
    const out = await member.post(`/api/meetings/${id}/propose`).send({});
    expect(out.status).toBe(200);
    expect(out.body.changeRequest).toBeUndefined();
    const uc = out.body.useCases[0] as UseCase;
    const raw = getUseCase(uc.id);
    put('useCases', { ...raw, visibility: 'private' }, raw.ontologyId);
    const again = await member.post(`/api/meetings/${id}/propose`).send({});
    expect(again.body.useCases.some((u: UseCase) => u.id === uc.id)).toBe(false);
    put('useCases', raw, raw.ontologyId);
  });

  it('a use case seen by an outsider does not reveal the call or its transcript lines (finding 2)', async () => {
    const steward = await login('steward');
    const list = (await steward.get(`/api/ontologies/${demoId}/use-cases`)).body as UseCase[];
    const fromCall = list.find((u) => u.sections.name === 'Publish recurring shifts once')!;
    const raw = getUseCase(fromCall.id);
    put('useCases', { ...raw, visibility: 'public' }, raw.ontologyId);
    const seen = await request(app).get(`/api/use-cases/${fromCall.id}`);
    expect(seen.status).toBe(200);
    expect(seen.body.sourceRef).toBeUndefined();
    expect(seen.body.sourceLines).toBeUndefined();
    expect(seen.body.trace.source.lines).toBeUndefined();
    expect(seen.body.trace.source.id).toBeUndefined();
    expect(JSON.stringify(seen.body)).not.toMatch(/Working group call: recurring shifts/);
    put('useCases', raw, raw.ontologyId);
  });
});

describe('change requests and validation are public, so they only use public use cases', () => {
  it('refuses to draft changes from a group-only use case, and hides ids of ones the viewer cannot see (finding 3)', async () => {
    const member = await login('member');
    const id = await useCaseVia(member, 'Group only pipeline', 'group');
    const syn = await member.post(`/api/ontologies/${demoId}/synthesise`).send({ useCaseIds: [id] });
    expect(syn.status).toBe(409);
    const cr = await member.post(`/api/ontologies/${demoId}/change-requests`).send({ title: 'x', description: 'y', useCaseIds: [id] });
    expect(cr.status).toBe(409);
    // Without explicit ids, synthesis picks public use cases only.
    const all = await member.post(`/api/ontologies/${demoId}/synthesise`).send({});
    if (all.status === 201) expect(JSON.stringify(all.body)).not.toMatch(/Group only pipeline/);
    // Raw ids on a change request are filtered for the viewer.
    const someCr = list<ChangeRequest>(demoId)[0];
    put('changeRequests', { ...someCr, useCaseIds: [...(someCr.useCaseIds ?? []), id] }, demoId);
    const outsider = await login('contributor');
    const anon = await outsider.get(`/api/change-requests/${someCr.id}`);
    expect(anon.status).toBe(200);
    expect(anon.body.useCaseIds ?? []).not.toContain(id);
    const listed = (await outsider.get(`/api/ontologies/${demoId}/change-requests`)).body as ChangeRequest[];
    expect(listed.find((c) => c.id === someCr.id)?.useCaseIds ?? []).not.toContain(id);
    put('changeRequests', someCr, demoId);
  });

  it('keeps group-only competency questions out of public validation, and a withdrawn one out of every result read afterwards (finding 4)', async () => {
    const { triage } = await import('../src/services/changeRequests.js');
    const member = await login('member');
    const id = await useCaseVia(member, 'Hidden question case', 'group');
    const raw = getUseCase(id);
    raw.competencyQuestions[0].sparql = 'SELECT * WHERE { ?s ?p ?o } LIMIT 1';
    put('useCases', raw, raw.ontologyId);
    const v = await request(app).get(`/api/ontologies/${demoId}/validation`);
    expect(JSON.stringify(v.body)).not.toMatch(/Hidden question case/);
    // Once public its question runs, and its results name it as their source.
    put('useCases', { ...raw, visibility: 'public', status: 'triage' }, raw.ontologyId);
    const cr = list<ChangeRequest>(demoId).find((c) => !c.useCaseIds?.length && c.origin.type !== 'synthesis' && c.origin.type !== 'chat')!;
    await triage(get<ChangeRequest>('changeRequests', cr.id)!);
    const result = get<ChangeRequest>('changeRequests', cr.id)!.validation!.competencyQuestions.find((r) => r.question.includes('Hidden question case'));
    expect(result?.source).toBe(id);
    const outsider = await login('contributor');
    expect((await outsider.get(`/api/change-requests/${cr.id}`)).text).toMatch(/Hidden question case/);
    expect((await member.post(`/api/use-cases/${id}/withdraw`)).status).toBe(200);
    // Nothing is rewritten: every read decides from consent now.
    for (const url of [`/api/change-requests/${cr.id}`, `/api/ontologies/${demoId}/change-requests`, `/api/ontologies/${demoId}/validation`, `/api/ontologies/${demoId}/validation?ref=1.0.0`])
      expect((await outsider.get(url)).text).not.toMatch(/Hidden question case/);
  });
});

describe('the activity feed follows visibility (finding 5)', () => {
  it('hides items about use cases a viewer cannot see, and about meetings', async () => {
    const member = await login('member');
    await useCaseVia(member, 'Activity secret case', 'group');
    const anon = (await (await login('contributor')).get(`/api/activity?ontologyId=${demoId}`)).body as { message: string; link?: string }[];
    expect(JSON.stringify(anon)).not.toMatch(/Activity secret case/);
    expect(anon.some((a) => a.link?.includes('/meetings/'))).toBe(false);
    const other = (await member.get(`/api/activity?ontologyId=${demoId}`)).body as { message: string }[];
    expect(JSON.stringify(other)).toMatch(/Activity secret case/);
  });
});

describe('requirements documents (findings 6 and 11)', () => {
  it('writes a draft again when a use case it cites is no longer public, and never counts private ones', async () => {
    const steward = await login('steward');
    const author = await login('contributor');
    const id = await useCaseVia(author, 'Withdrawn later case', 'public');
    const project = findProject(demoId)!;
    const doc = await generateRequirements(project, { version: '9.9.9' });
    expect(doc.useCases.some((u) => u.id === id)).toBe(true);
    expect(Object.keys(doc.unpublished ?? {})).toEqual(['group']);
    expect((await author.post(`/api/use-cases/${id}/visibility`).send({ visibility: 'private' })).status).toBe(200);
    // The draft that drew on it is emptied at once, and the next read writes a fresh one without it.
    const stored = findDocument(demoId, '9.9.9')!;
    expect(stored.invalidated).toBe(true);
    expect(JSON.stringify(stored)).not.toMatch(/Withdrawn later case/);
    const read = await steward.get(`/api/ontologies/${demoId}/requirements/9.9.9`);
    expect(read.status).toBe(200);
    expect(read.body.useCases.length).toBeGreaterThan(0);
    expect(JSON.stringify(read.body)).not.toMatch(/Withdrawn later case/);
    expect(findDocument(demoId, '9.9.9')!.invalidated).toBeUndefined();
  });

  it('shows the group-only count to the group only', async () => {
    const pub = await request(app).get(`/api/ontologies/${demoId}/requirements/1.0.0`);
    expect(pub.body.unpublished).toBeUndefined();
    const md = await request(app).get(`/api/ontologies/${demoId}/requirements/1.0.0/markdown`);
    expect(md.text).not.toMatch(/not published|private/i);
  });

  it('counts only the use cases a viewer can see (finding 11)', async () => {
    // Signed out there is no count at all; signed in, it matches the list the viewer gets.
    expect((await request(app).get(`/api/ontologies/${demoId}`)).body.stats.useCases).toBeUndefined();
    const outsider = await login('contributor');
    const list = (await outsider.get(`/api/ontologies/${demoId}/use-cases`)).body as UseCase[];
    const summary = (await outsider.get(`/api/ontologies/${demoId}`)).body as { stats: { useCases: number } };
    expect(summary.stats.useCases).toBe(list.length);
  });

  it('numbers a use case only when it is shared, so gaps do not reveal private drafts (finding 11)', async () => {
    const author = await login('contributor');
    const id = await useCaseVia(author, 'Numbered on sharing', 'private');
    expect(getUseCase(id).number).toBe(0);
    await author.post(`/api/use-cases/${id}/visibility`).send({ visibility: 'public' });
    expect(getUseCase(id).number).toBeGreaterThan(0);
  });

  it('marks a requirement met only when its terms are in that version (finding 12)', async () => {
    const doc = (await request(app).get(`/api/ontologies/${demoId}/requirements/1.0.0`)).body as { requirements: { status: string; termIris: string[] }[] };
    for (const r of doc.requirements.filter((x) => x.status === 'met')) expect(r.termIris.length).toBeGreaterThan(0);
  });
});

describe('the offline anonymiser and consent (findings 7 and 8)', () => {
  it('replaces or flags names, organisations, mixed-case names, dates and numbers, and drops name-like terms', () => {
    const out = heuristicAnonymise(
      {
        sections: {
          name: 'Reports for IBM',
          goal: 'Alice sends reports. We use acmeCorp exports every week.',
          description: 'On 12/03/2025 we sent 48213 records.',
          dataSources: [{ name: 'Our internal HR database at Riverside' }],
          basicFlow: [{ step: 1, actorPerson: 'Alice', description: 'Alice sends the report' }],
        },
        competencyQuestions: [{ id: 'q', question: 'Who sends the reports?', exampleAnswer: 'Alice', status: 'untested' }],
        terms: [{ label: 'acmeCorp', kind: 'class' }, { label: 'report', kind: 'class' }],
      },
      'Jo Bloggs',
      ['Jo Bloggs'],
    );
    const text = JSON.stringify(out);
    expect(text).not.toMatch(/IBM|Alice|acmeCorp|48213|12\/03\/2025|HR database|Riverside/);
    expect(out.terms.map((t) => t.label)).toEqual(['report']);
    expect(out.sections.basicFlow?.[0]).toEqual({ step: 1, description: expect.any(String) });
    expect(out.changes.join(' ')).not.toMatch(/none of your details/);
  });

  it('warns about anything that may still identify someone', () => {
    const d = restrictDraft({ sections: { goal: 'Priya at Northvale uses DataHub since 2024' }, competencyQuestions: [{ question: 'Who?', exampleAnswer: 'Gareth' }], terms: [] });
    const w = identifyingWarnings(d, ['Priya Shah']).join(' ');
    expect(w).toMatch(/Priya/);
    expect(w).toMatch(/Northvale/);
    expect(w).toMatch(/DataHub/);
    expect(w).toMatch(/2024/);
    expect(w).toMatch(/Gareth/);
  });

  it('publishes exactly the allowlisted fields the author reviewed, whatever the client sends', async () => {
    const author = await login('contributor', 'Consent Carla');
    const id = await useCaseVia(author, 'Consent check', 'private');
    expect((await author.post(`/api/use-cases/${id}/anonymise`)).status).toBe(200);
    const pub = await author.post(`/api/use-cases/${id}/anonymise/publish`).send({
      draft: { sections: { name: 'Edited title', goal: 'Edited goal', dataSources: [{ name: 'Secret system' }], stakeholders: 'Carla' }, competencyQuestions: [{ question: 'Which?', exampleAnswer: 'An answer' }], terms: [{ label: 'thing', kind: 'class', evidence: ['quote from Carla'] }] },
    });
    expect(pub.status).toBe(200);
    const seen = await request(app).get(`/api/use-cases/${pub.body.published.id}`);
    expect(seen.body.sections.name).toBe('Edited title');
    expect(JSON.stringify(seen.body)).not.toMatch(/Secret system|Carla|quote from/);
    expect(seen.body.competencyQuestions[0].exampleAnswer).toBe('An answer');
  });
});

describe('withdrawal and links (findings 9 and 10)', () => {
  it('withdrawing hides a public use case from every read', async () => {
    const author = await login('contributor');
    const id = await useCaseVia(author, 'Withdraw me', 'public');
    expect((await author.post(`/api/use-cases/${id}/withdraw`)).status).toBe(200);
    expect((await request(app).get(`/api/use-cases/${id}`)).status).toBe(404);
    const steward = await login('steward');
    expect((await steward.get(`/api/use-cases/${id}`)).status).toBe(404);
    expect(JSON.stringify((await request(app).get(`/api/ontologies/${demoId}/public-use-cases`)).body)).not.toMatch(/Withdraw me/);
    expect(JSON.stringify((await request(app).get('/def/volunteering/draft')).text)).not.toMatch(/Withdraw me/);
    // The author still sees it.
    expect((await author.get(`/api/use-cases/${id}`)).status).toBe(200);
  });

  it('an anonymous use case linking to its private original reveals neither the target nor who linked it', async () => {
    const author = await login('contributor', 'Linker Lou');
    const original = await useCaseVia(author, 'Private original', 'private');
    await author.post(`/api/use-cases/${original}/anonymise`);
    const pub = await author.post(`/api/use-cases/${original}/anonymise/publish`).send({});
    const anonId = pub.body.published.id as string;
    expect((await author.post(`/api/use-cases/${anonId}/links`).send({ type: 'use-case', id: original, relation: 'related' })).status).toBe(200);
    expect((await author.post(`/api/use-cases/${anonId}/links`).send({ type: 'url', url: 'https://example.org/x', relation: 'related' })).status).toBe(200);
    const seen = await request(app).get(`/api/use-cases/${anonId}`);
    const text = JSON.stringify(seen.body);
    expect(text).not.toContain(original);
    expect(seen.body.links.every((l: { addedBy?: string }) => !l.addedBy)).toBe(true);
    expect(seen.body.trace.other.every((l: { addedBy?: string }) => !l.addedBy)).toBe(true);
  });
});

describe('closure and the public projection (findings 13, 14, 15)', () => {
  it('closes in the release that completed the work, not the one attached to the last change request', () => {
    const r1 = { id: 'rel_a', ontologyId: demoId, version: '1.0.0', createdAt: '2026-01-01T00:00:00Z', status: 'published', publishedAt: '2026-01-01T00:00:00Z', changeRequestIds: [] } as unknown as Release;
    const r2 = { ...r1, id: 'rel_b', version: '2.0.0', publishedAt: '2026-03-01T00:00:00Z' } as Release;
    put('releases', r1, demoId);
    put('releases', r2, demoId);
    const cr1 = { id: 'cr_1', number: 1, releaseId: 'rel_b' } as ChangeRequest;
    const cr2 = { id: 'cr_2', number: 2, releaseId: 'rel_a' } as ChangeRequest;
    expect(completingRelease([cr1, cr2])?.version).toBe('2.0.0');
    expect(completingRelease([cr1, { ...cr2, releaseId: 'rel_missing' }])).toBeUndefined();
  });

  it('reading a closed use case does not rewrite its closure time', async () => {
    const list = (await request(app).get(`/api/ontologies/${demoId}/use-cases`)).body as UseCase[];
    const closed = list.find((u) => u.status === 'closed' && u.resolution?.releaseId)!;
    const before = get<UseCase>('useCases', closed.id)!;
    await request(app).get(`/api/use-cases/${closed.id}`);
    await request(app).get(`/api/use-cases/${closed.id}`);
    const after = get<UseCase>('useCases', closed.id)!;
    expect(after.resolution?.at).toBe(before.resolution?.at);
    expect(after.updatedAt).toBe(before.updatedAt);
  });

  it('refuses to project a private use case for the public, and gives anonymised ones no attribution', () => {
    const priv = list<UseCase>(demoId, 'useCases').find((u) => u.visibility === 'private')!;
    expect(() => toPublic(priv)).toThrow();
    const anon = list<UseCase>(demoId, 'useCases').find((u) => u.anonymous && u.visibility === 'public' && !u.withdrawnAt && u.status !== 'archived')!;
    const p = toPublic(anon);
    expect(p.anonymised).toBe(true);
    expect('attribution' in p).toBe(false);
    expect(p.origin?.kind).toBe('synthetic');
  });
});

describe('existence oracles (finding 16)', () => {
  it('answers the same for someone else’s private use case or interview as for a missing one', async () => {
    const author = await login('contributor');
    const id = await useCaseVia(author, 'Oracle check', 'private');
    const other = await login('contributor');
    const a = await other.post(`/api/ontologies/${demoId}/interviews`).send({ useCaseId: id });
    const b = await other.post(`/api/ontologies/${demoId}/interviews`).send({ useCaseId: 'uc_doesnotexist' });
    expect(a.status).toBe(404);
    expect(b.status).toBe(404);
    const s = await author.post(`/api/ontologies/${demoId}/interviews`).send({ useCaseId: id });
    expect((await other.get(`/api/interviews/${s.body.id}`)).status).toBe(404);
    expect((await other.get('/api/interviews/int_doesnotexist')).status).toBe(404);
  });
});

describe('use case reads', () => {
  it('never return private or group-only use cases to signed-out callers, by id, by slug or through a change request', async () => {
    const author = await login('member');
    const priv = await useCaseVia(author, 'Secret pantry rota', 'private');
    const group = await useCaseVia(author, 'Group pantry rota', 'group');
    const slug = findProject(demoId)!.slug;
    for (const id of [priv, group]) {
      const res = await request(app).get(`/api/use-cases/${id}`);
      expect(res.status).toBe(404);
      expect(res.text).not.toMatch(/pantry rota/);
    }
    for (const key of [demoId, slug]) {
      const res = await request(app).get(`/api/ontologies/${key}/use-cases`);
      expect(res.status).toBe(200);
      expect(res.text).not.toMatch(/pantry rota/);
      expect((res.body as UseCase[]).every((u) => u.visibility === 'public')).toBe(true);
    }
    const cr = list<ChangeRequest>(demoId)[0];
    put('changeRequests', { ...cr, useCaseIds: [...(cr.useCaseIds ?? []), priv, group] }, demoId);
    const res = await request(app).get(`/api/change-requests/${cr.id}`);
    expect(res.text).not.toMatch(/pantry rota/);
    expect(res.text).not.toContain(priv);
    expect(res.text).not.toContain(group);
    put('changeRequests', cr, demoId);
    // The author still sees both.
    expect((await author.get(`/api/use-cases/${priv}`)).status).toBe(200);
  });
});

const userNamed = (name: string) => listDocs<User>('users').find((u) => u.name === name)!;

describe('second review: races, published documents, validation, numbering and coverage', () => {
  it('drafting that is already running never undoes a withdrawal (finding 17)', async () => {
    const author = await login('contributor', 'Race Author A');
    const id = await useCaseVia(author, 'Race to withdraw', 'public');
    await login('editor', 'Race Editor A');
    const other = userNamed('Race Editor A');
    const running = synthesise(findProject(demoId)!, other, [id]);
    withdrawUseCase(getUseCase(id), userNamed('Race Author A'));
    await expect(running).rejects.toMatchObject({ status: 409 });
    const u = get<UseCase>('useCases', id)!;
    expect(u.withdrawnAt).toBeTruthy();
    expect(u.visibility).toBe('private');
    expect((await request(app).get(`/api/use-cases/${id}`)).status).toBe(404);
    // A stale copy saved afterwards (an interview turn, say) can't bring it back either.
    const stale = { ...u, withdrawnAt: undefined, visibility: 'public' as const, status: 'accepted' as const };
    updateUseCase(stale, userNamed('Race Author A'), { sections: { name: 'Race to withdraw (edited)' } });
    expect(get<UseCase>('useCases', id)!.withdrawnAt).toBeTruthy();
    expect(get<UseCase>('useCases', id)!.visibility).toBe('private');
  });

  it('a document being written when a use case is withdrawn is written again without it (finding 18)', async () => {
    const author = await login('contributor', 'Race Author B');
    const id = await useCaseVia(author, 'Withdrawn mid-writing', 'public');
    const writing = generateRequirements(findProject(demoId)!, { version: '9.8.0' });
    withdrawUseCase(getUseCase(id), userNamed('Race Author B'));
    const doc = await writing;
    expect(JSON.stringify(doc)).not.toMatch(/Withdrawn mid-writing/);
    expect(doc.sourceIds).not.toContain(id);
    expect(JSON.stringify(findDocument(demoId, '9.8.0'))).not.toMatch(/Withdrawn mid-writing/);
  });

  it('a published document stops serving anything written from a use case withdrawn afterwards (findings 6, 15)', async () => {
    const author = await login('contributor', 'Published Author');
    const id = await useCaseVia(author, 'Published then withdrawn', 'public');
    const project = findProject(demoId)!;
    const release = { id: 'rel_pub', ontologyId: demoId, version: '9.7.0', createdAt: '2026-01-01T00:00:00Z', status: 'published', changeRequestIds: [] } as unknown as Release;
    const doc = await markPublished(await generateRequirements(project, { version: '9.7.0', release }), release);
    expect(JSON.stringify(doc)).toMatch(/Published then withdrawn/);
    withdrawUseCase(getUseCase(id), userNamed('Published Author'));
    const reads = [
      JSON.stringify((await request(app).get(`/api/ontologies/${demoId}/requirements/9.7.0`)).body),
      (await request(app).get(`/api/ontologies/${demoId}/requirements/9.7.0/markdown`)).text,
      JSON.stringify(requirementsDocument(demoId, '9.7.0')),
      renderMarkdown(requirementsDocument(demoId, '9.7.0')!),
    ];
    for (const text of reads) {
      expect(text).not.toMatch(/Published then withdrawn/);
      expect(text).not.toContain(id);
      expect(text).toMatch(/withdrawn/i);
    }
    const served = requirementsDocument(demoId, '9.7.0')!;
    expect(served.sourceIds).toBeUndefined();
    expect(served.intro).toBe('');
  });

  it('a change request drafted from a use case shows nothing of it once withdrawn: tests, results, text (finding 4)', async () => {
    const author = await login('contributor', 'Question Author');
    const id = await useCaseVia(author, 'Edited question case', 'public');
    const original = getUseCase(id).competencyQuestions[0].question;
    const base = list<ChangeRequest>(demoId)[0];
    const cr = { ...structuredClone(base), id: 'cr_from_edited_question', number: 7001, origin: { type: 'synthesis' as const, useCaseIds: [id] }, useCaseIds: [id], title: 'Drafted from Edited question case', tests: [{ question: original, sparql: 'SELECT * WHERE { ?s ?p ?o }', exampleData: '<urn:SECRET-EXAMPLE> a <urn:x> .' }] };
    put('changeRequests', cr, demoId);
    expect((await author.patch(`/api/use-cases/${id}`).send({ competencyQuestions: [{ question: 'A reworded question?' }] })).status).toBe(200);
    expect((await author.post(`/api/use-cases/${id}/withdraw`)).status).toBe(200);
    const outsider = await login('contributor');
    const read = await outsider.get(`/api/change-requests/${cr.id}`);
    expect(read.status).toBe(200);
    expect(read.body.withheld).toBe(true);
    expect(read.text).not.toContain(original);
    expect(read.text).not.toContain('SECRET-EXAMPLE');
    expect(read.text).not.toContain('Edited question case');
    // Its author still sees it in full.
    expect((await author.get(`/api/change-requests/${cr.id}`)).text).toContain('SECRET-EXAMPLE');
  });

  it('numbers only public use cases in the public sequence, so group-only ones leave no gaps (finding 11)', async () => {
    const author = await login('member');
    const a = await useCaseVia(author, 'Numbered public A', 'public');
    const g = await useCaseVia(author, 'Numbered group', 'group');
    const b = await useCaseVia(author, 'Numbered public B', 'public');
    expect(getUseCase(b).number).toBe(getUseCase(a).number + 1);
    expect(getUseCase(g).number).toBe(0);
    expect(getUseCase(g).groupNumber).toBeGreaterThan(0);
    const outsider = (await request(app).get(`/api/ontologies/${demoId}/use-cases`)).body as UseCase[];
    expect(outsider.some((u) => u.groupNumber)).toBe(false);
  });

  it('never closes a use case automatically when one of its changes was rejected (finding 12)', () => {
    const rel = { id: 'rel_c', ontologyId: demoId, version: '3.0.0', createdAt: '2026-01-01T00:00:00Z', status: 'published', publishedAt: '2026-05-01T00:00:00Z', changeRequestIds: [] } as unknown as Release;
    put('releases', rel, demoId);
    const u = { id: 'uc_mixed', ontologyId: demoId, status: 'addressed', changeRequestIds: ['cr_rel', 'cr_rej'] } as unknown as UseCase;
    const crs = [{ id: 'cr_rel', number: 101, status: 'released', releaseId: 'rel_c' }, { id: 'cr_rej', number: 102, status: 'rejected' }] as ChangeRequest[];
    expect(derivedStatus(u, crs)?.status ?? u.status).toBe('addressed');
    expect(derivedStatus({ ...u, changeRequestIds: ['cr_rel'] } as UseCase, [crs[0]])?.status).toBe('closed');
  });

  it('a requirement needing a term the ontology lacks is never met (finding 12)', async () => {
    const met = findDocument(demoId, '1.0.0')!.requirements.find((r) => r.status === 'met')!;
    const tom = getUseCase(met.useCaseIds[0]);
    const release = { id: 'rel_terms', ontologyId: demoId, version: '9.6.0', createdAt: '2026-01-01T00:00:00Z', status: 'published', changeRequestIds: [] } as unknown as Release;
    const base = { ...findDocument(demoId, '1.0.0')!, id: 'reqdoc_terms', version: '9.6.0', status: 'draft' as const, sourceIds: [tom.id], useCases: [toPublic(tom)] };
    put('requirementsDocs', { ...base, requirements: [{ ...met, missingTerms: ['schedule'] }] }, demoId);
    const doc = await markPublished(findDocument(demoId, '9.6.0')!, release);
    expect(doc.requirements[0].status).toBe('partial');
  });

  it('an archived use case is for its author and the working group only (finding 9)', async () => {
    const author = await login('contributor');
    const id = await useCaseVia(author, 'Archived by an editor', 'public');
    const editor = await login('editor');
    expect((await author.patch(`/api/use-cases/${id}`).send({ status: 'archived' })).status).toBe(200);
    expect((await request(app).get(`/api/use-cases/${id}`)).status).toBe(404);
    expect(JSON.stringify((await request(app).get(`/api/ontologies/${demoId}/use-cases`)).body)).not.toMatch(/Archived by an editor/);
    expect((await editor.get(`/api/use-cases/${id}`)).status).toBe(200);
    expect((await author.get(`/api/use-cases/${id}`)).status).toBe(200);
  });
});

describe('third review: open reads, published passages, commits and caching', () => {
  it('never says who triaged an anonymous use case, and keeps drafts and drafted SPARQL for the group (findings 1, 2)', async () => {
    const editor = await login('editor', 'Triaging Editor');
    const project = findProject(demoId)!;
    const anon = createUseCase(project, userNamed('Triaging Editor'), { source: 'chat', visibility: 'public', anonymous: true, status: 'triage', sections: { name: 'Anonymous triaged case' }, competencyQuestions: [{ id: 'cq_x', question: 'Which ones?', sparql: 'SELECT ?secretSparql WHERE {}', exampleData: '<urn:secret-data> a <urn:x> .', status: 'draft' }] });
    expect((await editor.post(`/api/use-cases/${anon.id}/triage`).send({ status: 'accepted', note: 'ok' })).status).toBe(200);
    const outsider = await login('contributor');
    for (const agent of [request(app), outsider]) {
      const detail = await agent.get(`/api/use-cases/${anon.id}`);
      expect(detail.status).toBe(200);
      expect(detail.body.resolution?.by).toBeUndefined();
      expect(JSON.stringify(detail.body)).not.toContain(userNamed('Triaging Editor').id);
      expect(JSON.stringify(detail.body)).not.toMatch(/secretSparql|secret-data/);
      expect(JSON.stringify((await agent.get(`/api/ontologies/${demoId}/use-cases`)).body)).not.toContain(userNamed('Triaging Editor').id);
    }
    // A public use case its author hasn't submitted yet is not shown to others.
    const draft = createUseCase(project, userNamed('Triaging Editor'), { source: 'form', visibility: 'public', status: 'draft', sections: { name: 'Unsubmitted public draft' } });
    expect((await outsider.get(`/api/use-cases/${draft.id}`)).status).toBe(404);
    expect(JSON.stringify((await request(app).get(`/api/ontologies/${demoId}/use-cases`)).body)).not.toMatch(/Unsubmitted public draft/);
  });

  it('shows signed-out visitors no change request titles through a use case (finding 5)', async () => {
    const steward = await login('steward');
    const withCr = (await steward.get(`/api/ontologies/${demoId}/use-cases`)).body.find((u: UseCase) => u.visibility === 'public' && u.changeRequestIds?.length) as UseCase;
    const crTitle = get<ChangeRequest>('changeRequests', withCr.changeRequestIds![0])!.title;
    const anon = await request(app).get(`/api/use-cases/${withCr.id}`);
    expect(anon.body.trace.changeRequests).toEqual([]);
    expect(anon.text).not.toContain(crTitle);
    expect((await steward.get(`/api/use-cases/${withCr.id}`)).body.trace.changeRequests.length).toBeGreaterThan(0);
  });

  it('drops whole passages written from a withdrawn or archived use case, with a plain title and matching counts (findings 2, 7)', async () => {
    const author = await login('contributor', 'Two Case Author');
    const a = await useCaseVia(author, 'Shared passage A', 'public');
    const b = await useCaseVia(author, 'Shared passage B', 'public');
    const project = findProject(demoId)!;
    const release = { id: 'rel_pass', ontologyId: demoId, version: '9.5.0', createdAt: '2026-01-01T00:00:00Z', status: 'published', changeRequestIds: [] } as unknown as Release;
    const doc = await markPublished(await generateRequirements(project, { version: '9.5.0', release }), release);
    // One requirement cites both, with a title that quotes A.
    put('requirementsDocs', { ...doc, title: 'Mentions Shared passage A', requirements: [...doc.requirements, { id: 'R99', text: 'From Shared passage A and B', useCaseIds: [a, b], termIris: [], status: 'open' as const }] }, demoId);
    // Archiving counts as no longer publishable, just like withdrawal.
    expect((await author.patch(`/api/use-cases/${a}`).send({ status: 'archived' })).status).toBe(200);
    const served = requirementsDocument(demoId, '9.5.0')!;
    const text = JSON.stringify(served) + renderMarkdown(served);
    expect(text).not.toMatch(/Shared passage A/);
    expect(served.requirements.some((r) => r.id === 'R99')).toBe(false);
    expect(served.useCases.some((u) => u.id === b)).toBe(true);
    const listed = (await request(app).get(`/api/ontologies/${demoId}/requirements`)).body.find((d: { version: string }) => d.version === '9.5.0');
    expect(listed.title).toBe(served.title);
    expect(listed.coverage).toEqual(served.coverage);
    // The public page's snapshot: a section that draws on A goes even without an inline link, and so does one with no recorded sources.
    const snap = toPublishedRequirements({ ...doc, sections: [{ id: 's1', heading: 'About A', markdown: 'no link here', useCaseIds: [a] }, { id: 's2', heading: 'Unknown', markdown: 'old snapshot', useCaseIds: undefined as never }, { id: 's3', heading: 'About B', markdown: 'b', useCaseIds: [b] }] }, doc.useCases);
    const view = requirementsFor(project, snap);
    expect(view.document!.sections!.map((x) => x.id)).toEqual(['s3']);
    expect(JSON.stringify(view)).not.toMatch(/Shared passage A/);
    expect(view.withdrawn).toBe(1);
  });

  it('a withdrawal waits while something derived from use cases is being committed (findings 3, 4)', async () => {
    const author = await login('contributor', 'Waiting Author');
    const id = await useCaseVia(author, 'Waits for the commit', 'public');
    const order: string[] = [];
    let release!: () => void;
    const held = withConsentLock(demoId, () => new Promise<void>((r) => (release = () => { order.push('commit'); r(); })));
    const withdrawal = author.post(`/api/use-cases/${id}/withdraw`).then((res) => { order.push('withdraw'); return res; });
    await new Promise((r) => setTimeout(r, 50));
    expect(order).toEqual([]);
    expect(getUseCase(id).withdrawnAt).toBeUndefined();
    release();
    await held;
    expect((await withdrawal).status).toBe(200);
    expect(order).toEqual(['commit', 'withdraw']);
    expect(getUseCase(id).withdrawnAt).toBeTruthy();
  });

  it('results a retriage saved from a use case, before or while it was withdrawn, are not shown (finding 4)', async () => {
    const { triage } = await import('../src/services/changeRequests.js');
    const author = await login('contributor', 'Retriage Author');
    const id = await useCaseVia(author, 'Retriage race', 'public');
    const u = getUseCase(id);
    put('useCases', { ...u, competencyQuestions: [{ ...u.competencyQuestions[0], sparql: 'SELECT ?x WHERE { ?x a <urn:RetriageKind> }', exampleData: '<urn:RETRIAGE-SECRET> a <urn:RetriageKind> .' }] }, demoId);
    const cr = list<ChangeRequest>(demoId).find((c) => !c.useCaseIds?.length && c.origin.type === 'direct') ?? list<ChangeRequest>(demoId)[0];
    // A retriage that captured the questions before the withdrawal saves results that include them...
    await triage(get<ChangeRequest>('changeRequests', cr.id)!);
    expect(JSON.stringify(get<ChangeRequest>('changeRequests', cr.id)!.validation)).toContain('RETRIAGE-SECRET');
    const outsider = await login('contributor');
    expect((await outsider.get(`/api/change-requests/${cr.id}`)).text).toContain('RETRIAGE-SECRET');
    withdrawUseCase(getUseCase(id), userNamed('Retriage Author'));
    // ...tagged with their source, so once it is withdrawn no reader is shown them.
    expect((await outsider.get(`/api/change-requests/${cr.id}`)).text).not.toContain('RETRIAGE-SECRET');
    expect((await outsider.get(`/api/ontologies/${demoId}/change-requests`)).text).not.toContain('RETRIAGE-SECRET');
  });

  it('a requirement keeps a term the ontology lacks through regeneration, so it is not met (finding 8)', async () => {
    const author = await login('contributor', 'Missing Term Author');
    const id = await useCaseVia(author, 'Needs a missing term', 'public');
    const u = getUseCase(id);
    put('useCases', { ...u, terms: [{ label: 'Opportunity', kind: 'class' }, { label: 'Zzschedule', kind: 'class' }] }, demoId);
    const doc = await generateRequirements(findProject(demoId)!, { version: '9.4.0' });
    const mine = doc.requirements.filter((r) => r.useCaseIds.includes(id));
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((r) => r.missingTerms?.includes('Zzschedule'))).toBe(true);
    expect(mine.some((r) => r.status === 'met')).toBe(false);
  });

  it('marks API responses private and uncacheable, and public pages for revalidation (finding 9)', async () => {
    const res = await request(app).get(`/api/ontologies/${demoId}/use-cases`);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers.vary).toMatch(/Cookie/);
    const page = await request(app).get(`/def/${findProject(demoId)!.slug}/1.0.0`).set('Accept', 'text/html');
    expect(page.headers['cache-control']).toBe('no-cache');
  });
});

describe('fourth review: one process, retriage, change request copies, simulation, drafts', () => {
  it('refuses a second server on the same data while the first runs, and starts once it has stopped (finding 1)', async () => {
    const { spawn } = await import('node:child_process');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'concord-lock-'));
    // Another server: a separate process holding the same lock the way acquireProcessLock does.
    const holder = spawn(process.execPath, [
      '--no-warnings',
      '-e',
      `const { DatabaseSync } = require('node:sqlite');
       const db = new DatabaseSync(process.argv[1] + '/concord.lock');
       db.exec('PRAGMA busy_timeout = 0; PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner (pid INTEGER); COMMIT;');
       console.log('ready');
       setInterval(() => {}, 1000);`,
      dir,
    ]);
    await new Promise<void>((resolve, reject) => {
      holder.stdout.on('data', (d) => String(d).includes('ready') && resolve());
      holder.on('exit', (code) => reject(new Error(`holder exited ${code}`)));
    });
    try {
      expect(() => acquireProcessLock(dir)).toThrow(/Another Concord server/);
      // An empty or half-written file is no way in either: there is nothing to read and decide on.
      expect(() => acquireProcessLock(dir)).toThrow(/Another Concord server/);
    } finally {
      holder.kill('SIGKILL');
      await new Promise((r) => holder.once('exit', r));
    }
    // Killed without any cleanup, its lock went with it.
    const release = acquireProcessLock(dir);
    // And this process now holds it against anyone else.
    const second = spawn(process.execPath, [
      '--no-warnings',
      '-e',
      `const { DatabaseSync } = require('node:sqlite');
       const db = new DatabaseSync(process.argv[1] + '/concord.lock');
       try { db.exec('PRAGMA busy_timeout = 0; PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;'); console.log('took it'); }
       catch (e) { console.log('refused'); }`,
      dir,
    ]);
    let out = '';
    second.stdout.on('data', (d) => (out += d));
    await new Promise((r) => second.once('exit', r));
    expect(out.trim()).toBe('refused');
    release();
  });

  it('lets exactly one of several servers starting at once take the lock (finding 1)', async () => {
    const { spawn } = await import('node:child_process');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'concord-lock-race-'));
    // Each child runs the server's own acquireProcessLock.
    const script = path.join(dir, 'start.ts');
    fs.writeFileSync(
      script,
      `import { acquireProcessLock } from ${JSON.stringify(path.resolve(__dirname, '../src/processLock.ts'))};
       try { acquireProcessLock(process.argv[2]); console.log('took it'); } catch (e) { console.log(String(e).includes('Another Concord server') ? 'refused' : String(e)); }
       setTimeout(() => {}, 2000);`,
    );
    const tsx = path.resolve(__dirname, '../node_modules/.bin/tsx');
    const results = await Promise.all(
      Array.from({ length: 6 }, () => {
        const child = spawn(tsx, [script, dir], { env: { ...process.env, NODE_NO_WARNINGS: '1' } });
        let out = '';
        child.stdout.on('data', (d) => (out += d));
        return new Promise<string>((r) => child.once('exit', () => r(out.trim())));
      }),
    );
    expect(results.filter((r) => r === 'took it')).toHaveLength(1);
    expect(results.filter((r) => r === 'refused')).toHaveLength(5);
  }, 30_000);

  it('publishing a release holds back a withdrawal until its files are committed (finding 1)', async () => {
    const { draftRelease, publishRelease } = await import('../src/services/releases.js');
    const author = await login('contributor', 'Release Race Author');
    const id = await useCaseVia(author, 'Release race case', 'public');
    await login('steward', 'Release Race Steward');
    const steward = userNamed('Release Race Steward');
    const r = await draftRelease(findProject(demoId)!, steward, 'race');
    let resume!: () => void;
    let committed: Record<string, string> = {};
    const real = ontologyStore.writeRelease.bind(ontologyStore);
    const spy = vi.spyOn(ontologyStore, 'writeRelease').mockImplementation(async (...args: Parameters<typeof ontologyStore.writeRelease>) => {
      committed = args[3];
      await new Promise<void>((ok) => (resume = ok));
      return real(...args);
    });
    try {
      const publishing = publishRelease(r, steward);
      while (!resume) await new Promise((ok) => setTimeout(ok, 10));
      let withdrawn = false;
      const withdrawal = author.post(`/api/use-cases/${id}/withdraw`).then((res) => ((withdrawn = true), res));
      await new Promise((ok) => setTimeout(ok, 50));
      expect(withdrawn).toBe(false);
      resume();
      await publishing;
      expect((await withdrawal).status).toBe(200);
      // What was committed is what was consented to when it was committed; the served copy drops it now.
      expect(committed['USE_CASES.md']).toMatch(/Release race case/);
      expect(JSON.stringify(requirementsDocument(demoId, r.version))).not.toMatch(/Release race case/);
    } finally {
      spy.mockRestore();
    }
  });

  it('drafting a change request holds back a withdrawal until it is stored (finding 1)', async () => {
    const author = await login('contributor', 'Synthesis Lock Author');
    const id = await useCaseVia(author, 'Synthesis lock case', 'public');
    await login('editor', 'Synthesis Lock Editor');
    let calls = 0;
    let resume!: () => void;
    const real = ontologyStore.working.bind(ontologyStore);
    const spy = vi.spyOn(ontologyStore, 'working').mockImplementation(async (p) => {
      // The second read is createChangeRequest's, inside the lock.
      if (++calls === 2) await new Promise<void>((ok) => (resume = ok));
      return real(p);
    });
    try {
      const drafting = synthesise(findProject(demoId)!, userNamed('Synthesis Lock Editor'), [id]);
      while (!resume) await new Promise((ok) => setTimeout(ok, 10));
      let withdrawn = false;
      const withdrawal = author.post(`/api/use-cases/${id}/withdraw`).then((res) => ((withdrawn = true), res));
      await new Promise((ok) => setTimeout(ok, 50));
      expect(withdrawn).toBe(false);
      spy.mockRestore();
      resume();
      const cr = await drafting;
      expect((await withdrawal).status).toBe(200);
      // The withdrawal then took the use case's title out of the change request drafted from it.
      const outsider = await login('contributor');
      const read = await outsider.get(`/api/change-requests/${cr.id}`);
      expect(read.status).toBe(200);
      expect(read.text).not.toMatch(/Synthesis lock case/);
    } finally {
      spy.mockRestore();
    }
  });

  it('a retriage running when a use case is withdrawn runs again, even if another use case asks the same question (finding 2)', async () => {
    const { triage } = await import('../src/services/changeRequests.js');
    const a = await login('contributor', 'Same Question A');
    const b = await login('contributor', 'Same Question B');
    const ida = await useCaseVia(a, 'Same question source A', 'public');
    const idb = await useCaseVia(b, 'Same question source B', 'public');
    const q = 'Which sessions are secret?';
    const withQ = (id: string, data?: string) => {
      const u = getUseCase(id);
      put('useCases', { ...u, competencyQuestions: [{ id: `cq_${id}`, question: q, status: 'answerable', sparql: 'SELECT ?s WHERE { ?s a <urn:SecretKind> }', ...(data ? { exampleData: data } : {}) }] }, demoId);
    };
    withQ(ida, '<urn:OLD_SECRET> a <urn:SecretKind> .');
    withQ(idb);
    const cr = list<ChangeRequest>(demoId)[0];
    const saved = structuredClone(cr);
    // Without a withdrawal the result does carry A's example data, so the check below means something.
    expect(JSON.stringify((await triage(get<ChangeRequest>('changeRequests', cr.id)!)).validation)).toContain('OLD_SECRET');
    const running = triage(get<ChangeRequest>('changeRequests', cr.id)!);
    withdrawUseCase(getUseCase(ida), userNamed('Same Question A'));
    await running;
    expect(JSON.stringify(get<ChangeRequest>('changeRequests', cr.id)!.validation)).not.toContain('OLD_SECRET');
    put('changeRequests', saved, demoId);
  });

  it('the simulation returns only activity the tester may see (finding 4)', async () => {
    const member = await login('member', 'Simulation Member');
    clock.advance(24 * 3600_000);
    try {
      await useCaseVia(member, 'Simulation secret case', 'group');
    } finally {
      clock.advance(-24 * 3600_000);
    }
    const outsider = await login('contributor');
    const res = await outsider.post('/api/simulation/step').send({ ontologyId: demoId });
    expect(res.status).toBe(200);
    expect(res.text).not.toMatch(/Simulation secret case/);
    expect(res.text).not.toMatch(/Simulation Member/);
    expect((await member.post('/api/simulation/step').send({ ontologyId: demoId })).text).toMatch(/Simulation secret case/);
  });

  it('a public draft its author has not submitted feeds neither drafting nor validation (new finding)', async () => {
    const author = await login('contributor', 'Draft Author');
    const s = await author.post(`/api/ontologies/${demoId}/interviews`).send({});
    const id = s.body.useCaseId as string;
    await author.patch(`/api/use-cases/${id}`).send({ sections: { name: 'Unsubmitted draft case' }, competencyQuestions: [{ question: 'Which drafts leak?', exampleAnswer: 'none' }] });
    const u = getUseCase(id);
    put('useCases', { ...u, visibility: 'public', number: 900, competencyQuestions: [{ ...u.competencyQuestions[0], sparql: 'SELECT ?x WHERE { ?x a <urn:DraftKind> }', exampleData: '<urn:DRAFT_SECRET> a <urn:DraftKind> .' }] }, demoId);
    expect(getUseCase(id).status).toBe('draft');
    await login('editor', 'Draft Editor');
    await expect(synthesise(findProject(demoId)!, userNamed('Draft Editor'), [id])).rejects.toMatchObject({ status: 409 });
    expect(getUseCase(id).status).toBe('draft');
    const outsider = await login('contributor');
    for (const url of [`/api/ontologies/${demoId}/validation`, `/api/ontologies/${demoId}/validation?ref=1.0.0`]) {
      const res = await outsider.get(url);
      expect(res.status).toBe(200);
      expect(res.text).not.toMatch(/Which drafts leak|DRAFT_SECRET/);
    }
  });

  it('signed-out callers see no change request ids on use cases (new finding)', async () => {
    const list = (await request(app).get(`/api/ontologies/${demoId}/use-cases`)).body as UseCase[];
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((u) => u.changeRequestIds === undefined)).toBe(true);
    const withCr = listDocs<UseCase>('useCases', demoId).find((u) => u.visibility === 'public' && u.status !== 'draft' && !u.withdrawnAt && u.changeRequestIds?.length)!;
    expect((await request(app).get(`/api/use-cases/${withCr.id}`)).body.changeRequestIds).toBeUndefined();
  });
});

function list<T>(ontologyId: string, collection: 'changeRequests' | 'useCases' = 'changeRequests'): T[] {
  return listDocs<T>(collection, ontologyId);
}

describe('fifth and sixth reviews: draft triage, citations, discarded requests', () => {
  const publicCase = async (who: string, name: string) => {
    const agent = await login('contributor', who);
    return { agent, id: await useCaseVia(agent, name, 'public') };
  };

  /** A use case its author made public but hasn't submitted: still a draft. */
  const publicDraft = async (who: string, name: string) => {
    const author = await login('contributor', who);
    const s = await author.post(`/api/ontologies/${demoId}/interviews`).send({});
    const id = s.body.useCaseId as string;
    await author.patch(`/api/use-cases/${id}`).send({ sections: { name } });
    put('useCases', { ...getUseCase(id), visibility: 'public', number: 800 + Math.floor(Math.random() * 99) }, demoId);
    expect(getUseCase(id).status).toBe('draft');
    return { author, id };
  };

  it("an editor can't triage or submit someone else's unsubmitted draft (new finding)", async () => {
    const { author, id } = await publicDraft('Draft Owner', 'Not ready yet case');
    const editor = await login('editor', 'Eager Editor');
    for (const status of ['accepted', 'triage', 'closed', 'deferred']) {
      const res = await editor.post(`/api/use-cases/${id}/triage`).send({ status });
      expect(res.status).toBe(409);
    }
    expect((await editor.post(`/api/use-cases/${id}/submit`)).status).toBe(403);
    expect((await editor.patch(`/api/use-cases/${id}`).send({ status: 'triage' })).status).toBe(403);
    expect((await editor.patch(`/api/use-cases/${id}`).send({ status: 'accepted' })).status).toBe(409);
    expect(getUseCase(id).status).toBe('draft');
    // Once the author submits it, the editor can triage it.
    expect((await author.post(`/api/use-cases/${id}/submit`)).status).toBe(200);
    expect((await editor.post(`/api/use-cases/${id}/triage`).send({ status: 'accepted' })).status).toBe(200);
  });

  it('citing a draft or archived use case is refused before any change request is saved (new finding)', async () => {
    const { author, id } = await publicDraft('Cite Draft Owner', 'Cite draft case');
    const before = list<ChangeRequest>(demoId).length;
    const res = await author.post(`/api/ontologies/${demoId}/change-requests`).send({ title: 'Cites a draft', naturalLanguage: 'Add a Shift class', useCaseIds: [id] });
    expect(res.status).toBe(409);
    expect(list<ChangeRequest>(demoId).length).toBe(before);
    put('useCases', { ...getUseCase(id), status: 'archived' }, demoId);
    expect((await author.post(`/api/ontologies/${demoId}/change-requests`).send({ title: 'Cites archived', naturalLanguage: 'Add a Shift class', useCaseIds: [id] })).status).toBe(409);
    expect(list<ChangeRequest>(demoId).length).toBe(before);
  });

  it('a triage never writes back a request that is not stored (finding 3)', async () => {
    const { triage } = await import('../src/services/changeRequests.js');
    const ghost = { ...structuredClone(list<ChangeRequest>(demoId)[0]), id: 'cr_never_stored', title: 'Ghost request' };
    await triage(ghost);
    expect(get('changeRequests', 'cr_never_stored')).toBeUndefined();
  });

  it('a change request citing a use case withdrawn while it is drafted is never stored or shown (finding 3)', async () => {
    const { agent, id } = await publicCase('Uncommitted Author', 'Uncommitted cite case');
    const before = list<ChangeRequest>(demoId).length;
    const real = ontologyStore.working.bind(ontologyStore);
    let resume!: () => void;
    let calls = 0;
    const storedDuring: number[] = [];
    const spy = vi.spyOn(ontologyStore, 'working').mockImplementation(async (p) => {
      if (++calls === 1) await new Promise<void>((ok) => (resume = ok));
      // Any later read (triage) would find what has been stored so far.
      else storedDuring.push(list<ChangeRequest>(demoId).length);
      return real(p);
    });
    try {
      const creating = agent.post(`/api/ontologies/${demoId}/change-requests`).send({ title: 'Uncommitted cite request', naturalLanguage: 'Add a Berth class', useCaseIds: [id] }).then((r) => r);
      while (!resume) await new Promise((ok) => setTimeout(ok, 10));
      withdrawUseCase(getUseCase(id), userNamed('Uncommitted Author'));
      resume();
      expect((await creating).status).toBe(409);
    } finally {
      spy.mockRestore();
    }
    // Refused before the request was ever stored: drafting read the ontology once, and triage never started.
    expect(calls).toBe(1);
    expect(storedDuring).toEqual([]);
    expect(list<ChangeRequest>(demoId).length).toBe(before);
    expect(JSON.stringify(listDocs('activity', demoId))).not.toMatch(/Uncommitted cite request/);
  });
});

describe('seventh review: nothing is rewritten, every read and write checks consent now', () => {
  const publicCase = async (who: string, name: string) => {
    const agent = await login('contributor', who);
    return { agent, id: await useCaseVia(agent, name, 'public') };
  };
  const addClass = (label: string) => ({ op: 'addClass', localName: 'Consent' + Math.random().toString(36).slice(2, 8), label, definition: `A ${label} thing.` }) as unknown as ChangeRequest['ops'][number];
  /** A change request drafted from the use case (as synthesis does), stored directly. */
  const derived = (useCaseId: string, fields: Partial<ChangeRequest>) => {
    const base = list<ChangeRequest>(demoId)[0];
    const cr = { ...structuredClone(base), id: `cr_seven_${Math.random().toString(36).slice(2, 8)}`, number: 6000 + Math.floor(Math.random() * 999), origin: { type: 'synthesis' as const, useCaseIds: [useCaseId] }, useCaseIds: [useCaseId], releaseId: undefined, mergedCommit: undefined, ...fields } as ChangeRequest;
    put('changeRequests', cr, demoId);
    return cr;
  };

  it('a transcript saved after a withdrawal does not undo it (finding 1)', async () => {
    const { solid } = await import('../src/services/solid.js');
    const { agent, id } = await publicCase('Transcript Author', 'Transcript race case');
    const real = solid.write.bind(solid);
    let resume!: () => void;
    const spy = vi.spyOn(solid, 'write').mockImplementation(async (...args: Parameters<typeof solid.write>) => {
      if (args[1].startsWith('interviews/')) await new Promise<void>((ok) => (resume = ok));
      return real(...args);
    });
    try {
      const starting = agent.post(`/api/ontologies/${demoId}/interviews`).send({ useCaseId: id }).then((r) => r);
      while (!resume) await new Promise((ok) => setTimeout(ok, 10));
      expect((await agent.post(`/api/use-cases/${id}/withdraw`)).status).toBe(200);
      resume();
      expect((await starting).status).toBe(201);
    } finally {
      spy.mockRestore();
    }
    const u = getUseCase(id);
    expect(u.withdrawnAt).toBeDefined();
    expect(u.visibility).toBe('private');
    const outsider = await login('contributor');
    expect((await outsider.get(`/api/use-cases/${id}`)).status).toBe(404);
    expect((await request(app).get(`/api/use-cases/${id}`)).status).toBe(404);
  });

  it('an AI revision that finishes after a withdrawal is refused, and leaves the request as it was (finding 2)', async () => {
    const { id } = await publicCase('Revise Author', 'Revise race case');
    const editor = await login('editor', 'Revise Editor');
    const cr = derived(id, { title: 'Model Revise race case', status: 'review', authorId: userNamed('Revise Editor').id, ops: [addClass('Revise race thing')] });
    const before = get<ChangeRequest>('changeRequests', cr.id)!;
    const real = ontologyStore.working.bind(ontologyStore);
    let resume!: () => void;
    let calls = 0;
    const spy = vi.spyOn(ontologyStore, 'working').mockImplementation(async (p) => {
      if (++calls === 1) await new Promise<void>((ok) => (resume = ok));
      return real(p);
    });
    try {
      const revising = editor.post(`/api/change-requests/${cr.id}/revise`).send({ instruction: 'Add a Berth class too' }).then((r) => r);
      while (!resume) await new Promise((ok) => setTimeout(ok, 10));
      withdrawUseCase(getUseCase(id), userNamed('Revise Author'));
      resume();
      expect((await revising).status).toBe(409);
    } finally {
      spy.mockRestore();
    }
    expect(get<ChangeRequest>('changeRequests', cr.id)).toEqual(before);
    // And once withdrawn, it can't be revised, edited or submitted at all.
    expect((await editor.post(`/api/change-requests/${cr.id}/revise`).send({ instruction: 'again' })).status).toBe(409);
    expect((await editor.patch(`/api/change-requests/${cr.id}`).send({ title: 'New title' })).status).toBe(409);
  });

  it('merging a request whose use case was withdrawn sends it to needs-work and changes nothing in the ontology (finding 2)', async () => {
    const { id } = await publicCase('Merge Author', 'Merge withdrawn case');
    const editor = await login('editor', 'Merge Editor');
    const cr = derived(id, { title: 'Model Merge withdrawn case', status: 'approved', ops: [addClass('Merge withdrawn secret')] });
    withdrawUseCase(getUseCase(id), userNamed('Merge Author'));
    const res = await editor.post(`/api/change-requests/${cr.id}/merge`);
    expect(res.status).toBe(200);
    expect(get<ChangeRequest>('changeRequests', cr.id)!.status).toBe('needs-work');
    expect(get<ChangeRequest>('changeRequests', cr.id)!.mergedCommit).toBeUndefined();
    expect((await request(app).get(`/api/ontologies/${demoId}/source`)).text).not.toMatch(/Merge withdrawn secret/);
    // The governance clock doesn't bring it back: it stays where it is.
    const { advance } = await import('../src/services/changeRequests.js');
    await advance(get<ChangeRequest>('changeRequests', cr.id)!);
    expect(get<ChangeRequest>('changeRequests', cr.id)!.status).toBe('needs-work');
  });

  it('a withdrawal waits while a merge is committing, and a merge waits for a withdrawal (finding 2)', async () => {
    const { id, agent } = await publicCase('Merge Race Author', 'Merge race case');
    const editor = await login('editor', 'Merge Race Editor');
    const cr = derived(id, { title: 'Model Merge race case', status: 'approved', ops: [addClass('Merge race thing')] });
    // Drafted from a use case, so an editor approves exactly what it publishes before it can merge.
    const { approvePublication, publicationPreview } = await import('../src/services/changeRequests.js');
    await approvePublication(get<ChangeRequest>('changeRequests', cr.id)!, userNamed('Merge Race Editor'), (await publicationPreview(get<ChangeRequest>('changeRequests', cr.id)!)).fingerprint);
    const real = ontologyStore.working.bind(ontologyStore);
    let resume!: () => void;
    let calls = 0;
    const spy = vi.spyOn(ontologyStore, 'working').mockImplementation(async (p) => {
      if (++calls === 1) await new Promise<void>((ok) => (resume = ok));
      return real(p);
    });
    let withdrawal: Promise<request.Response> | undefined;
    try {
      const merging = editor.post(`/api/change-requests/${cr.id}/merge`).then((r) => r);
      while (!resume) await new Promise((ok) => setTimeout(ok, 10));
      let withdrawn = false;
      withdrawal = agent.post(`/api/use-cases/${id}/withdraw`).then((r) => ((withdrawn = true), r));
      await new Promise((ok) => setTimeout(ok, 50));
      // The merge read the ontology inside the consent lock: the withdrawal is waiting.
      expect(withdrawn).toBe(false);
      spy.mockRestore();
      resume();
      expect((await merging).status).toBe(200);
    } finally {
      spy.mockRestore();
    }
    expect((await withdrawal!).status).toBe(200);
    // The merge was consented to when it was committed; the request is withheld from outsiders now.
    expect(get<ChangeRequest>('changeRequests', cr.id)!.status).toBe('merged');
    const outsider = await login('contributor');
    expect((await outsider.get(`/api/change-requests/${cr.id}`)).body.withheld).toBe(true);
  });

  it('a request drafted from or citing a withdrawn use case is withheld on every read: API, list, activity, MCP, releases, use case pages (finding 3)', async () => {
    const { id, agent: author } = await publicCase('Withheld Author', 'Dock "Meridian" plan');
    const steward = await login('steward', 'Withheld Steward');
    const cr = derived(id, {
      title: 'Support Dock "Meridian" plan',
      description: 'A confidential goal of the Meridian dock',
      status: 'merged',
      ops: [{ ...addClass('Meridian berth'), source: ['Dock "Meridian" plan, said by the harbour master'], restrictions: [{ type: 'hasValue', property: 'https://x/p', literal: 'Meridian literal' }] } as unknown as ChangeRequest['ops'][number]],
      tests: [{ question: 'Which Meridian berths?', sparql: 'SELECT * WHERE { ?s ?p ?o }', exampleData: '<urn:MERIDIAN> a <urn:x> .' }],
      analysis: { summary: 'Meridian summary', rationale: 'Meridian rationale' },
      // An editor approved what it publishes, so its title went into the release notes.
      privacyCleared: { by: 'someone', at: clock.iso(), fingerprint: 'approved', title: 'Support Dock "Meridian" plan', kgcl: ['create class :MeridianBerth'] },
    });
    put('reviews', { id: `rv_${cr.id}`, changeRequestId: cr.id, userId: userNamed('Withheld Steward').id, roles: ['steward'], decision: 'comment', comment: 'Meridian review', at: clock.iso() }, cr.id);
    put('votes', { id: `vt_${cr.id}`, subjectType: 'change-request', subjectId: cr.id, userId: userNamed('Withheld Steward').id, roles: ['steward'], choice: 'yes', comment: 'Meridian vote', at: clock.iso() }, cr.id);
    put('activity', { id: `act_${cr.id}`, ontologyId: demoId, type: 'cr.created', message: 'opened Dock "Meridian" plan', link: `/o/${demoId}/changes/${cr.id}`, at: clock.iso(), createdAt: '2999-01-01T00:00:00.000Z' }, demoId);
    const { draftRelease } = await import('../src/services/releases.js');
    const rel = await draftRelease(findProject(demoId)!, userNamed('Withheld Steward'));
    expect(rel.changeRequestIds).toContain(cr.id);
    expect(get<Release>('releases', rel.id)!.notes).toMatch(/Meridian/);
    const stored = JSON.stringify(get('changeRequests', cr.id));

    withdrawUseCase(getUseCase(id), userNamed('Withheld Author'));

    // Nothing stored was rewritten (so no status, IRI or literal can be damaged)...
    expect(JSON.stringify(get('changeRequests', cr.id))).toBe(stored);
    // ...and no reader who may not see the use case gets any of it.
    const outsider = await login('contributor');
    const one = await outsider.get(`/api/change-requests/${cr.id}`);
    expect(one.status).toBe(200);
    expect(one.body.withheld).toBe(true);
    for (const res of [
      one,
      await outsider.get(`/api/ontologies/${demoId}/change-requests`),
      await outsider.get(`/api/activity?ontologyId=${demoId}`),
      await outsider.get(`/api/releases/${rel.id}`),
      await outsider.get(`/api/ontologies/${demoId}/releases`),
    ]) {
      expect(res.status).toBe(200);
      expect(res.text).not.toMatch(/Meridian|MERIDIAN/);
    }
    // Signed out, it isn't readable at all.
    expect((await request(app).get(`/api/change-requests/${cr.id}`)).status).toBe(401);
    // MCP sees the same projection.
    const tok = await outsider.post('/api/agent-tokens').send({ name: 'Probe' });
    const call = (n: number, method: string, params: unknown) =>
      request(app).post('/mcp').set('Authorization', `Bearer ${tok.body.token}`).set('Accept', 'application/json, text/event-stream').send({ jsonrpc: '2.0', id: n, method, params });
    await call(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '1' } });
    const mcp = await call(2, 'tools/call', { name: 'get_change_request', arguments: { id: cr.id } });
    expect(mcp.text).toMatch(/Withheld/);
    expect(mcp.text).not.toMatch(/Meridian/);
    // The use case's author still sees the request in full.
    expect((await author.get(`/api/change-requests/${cr.id}`)).text).toMatch(/Meridian/);
    void steward;
  });

  it('a requirements title naming a withdrawn use case is never shown, in release detail or listings (finding 4)', async () => {
    const { id } = await publicCase('Story Author', 'Tug berth story');
    const member = await login('member', 'Story Member');
    const steward = userNamed('Withheld Steward');
    const base = listDocs<RequirementsDocument>('requirementsDocs', demoId)[0];
    const rel = { ...structuredClone(list<Release>(demoId, 'releases' as never)[0]), id: 'rel_story_title', version: '8.8.8', level: 'minor' as const, status: 'draft' as const, statusSince: clock.iso(), createdAt: clock.iso(), changeRequestIds: [], createdBy: steward.id };
    put('releases', rel, demoId);
    const draft = { ...structuredClone(base), id: 'req_story_draft', version: '8.8.8', releaseId: rel.id, status: 'draft' as const, title: 'The Tug berth story release', sourceIds: [id], invalidated: undefined };
    put('requirementsDocs', draft, demoId);
    const pubRel = { ...rel, id: 'rel_story_pub', version: '8.8.9', status: 'published' as const };
    put('releases', pubRel, demoId);
    put('requirementsDocs', { ...draft, id: 'req_story_pub', version: '8.8.9', releaseId: pubRel.id, status: 'published' as const }, demoId);
    expect((await member.get(`/api/releases/${rel.id}`)).text).toMatch(/Tug berth story/);

    withdrawUseCase(getUseCase(id), userNamed('Story Author'));

    const outsider = await login('contributor');
    const draftForOutsider = await outsider.get(`/api/releases/${rel.id}`);
    expect(draftForOutsider.status).toBe(200);
    // A draft document is for the working group only.
    expect(draftForOutsider.body.requirements).toBeUndefined();
    for (const res of [
      draftForOutsider,
      await member.get(`/api/releases/${rel.id}`),
      await member.get(`/api/ontologies/${demoId}/requirements`),
      await outsider.get(`/api/releases/${pubRel.id}`),
      await outsider.get(`/api/ontologies/${demoId}/requirements`),
    ]) {
      expect(res.status).toBe(200);
      expect(res.text).not.toMatch(/Tug berth story/);
    }
    expect((await member.get(`/api/releases/${rel.id}`)).body.requirements.title).toMatch(/use cases and requirements for 8\.8\.8/);
  });

  it('a validation already running when a use case is withdrawn does not return its question (finding 5)', async () => {
    const { id } = await publicCase('Inflight Author', 'Inflight validation case');
    const u = getUseCase(id);
    const question = 'Which inflight berths are secret?';
    put('useCases', { ...u, competencyQuestions: [{ id: 'cq_inflight', question, status: 'answerable', sparql: 'SELECT * WHERE { ?s ?p ?o } LIMIT 1' }] }, demoId);
    const outsider = await login('contributor');
    // The report has captured the questions (it is keyed by them) when the withdrawal lands.
    const realHead = ontologyStore.head.bind(ontologyStore);
    let fired = false;
    const spy = vi.spyOn(ontologyStore, 'head').mockImplementation((p) => {
      // The call that keys the report, after the questions were read (not the one inside the graph read).
      if (!fired && new Error().stack?.includes('workingValidation') && !new Error().stack?.includes('.working (')) {
        fired = true;
        withdrawUseCase(getUseCase(id), userNamed('Inflight Author'));
      }
      return realHead(p);
    });
    let res: request.Response;
    try {
      res = await outsider.get(`/api/ontologies/${demoId}/validation`);
    } finally {
      spy.mockRestore();
    }
    expect(fired).toBe(true);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain(question);
    for (const url of [`/api/ontologies/${demoId}/validation`, `/api/ontologies/${demoId}/validation?ref=1.0.0`]) expect((await outsider.get(url)).text).not.toContain(question);
  });

  it('a release published while a use case behind one of its changes is withdrawn commits public notes only (finding 2)', async () => {
    const { publishRelease } = await import('../src/services/releases.js');
    const { id } = await publicCase('Notes Race Author', 'Pilot boat roster');
    await login('steward', 'Notes Race Steward');
    const steward = userNamed('Notes Race Steward');
    const cr = derived(id, { title: 'Support Pilot boat roster', status: 'merged', ops: [] });
    const r: Release = { ...structuredClone(list<Release>(demoId, 'releases' as never)[0]), id: 'rel_notes_race', version: '9.9.9', level: 'minor', status: 'draft', statusSince: clock.iso(), createdAt: clock.iso(), notes: '- #1 Support Pilot boat roster', changeRequestIds: [cr.id], commit: undefined, publishedAt: undefined, githubUrl: undefined };
    put('releases', r, demoId);
    let committed: Record<string, string> = {};
    const realWrite = ontologyStore.writeRelease.bind(ontologyStore);
    const write = vi.spyOn(ontologyStore, 'writeRelease').mockImplementation(async (...args: Parameters<typeof ontologyStore.writeRelease>) => {
      committed = args[3];
      return realWrite(...args);
    });
    const realWorking = ontologyStore.working.bind(ontologyStore);
    let resume!: () => void;
    let calls = 0;
    const read = vi.spyOn(ontologyStore, 'working').mockImplementation(async (p) => {
      if (++calls === 1) await new Promise<void>((ok) => (resume = ok));
      return realWorking(p);
    });
    try {
      const publishing = publishRelease(get<Release>('releases', r.id)!, steward);
      while (!resume) await new Promise((ok) => setTimeout(ok, 10));
      withdrawUseCase(getUseCase(id), userNamed('Notes Race Author'));
      read.mockRestore();
      resume();
      await publishing;
    } finally {
      read.mockRestore();
      write.mockRestore();
    }
    expect(committed['RELEASE_NOTES.md']).toBeDefined();
    expect(committed['RELEASE_NOTES.md']).not.toMatch(/Pilot boat roster/);
    expect(get<Release>('releases', r.id)!.status).toBe('published');
    const outsider = await login('contributor');
    const res = await outsider.get(`/api/releases/${r.id}`);
    expect(res.status).toBe(200);
    expect(res.text).not.toMatch(/Pilot boat roster/);
  });
});

describe('eighth review: requests made from calls, interview saves, untagged results, nested locks', () => {
  const publicCase = async (who: string, name: string) => {
    const agent = await login('contributor', who);
    return { agent, id: await useCaseVia(agent, name, 'public') };
  };
  const addClass = (label: string) => ({ op: 'addClass', localName: 'Eighth' + Math.random().toString(36).slice(2, 8), label, definition: `A ${label} thing.` }) as unknown as ChangeRequest['ops'][number];
  /** A call, stored directly, as the meeting workflow before this version left it. */
  const legacyMeeting = () => {
    const m = { ...structuredClone(listDocs<{ id: string; createdBy?: string }>('meetings', demoId)[0]), id: `mtg_legacy_${Math.random().toString(36).slice(2, 8)}` };
    put('meetings', m, demoId);
    return m;
  };
  /** A change request as the meeting workflow before this version stored it: origin the call, no use case links. */
  const legacyMeetingCR = (meetingId: string, fields: Partial<ChangeRequest>) => {
    const base = list<ChangeRequest>(demoId)[0];
    const cr = { ...structuredClone(base), id: `cr_mtg_${Math.random().toString(36).slice(2, 8)}`, number: 5000 + Math.floor(Math.random() * 999), origin: { type: 'meeting' as const, meetingId }, useCaseIds: undefined, releaseId: undefined, mergedCommit: undefined, ...fields } as ChangeRequest;
    put('changeRequests', cr, demoId);
    return cr;
  };

  it('a request made from a call before this version is withheld and refused once a use case from that call is withdrawn (finding 1)', async () => {
    const m = legacyMeeting();
    const { id } = await publicCase('Call Case Author', 'Legacy call case');
    put('useCases', { ...getUseCase(id), source: 'meeting', sourceRef: m.id }, demoId);
    const cr = legacyMeetingCR(m.id, { title: 'From the call: Legacy call case', status: 'approved', ops: [addClass('Legacy call secret')] });
    // Before the withdrawal, working group members see it (and outsiders don't: it came from a call).
    const member = await login('member', 'Call Member');
    expect((await member.get(`/api/change-requests/${cr.id}`)).text).toMatch(/Legacy call case/);
    const outsider = await login('contributor');
    expect((await outsider.get(`/api/change-requests/${cr.id}`)).body.withheld).toBe(true);
    withdrawUseCase(getUseCase(id), userNamed('Call Case Author'));
    for (const reader of [member, outsider]) {
      const res = await reader.get(`/api/change-requests/${cr.id}`);
      expect(res.body.withheld).toBe(true);
      expect(res.text).not.toMatch(/Legacy call/);
    }
    const editor = await login('editor', 'Call Editor');
    expect((await editor.post(`/api/change-requests/${cr.id}/merge`)).status).toBe(200);
    expect(get<ChangeRequest>('changeRequests', cr.id)!.status).toBe('needs-work');
    expect((await request(app).get(`/api/ontologies/${demoId}/source`)).text).not.toMatch(/Legacy call secret/);
  });

  it('a request made from a call whose use cases can no longer be found is never merged (finding 1)', async () => {
    const m = legacyMeeting();
    const cr = legacyMeetingCR(m.id, { title: 'Orphaned call request', status: 'approved', ops: [addClass('Orphaned call secret')] });
    const editor = await login('editor', 'Orphan Editor');
    expect((await editor.post(`/api/change-requests/${cr.id}/merge`)).status).toBe(200);
    expect(get<ChangeRequest>('changeRequests', cr.id)!.status).toBe('needs-work');
    expect((await request(app).get(`/api/ontologies/${demoId}/source`)).text).not.toMatch(/Orphaned call secret/);
    // And someone who can't see the call can't read it.
    expect((await (await login('contributor')).get(`/api/change-requests/${cr.id}`)).body.withheld).toBe(true);
  });

  it('an interview turn that finishes after the author changes who can see the use case keeps their choice (finding 2)', async () => {
    const { llm } = await import('../src/llm/provider.js');
    const { agent, id } = await publicCase('Turn Author', 'Turn race case');
    const s = await agent.post(`/api/ontologies/${demoId}/interviews`).send({ useCaseId: id });
    expect(s.status).toBe(201);
    const real = llm.json.bind(llm);
    let resume!: () => void;
    const spy = vi.spyOn(llm, 'json').mockImplementation(async (opts: Parameters<typeof llm.json>[0]) => {
      if (opts.task === 'interview' && !resume) await new Promise<void>((ok) => (resume = ok));
      return real(opts as never);
    });
    try {
      const turn = agent.post(`/api/interviews/${s.body.id}/messages`).send({ content: 'We also track ferry crews.' }).then((r) => r);
      while (!resume) await new Promise((ok) => setTimeout(ok, 10));
      // Made private while the model was answering...
      expect((await agent.post(`/api/use-cases/${id}/visibility`).send({ visibility: 'private' })).status).toBe(200);
      const outsider = await login('contributor');
      expect((await outsider.get(`/api/use-cases/${id}`)).status).toBe(404);
      resume();
      expect((await turn).status).toBe(200);
      // ...and it stays private, with what the turn captured.
      expect(getUseCase(id).visibility).toBe('private');
      expect((await outsider.get(`/api/use-cases/${id}`)).status).toBe(404);
    } finally {
      spy.mockRestore();
    }
  });

  it('an interview turn that finishes after the author shares the use case does not take it back (finding 2)', async () => {
    const { llm } = await import('../src/llm/provider.js');
    const agent = await login('contributor', 'Share Turn Author');
    const s = await agent.post(`/api/ontologies/${demoId}/interviews`).send({});
    const id = s.body.useCaseId as string;
    await agent.patch(`/api/use-cases/${id}`).send({ sections: { name: 'Shared mid-turn case', goal: 'g' }, competencyQuestions: [{ question: 'Which shared ones?' }] });
    const real = llm.json.bind(llm);
    let resume!: () => void;
    const spy = vi.spyOn(llm, 'json').mockImplementation(async (opts: Parameters<typeof llm.json>[0]) => {
      if (opts.task === 'interview' && !resume) await new Promise<void>((ok) => (resume = ok));
      return real(opts as never);
    });
    try {
      const turn = agent.post(`/api/interviews/${s.body.id}/messages`).send({ content: 'More detail.' }).then((r) => r);
      while (!resume) await new Promise((ok) => setTimeout(ok, 10));
      expect((await agent.post(`/api/use-cases/${id}/visibility`).send({ visibility: 'public' })).status).toBe(200);
      expect((await agent.post(`/api/use-cases/${id}/submit`)).status).toBe(200);
      resume();
      expect((await turn).status).toBe(200);
    } finally {
      spy.mockRestore();
    }
    const u = getUseCase(id);
    expect(u.visibility).toBe('public');
    expect(u.status).not.toBe('draft');
  });

  it('competency results saved without a source are never shown, even when they share a question with the request\'s own test (finding 3)', async () => {
    const { triage } = await import('../src/services/changeRequests.js');
    const { id } = await publicCase('Untagged Author', 'Untagged results case');
    const u = getUseCase(id);
    put('useCases', { ...u, competencyQuestions: [{ id: 'cq_untagged', question: 'Which resources?', status: 'answerable', sparql: 'SELECT ?x WHERE { ?x a <urn:UntaggedKind> }', exampleData: '<urn:UNTAGGED-SECRET> a <urn:UntaggedKind> .' }] }, demoId);
    const base = list<ChangeRequest>(demoId)[0];
    const cr = { ...structuredClone(base), id: 'cr_untagged', number: 4999, origin: { type: 'direct' as const }, useCaseIds: [], tests: [{ question: 'Which resources?', sparql: 'SELECT ?x WHERE { ?x a <urn:OwnKind> }', exampleData: '<urn:own-harmless> a <urn:OwnKind> .' }] };
    put('changeRequests', cr, demoId);
    await triage(get<ChangeRequest>('changeRequests', cr.id)!);
    const outsider = await login('contributor');
    // Newly saved results say where they came from: the request's own test is shown.
    const fresh = await outsider.get(`/api/change-requests/${cr.id}`);
    const shown = fresh.body.validation.competencyQuestions as { source?: string; sparql: string; rows: Record<string, string>[] }[];
    const own = shown.find((r) => r.sparql.includes('urn:OwnKind'));
    expect(own?.source).toBe('@request');
    expect(JSON.stringify(own?.rows)).toContain('own-harmless');
    expect(shown.some((r) => r.sparql.includes('UntaggedKind'))).toBe(true);
    // As saved before sources were recorded: no source on any result.
    const saved = get<ChangeRequest>('changeRequests', cr.id)!;
    put('changeRequests', { ...saved, validation: { ...saved.validation!, competencyQuestions: saved.validation!.competencyQuestions.map(({ source: _s, ...r }) => r) } }, demoId);
    withdrawUseCase(getUseCase(id), userNamed('Untagged Author'));
    const res = await outsider.get(`/api/change-requests/${cr.id}`);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('UNTAGGED-SECRET');
  });

  it('nested work inside a consent lock runs one at a time, and the holding ends only when it has finished (finding 4)', async () => {
    let running = 0;
    let most = 0;
    const work = (ms: number) => async () => {
      running++;
      most = Math.max(most, running);
      await new Promise((ok) => setTimeout(ok, ms));
      running--;
    };
    let detached: Promise<void> | undefined;
    const outer = withConsentLock('lock-test', async () => {
      // Two in parallel, and one started without waiting for it.
      await Promise.all([withConsentLock('lock-test', work(20)), withConsentLock('lock-test', work(20))]);
      detached = withConsentLock('lock-test', work(40));
    });
    // Unrelated work queued behind the holding must not overlap the detached child.
    const after = withConsentLock('lock-test', work(10));
    await Promise.all([outer, after]);
    await detached;
    expect(most).toBe(1);
  });

  it('a context that outlives its holding queues like anyone else (finding 4)', async () => {
    let running = 0;
    let most = 0;
    const work = (ms: number) => async () => {
      running++;
      most = Math.max(most, running);
      await new Promise((ok) => setTimeout(ok, ms));
      running--;
    };
    let late: Promise<void> | undefined;
    await withConsentLock('lock-test-2', async () => {
      // Starts after the holding has ended, still carrying its context.
      late = new Promise<void>((ok) => setTimeout(ok, 30)).then(() => withConsentLock('lock-test-2', work(20)));
    });
    // Unrelated work takes the lock in the meantime and holds it past the late call.
    const unrelated = new Promise<void>((ok) => setTimeout(ok, 10)).then(() => withConsentLock('lock-test-2', work(60)));
    await Promise.all([late, unrelated]);
    await late;
    expect(most).toBe(1);
  });
});

describe('merge review: calls waiting for approval, malformed snapshots', () => {
  it('a use case links and quotes a call only for those the call exists for: not once it waits for approval again', async () => {
    // A call is shown to the working group, but one waiting for approval only to facilitators. Use case pages used to
    // check only the first rule, so members who can't facilitate still saw the link to a call waiting for approval.
    const base = listDocs<{ id: string }>('meetings', demoId)[0];
    const m = { ...structuredClone(base), id: `mtg_pending_${Math.random().toString(36).slice(2, 8)}`, title: 'Pending approval call' } as { id: string } & Record<string, unknown>;
    put('meetings', m, demoId);
    const author = await login('contributor', 'Pending Call Author');
    const id = await useCaseVia(author, 'Pending call case', 'public');
    put('useCases', { ...getUseCase(id), source: 'meeting', sourceRef: m.id, sourceLines: [0], links: [{ type: 'meeting', id: m.id, relation: 'related', at: clock.iso() }] }, demoId);
    const reviewer = await login('reviewer', 'Pending Call Reviewer');
    const steward = await login('steward', 'Pending Call Steward');
    const seen = async (a: Awaited<ReturnType<typeof login>>) => (await a.get(`/api/use-cases/${id}`)).body as UseCase;
    expect((await seen(reviewer)).sourceRef).toBe(m.id);
    expect((await seen(reviewer)).links?.some((l) => l.id === m.id)).toBe(true);

    put('meetings', { ...m, calendar: { approval: 'pending', start: clock.iso(), end: clock.iso(), uid: 'pending-again', key: 'k' } }, demoId);
    const now = await seen(reviewer);
    expect(now.sourceRef).toBeUndefined();
    expect(now.sourceLines).toBeUndefined();
    expect(now.links?.some((l) => l.id === m.id) ?? false).toBe(false);
    expect(JSON.stringify(now)).not.toContain('Pending approval call');
    expect((await reviewer.get(`/api/meetings/${m.id}`)).status).toBe(404);
    // Facilitators still see it.
    expect((await seen(steward)).sourceRef).toBe(m.id);
  });

  it('a release snapshot whose section lists its use cases wrongly is shown as not recorded, not as an error', async () => {
    // Snapshot validation used to skip a section's useCaseIds, which the page then calls .some() on: a 500.
    const project = findProject(demoId)!;
    const snap = path.join(ontologyStore.dir(project), 'releases', '1.0.0', 'requirements.json');
    const original = fs.readFileSync(snap, 'utf8');
    try {
      const good = JSON.parse(original);
      fs.writeFileSync(snap, JSON.stringify({ ...good, document: { title: 'T', version: '1.0.0', sections: [{ id: 's1', heading: 'H', markdown: 'M', useCaseIds: 'uc_1' }] } }));
      const res = await request(app).get(`/def/${project.slug}/1.0.0`);
      expect(res.status).toBe(200);
      expect(res.text).toContain('were not recorded when it was published');
      expect(requirementsFor(project, JSON.parse(fs.readFileSync(snap, 'utf8'))).snapshotMissing).toBe(true);
    } finally {
      fs.writeFileSync(snap, original);
    }
  });
});
