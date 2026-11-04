import type { ChangeRequest, Release, UseCase } from '@concord/shared';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { get, list as listDocs, openDb, put } from '../src/db.js';
import { findDocument, generateRequirements, toPublic } from '../src/services/requirements.js';
import { findProject } from '../src/services/ontologies.js';
import { seedDemo } from '../src/services/simulation.js';
import { completingRelease } from '../src/services/traceability.js';
import { getUseCase, heuristicAnonymise, identifyingWarnings, restrictDraft } from '../src/services/useCases.js';

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
    expect((await request(app).get(`/api/ontologies/${demoId}/meetings`)).body).toEqual([]);
    expect((await request(app).get(`/api/meetings/${id}`)).status).toBe(404);
    expect((await request(app).get(`/api/meetings/${id}/stream`)).status).toBe(404);
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
    const anon = await request(app).get(`/api/change-requests/${someCr.id}`);
    expect(anon.body.useCaseIds ?? []).not.toContain(id);
    const listed = (await request(app).get(`/api/ontologies/${demoId}/change-requests`)).body as ChangeRequest[];
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
    const anon = (await request(app).get(`/api/activity?ontologyId=${demoId}`)).body as { message: string; link?: string }[];
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
    // The draft that cited it is gone, and the next read writes a fresh one without it.
    expect(findDocument(demoId, '9.9.9')).toBeUndefined();
    put('requirementsDocs', doc, demoId);
    const read = await steward.get(`/api/ontologies/${demoId}/requirements/9.9.9`);
    expect(read.status).toBe(200);
    expect(JSON.stringify(read.body)).not.toMatch(/Withdrawn later case/);
  });

  it('shows the group-only count to the group only', async () => {
    const pub = await request(app).get(`/api/ontologies/${demoId}/requirements/1.0.0`);
    expect(pub.body.unpublished).toBeUndefined();
    const md = await request(app).get(`/api/ontologies/${demoId}/requirements/1.0.0/markdown`);
    expect(md.text).not.toMatch(/not published|private/i);
  });

  it('counts only the use cases a viewer can see (finding 11)', async () => {
    const anonList = (await request(app).get(`/api/ontologies/${demoId}/use-cases`)).body as UseCase[];
    const summary = (await request(app).get(`/api/ontologies/${demoId}`)).body as { stats: { useCases: number } };
    expect(summary.stats.useCases).toBe(anonList.length);
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
    const r1 = { id: 'rel_a', ontologyId: demoId, version: '1.0.0', status: 'published', publishedAt: '2026-01-01T00:00:00Z', changeRequestIds: [] } as unknown as Release;
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

function list<T>(ontologyId: string, collection: 'changeRequests' | 'useCases' = 'changeRequests'): T[] {
  return listDocs<T>(collection, ontologyId);
}
