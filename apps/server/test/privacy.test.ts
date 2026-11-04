import type { ChangeRequest, Release, UseCase, User } from '@concord/shared';
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

  it('keeps group-only competency questions out of public validation, and drops a withdrawn one from saved results (finding 4)', async () => {
    const member = await login('member');
    const id = await useCaseVia(member, 'Hidden question case', 'group');
    const raw = getUseCase(id);
    raw.competencyQuestions[0].sparql = 'SELECT * WHERE { ?s ?p ?o } LIMIT 1';
    put('useCases', raw, raw.ontologyId);
    const v = await request(app).get(`/api/ontologies/${demoId}/validation`);
    expect(JSON.stringify(v.body)).not.toMatch(/Hidden question case/);
    // A public one's question runs; once withdrawn it leaves saved change request results.
    put('useCases', { ...raw, visibility: 'public' }, raw.ontologyId);
    const cr = list<ChangeRequest>(demoId)[0];
    put('changeRequests', { ...cr, validation: { ...cr.validation!, competencyQuestions: [...(cr.validation?.competencyQuestions ?? []), { question: raw.competencyQuestions[0].question, passed: true, rows: 1 } as never] } }, demoId);
    expect((await member.post(`/api/use-cases/${id}/withdraw`)).status).toBe(200);
    expect(JSON.stringify(get<ChangeRequest>('changeRequests', cr.id)!.validation)).not.toMatch(/Hidden question case/);
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

  it('withdrawal removes every question the use case had while public, from saved results and drafted tests (finding 4)', async () => {
    const author = await login('contributor', 'Question Author');
    const id = await useCaseVia(author, 'Edited question case', 'public');
    const original = getUseCase(id).competencyQuestions[0].question;
    const cr = list<ChangeRequest>(demoId)[0];
    const saved = structuredClone(cr);
    put('changeRequests', {
      ...cr,
      tests: [...(cr.tests ?? []), { question: original, sparql: 'SELECT * WHERE { ?s ?p ?o }', exampleData: '<urn:SECRET-EXAMPLE> a <urn:x> .' }],
      validation: cr.validation && { ...cr.validation, competencyQuestions: [...cr.validation.competencyQuestions, { question: original, passed: true } as never] },
    }, demoId);
    // Edited before withdrawal: the old wording is still removed.
    expect((await author.patch(`/api/use-cases/${id}`).send({ competencyQuestions: [{ question: 'A reworded question?' }] })).status).toBe(200);
    expect((await author.post(`/api/use-cases/${id}/withdraw`)).status).toBe(200);
    const after = JSON.stringify(get<ChangeRequest>('changeRequests', cr.id));
    expect(after).not.toContain(original);
    expect(after).not.toContain('SECRET-EXAMPLE');
    put('changeRequests', saved, demoId);
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

  it('a retriage that was running when a use case was withdrawn does not bring its tests back (finding 4)', async () => {
    const { triage } = await import('../src/services/changeRequests.js');
    const author = await login('contributor', 'Retriage Author');
    const id = await useCaseVia(author, 'Retriage race', 'public');
    const q = getUseCase(id).competencyQuestions[0].question;
    const cr = list<ChangeRequest>(demoId)[0];
    const saved = structuredClone(cr);
    put('changeRequests', { ...cr, tests: [...(cr.tests ?? []), { question: q, sparql: 'SELECT * WHERE { ?s ?p ?o }', exampleData: '<urn:RETRIAGE-SECRET> a <urn:x> .' }] }, demoId);
    const running = triage(get<ChangeRequest>('changeRequests', cr.id)!);
    withdrawUseCase(getUseCase(id), userNamed('Retriage Author'));
    await running;
    const after = JSON.stringify(get<ChangeRequest>('changeRequests', cr.id));
    expect(after).not.toContain('RETRIAGE-SECRET');
    expect(after).not.toContain(q);
    put('changeRequests', saved, demoId);
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

describe('fifth review: retriage refresh, title copies, draft triage, citing drafts', () => {
  /** A copy of a seeded change request, stored under a new id, with the given fields. */
  const crCopy = (fields: Partial<ChangeRequest>) => {
    const base = list<ChangeRequest>(demoId)[0];
    const cr = { ...structuredClone(base), id: `cr_test_${Math.random().toString(36).slice(2, 8)}`, number: 9000 + Math.floor(Math.random() * 999), useCaseIds: [], ...fields } as ChangeRequest;
    put('changeRequests', cr, demoId);
    return cr;
  };
  /** A public, submitted use case created as `name`'s, with one question. */
  const publicCase = async (who: string, name: string) => {
    const agent = await login('contributor', who);
    return { agent, id: await useCaseVia(agent, name, 'public') };
  };

  it('a retriage handed a record from before a withdrawal does not put the withdrawn title back (finding 2)', async () => {
    const { triage } = await import('../src/services/changeRequests.js');
    const { id } = await publicCase('Retitle Author', 'Lighthouse keeper rota');
    const cr = crCopy({ title: 'Support Lighthouse keeper rota', description: 'From Lighthouse keeper rota' });
    // A caller loaded the request before the withdrawal...
    const stale = structuredClone(get<ChangeRequest>('changeRequests', cr.id)!);
    withdrawUseCase(getUseCase(id), userNamed('Retitle Author'));
    expect(get<ChangeRequest>('changeRequests', cr.id)!.title).not.toMatch(/Lighthouse keeper rota/);
    // ...and triages it afterwards: the stored, redacted record wins.
    await triage(stale);
    expect(JSON.stringify(get<ChangeRequest>('changeRequests', cr.id))).not.toMatch(/Lighthouse keeper rota/);
  });

  it('a withdrawal during a retriage takes effect on what the retriage saves (finding 2)', async () => {
    const { triage } = await import('../src/services/changeRequests.js');
    const { id } = await publicCase('Midrun Author', 'Tidal gauge archive');
    const cr = crCopy({ title: 'Model Tidal gauge archive' });
    const running = triage(get<ChangeRequest>('changeRequests', cr.id)!);
    withdrawUseCase(getUseCase(id), userNamed('Midrun Author'));
    await running;
    const saved = get<ChangeRequest>('changeRequests', cr.id)!;
    expect(JSON.stringify(saved)).not.toMatch(/Tidal gauge archive/);
    expect(saved.timeline.some((e) => e.type === 'triaged')).toBe(true);
  });

  it('when use cases keep being withdrawn, a retriage gives up without saving stale tests or results (finding 2)', async () => {
    const { triage } = await import('../src/services/changeRequests.js');
    const sources: { agent: Agent; id: string; n: number }[] = [];
    for (const n of [1, 2, 3]) sources.push({ ...(await publicCase(`Churn Author ${n}`, `Churn source ${n}`)), n });
    const q = getUseCase(sources[0].id).competencyQuestions[0].question;
    const cr = crCopy({ title: 'Churn source 1 support', tests: [{ question: q, sparql: 'SELECT ?x WHERE { ?x a <urn:ChurnKind> }', exampleData: '<urn:CHURN_SECRET> a <urn:ChurnKind> .' }] });
    let calls = 0;
    const real = ontologyStore.working.bind(ontologyStore);
    // Each attempt reads the ontology once; withdraw another source each time.
    const spy = vi.spyOn(ontologyStore, 'working').mockImplementation(async (p) => {
      const s = sources[calls++];
      if (s) withdrawUseCase(getUseCase(s.id), userNamed(`Churn Author ${s.n}`));
      return real(p);
    });
    try {
      await triage(get<ChangeRequest>('changeRequests', cr.id)!);
    } finally {
      spy.mockRestore();
    }
    expect(calls).toBe(3);
    const saved = get<ChangeRequest>('changeRequests', cr.id)!;
    expect(saved.tests ?? []).toEqual([]);
    expect(saved.validation?.competencyQuestions).toEqual([]);
    expect(JSON.stringify(saved)).not.toMatch(/CHURN_SECRET|Churn source 1/);
    expect(saved.timeline.at(-1)!.message).toMatch(/results were not updated/);
  });

  it('withdrawal takes every title the use case had out of change requests, reviews, votes, releases and activity (finding 3)', async () => {
    const { agent, id } = await publicCase('Copies Author', 'Ferry timetable sync');
    // Renamed while public: both names were out there.
    expect((await agent.patch(`/api/use-cases/${id}`).send({ sections: { name: 'Harbour berth booking' } })).status).toBe(200);
    // No questions left: titles still go.
    put('useCases', { ...getUseCase(id), competencyQuestions: [] }, demoId);
    const said = 'Ferry timetable sync and Harbour berth booking';
    const cr = crCopy({
      title: `Add ${said}`,
      description: said,
      warnings: [`Overlaps ${said}`],
      analysis: { summary: said, rationale: `Because ${said}`, risks: [`Risky for ${said}`] },
      timeline: [{ at: clock.iso(), type: 'created', message: `opened for ${said}` }],
    } as Partial<ChangeRequest>);
    put('reviews', { id: `rv_${cr.id}`, changeRequestId: cr.id, comment: `Good for ${said}` }, cr.id);
    put('votes', { id: `vt_${cr.id}`, changeRequestId: cr.id, comment: `Yes to ${said}` }, cr.id);
    const rel = { ...structuredClone(list<Release>(demoId, 'releases' as never)[0]), id: `rel_test_${cr.id}`, notes: `Delivers ${said}` };
    put('releases', rel, demoId);
    put('votes', { id: `rvt_${cr.id}`, releaseId: rel.id, comment: `Ship ${said}` }, rel.id);
    put('activity', { id: `act_${cr.id}`, ontologyId: demoId, type: 'cr.created', message: `opened ${said}`, link: `/o/${demoId}/changes/${cr.id}`, at: clock.iso(), createdAt: clock.iso() }, demoId);

    withdrawUseCase(getUseCase(id), userNamed('Copies Author'));

    const docs = [
      get('changeRequests', cr.id),
      get('reviews', `rv_${cr.id}`),
      get('votes', `vt_${cr.id}`),
      get('releases', rel.id),
      get('votes', `rvt_${cr.id}`),
      get('activity', `act_${cr.id}`),
    ];
    for (const d of docs) {
      expect(d).toBeTruthy();
      expect(JSON.stringify(d)).not.toMatch(/Ferry timetable sync|Harbour berth booking/i);
      expect(JSON.stringify(d)).toMatch(/no longer public/);
    }
    // Ids and links are left alone.
    expect((get<{ link: string }>('activity', `act_${cr.id}`))!.link).toBe(`/o/${demoId}/changes/${cr.id}`);
    expect((get<{ releaseId: string }>('votes', `rvt_${cr.id}`))!.releaseId).toBe(rel.id);
    // The simulation feed shows the redacted activity.
    const outsider = await login('contributor');
    expect((await outsider.post('/api/simulation/step').send({ ontologyId: demoId })).text).not.toMatch(/Ferry timetable sync|Harbour berth booking/);
  });

  it('a short title is taken out as a word, not out of other words (finding 3)', async () => {
    const { agent, id } = await publicCase('Short Author', 'Short placeholder');
    expect((await agent.patch(`/api/use-cases/${id}`).send({ sections: { name: 'Qz' } })).status).toBe(200);
    const cr = crCopy({ title: 'Qz support for Qzyx and FooQz', description: 'qz, then Qz.' });
    withdrawUseCase(getUseCase(id), userNamed('Short Author'));
    const saved = get<ChangeRequest>('changeRequests', cr.id)!;
    expect(saved.title).toBe('a use case that is no longer public support for Qzyx and FooQz');
    expect(saved.description).toBe('a use case that is no longer public, then a use case that is no longer public.');
  });

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

  it('a use case withdrawn while a change request citing it is drafted leaves no change request behind (new finding)', async () => {
    const { agent, id } = await publicCase('Cite Race Author', 'Cite race case');
    const before = list<ChangeRequest>(demoId).length;
    const real = ontologyStore.working.bind(ontologyStore);
    let once = false;
    const spy = vi.spyOn(ontologyStore, 'working').mockImplementation(async (p) => {
      if (!once) {
        once = true;
        withdrawUseCase(getUseCase(id), userNamed('Cite Race Author'));
      }
      return real(p);
    });
    try {
      const res = await agent.post(`/api/ontologies/${demoId}/change-requests`).send({ title: 'Cite race request', naturalLanguage: 'Add a Shift class', useCaseIds: [id] });
      expect(res.status).toBe(409);
    } finally {
      spy.mockRestore();
    }
    expect(once).toBe(true);
    expect(list<ChangeRequest>(demoId).length).toBe(before);
    expect(JSON.stringify(listDocs('activity', demoId))).not.toMatch(/Cite race request/);
  });
});

describe('sixth review: prose-only redaction, final-attempt retriage, release notes, legacy titles, uncommitted requests', () => {
  const crCopy = (fields: Partial<ChangeRequest>) => {
    const base = list<ChangeRequest>(demoId)[0];
    const cr = { ...structuredClone(base), id: `cr_six_${Math.random().toString(36).slice(2, 8)}`, number: 8000 + Math.floor(Math.random() * 999), useCaseIds: [], ...fields } as ChangeRequest;
    put('changeRequests', cr, demoId);
    return cr;
  };
  const publicCase = async (who: string, name: string) => {
    const agent = await login('contributor', who);
    return { agent, id: await useCaseVia(agent, name, 'public') };
  };
  const addClass = (label: string) => ({ op: 'addClass', localName: 'Withheld' + Math.random().toString(36).slice(2, 6), label, definition: `A ${label} thing.` }) as unknown as ChangeRequest['ops'][number];

  it('a title like "draft" changes no status, kind or operation name, only prose (new finding)', async () => {
    const { agent, id } = await publicCase('Status Word Author', 'Status word placeholder');
    expect((await agent.patch(`/api/use-cases/${id}`).send({ sections: { name: 'draft' } })).status).toBe(200);
    const author = await login('contributor', 'Status Word CR Author');
    const crAuthor = userNamed('Status Word CR Author');
    const cr = crCopy({ status: 'draft', kind: 'feature', authorId: crAuthor.id, title: 'A draft of shifts', description: 'see the draft', ops: [addClass('Shift')] });
    const rel = { ...structuredClone(list<Release>(demoId, 'releases' as never)[0]), id: `rel_six_${cr.id}`, status: 'draft' as const, notes: 'Notes on the draft' };
    put('releases', rel, demoId);
    withdrawUseCase(getUseCase(id), userNamed('Status Word Author'));
    const saved = get<ChangeRequest>('changeRequests', cr.id)!;
    expect(saved.status).toBe('draft');
    expect(saved.kind).toBe('feature');
    expect(saved.ops[0].op).toBe('addClass');
    expect(saved.title).toBe('A a use case that is no longer public of shifts');
    expect(get<Release>('releases', rel.id)!.status).toBe('draft');
    expect(get<Release>('releases', rel.id)!.notes).toBe('Notes on the a use case that is no longer public');
    // The workflow still works on it.
    expect((await author.post(`/api/change-requests/${cr.id}/submit`)).status).toBe(200);
  });

  it('IRIs and ids keep their exact value even when a title appears in them (new finding)', async () => {
    const { agent, id } = await publicCase('Iri Word Author', 'Iri placeholder');
    expect((await agent.patch(`/api/use-cases/${id}`).send({ sections: { name: 'Berth' } })).status).toBe(200);
    const op = { op: 'setSuperClasses', iri: 'https://w3id.org/x#Berth', superClasses: ['https://w3id.org/x#Berth'] } as unknown as ChangeRequest['ops'][number];
    const cr = crCopy({ title: 'Berth changes', ops: [op] });
    withdrawUseCase(getUseCase(id), userNamed('Iri Word Author'));
    const saved = get<ChangeRequest>('changeRequests', cr.id)!;
    expect(saved.ops[0]).toEqual(op);
    expect(saved.title).toBe('a use case that is no longer public changes');
  });

  it('a one-character title is taken out too, as a word (finding 2)', async () => {
    const { agent, id } = await publicCase('One Char Author', 'One char placeholder');
    expect((await agent.patch(`/api/use-cases/${id}`).send({ sections: { name: 'X' } })).status).toBe(200);
    const cr = crCopy({ title: 'X marks the spot, eXtra Xylophone', description: 'see x.' });
    withdrawUseCase(getUseCase(id), userNamed('One Char Author'));
    const saved = get<ChangeRequest>('changeRequests', cr.id)!;
    expect(saved.title).toBe('a use case that is no longer public marks the spot, eXtra Xylophone');
    expect(saved.description).toBe('see a use case that is no longer public.');
  });

  it('a use case saved before titles were tracked still has its old public name taken out after a rename (finding 2)', async () => {
    const { agent, id } = await publicCase('Legacy Author', 'Legacy dock ledger');
    // As stored by an earlier version: no record of past titles or questions.
    const legacy = getUseCase(id) as UseCase & Record<string, unknown>;
    delete legacy.publicTitles;
    delete legacy.publicQuestions;
    put('useCases', legacy, demoId);
    expect((await agent.patch(`/api/use-cases/${id}`).send({ sections: { name: 'Renamed ledger' } })).status).toBe(200);
    const cr = crCopy({ title: 'From Legacy dock ledger', description: 'and Renamed ledger' });
    withdrawUseCase(getUseCase(id), userNamed('Legacy Author'));
    expect(JSON.stringify(get('changeRequests', cr.id))).not.toMatch(/Legacy dock ledger|Renamed ledger/);
  });

  it('a retriage that gives up keeps nothing from its runs: not the diff, not a new analysis (finding 1)', async () => {
    const { triage } = await import('../src/services/changeRequests.js');
    const sources: { id: string; n: number }[] = [];
    for (const n of [1, 2, 3]) sources.push({ id: (await publicCase(`Final Churn ${n}`, `Final churn source ${n}`)).id, n });
    // The secret is the last source's title, in the proposed edits and the stored diff.
    const cr = crCopy({ title: 'Model berths', ops: [addClass('Final churn source 3')], analysis: undefined, diff: undefined, validation: undefined });
    await triage(get<ChangeRequest>('changeRequests', cr.id)!);
    expect(JSON.stringify(get<ChangeRequest>('changeRequests', cr.id)!.diff)).toMatch(/Final churn source 3/);
    // Stored without an analysis, so a new one could only come from these runs.
    const { analysis: _a, ...noAnalysis } = get<ChangeRequest>('changeRequests', cr.id)!;
    put('changeRequests', noAnalysis, demoId);
    let calls = 0;
    const real = ontologyStore.working.bind(ontologyStore);
    // Withdraw a source during each attempt; the last one is the source quoted in the edits.
    const spy = vi.spyOn(ontologyStore, 'working').mockImplementation(async (p) => {
      const s = sources[calls++];
      const out = await real(p);
      if (s) withdrawUseCase(getUseCase(s.id), userNamed(`Final Churn ${s.n}`));
      return out;
    });
    try {
      await triage(get<ChangeRequest>('changeRequests', cr.id)!);
    } finally {
      spy.mockRestore();
    }
    expect(calls).toBe(3);
    const saved = get<ChangeRequest>('changeRequests', cr.id)!;
    expect(JSON.stringify(saved)).not.toMatch(/Final churn source/);
    expect(saved.analysis).toBeUndefined();
    expect(saved.timeline.at(-1)!.message).toMatch(/results were not updated/);
    // A signed-in non-member reading it sees none of it either.
    const outsider = await login('contributor');
    expect((await outsider.get(`/api/change-requests/${cr.id}`)).text).not.toMatch(/Final churn source/);
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
    expect(storedDuring.every((n) => n === before)).toBe(true);
    expect(list<ChangeRequest>(demoId).length).toBe(before);
    expect(JSON.stringify(listDocs('activity', demoId))).not.toMatch(/Uncommitted cite request/);
  });

  it('publishing works from the stored release, so notes scrubbed by a withdrawal mid-publication stay scrubbed (finding 2)', async () => {
    const { publishRelease } = await import('../src/services/releases.js');
    const { id } = await publicCase('Notes Race Author', 'Pilot boat roster');
    await login('steward', 'Notes Race Steward');
    const steward = userNamed('Notes Race Steward');
    const r: Release = { ...structuredClone(list<Release>(demoId, 'releases' as never)[0]), id: 'rel_notes_race', version: '9.9.9', status: 'draft', notes: 'Adds Pilot boat roster', changeRequestIds: [], commit: undefined, publishedAt: undefined, githubUrl: undefined };
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
      // Publication is reading the ontology, before it takes the consent lock: the withdrawal goes through.
      withdrawUseCase(getUseCase(id), userNamed('Notes Race Author'));
      expect(get<Release>('releases', r.id)!.notes).not.toMatch(/Pilot boat roster/);
      read.mockRestore();
      resume();
      await publishing;
    } finally {
      read.mockRestore();
      write.mockRestore();
    }
    expect(committed['RELEASE_NOTES.md']).toBeDefined();
    expect(committed['RELEASE_NOTES.md']).not.toMatch(/Pilot boat roster/);
    const stored = get<Release>('releases', r.id)!;
    expect(stored.status).toBe('published');
    expect(stored.notes).not.toMatch(/Pilot boat roster/);
    const outsider = await login('contributor');
    expect((await outsider.get(`/api/releases/${r.id}`)).text).not.toMatch(/Pilot boat roster/);
  });
});
