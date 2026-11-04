import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { seedDemo } from '../src/services/simulation.js';
import { heuristicAnonymise } from '../src/services/useCases.js';

const app = createApp();
type Agent = ReturnType<typeof request.agent>;

async function login(role: string, name = `Tester ${role}`): Promise<Agent> {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/demo').send({ name, role });
  expect(res.status).toBe(200);
  return agent;
}

interface UC {
  id: string;
  number: number;
  status: string;
  visibility: string;
  authorId: string;
  anonymous?: boolean;
  source: string;
  sections: { name?: string; goal?: string };
  anonymisation?: { status: string; draft?: { sections: { name?: string; goal?: string }; changes: string[] } };
}

let demoId: string;
const byName = (list: UC[], name: string) => list.find((u) => u.sections.name === name);

beforeAll(async () => {
  openDb();
  demoId = (await seedDemo())!.id;
});

const SCRIPT = [
  'We want to help Riverside Youth Trust match young people with short volunteering opportunities near their school.',
  'Students, teachers, the council youth service and local charities.',
  'A student in Northvale wants a one-off Saturday activity. Email jo.bloggs@example.org for details.',
  'A teacher wants to find group opportunities for a whole class.',
  '1. Charity posts an opportunity. 2. Platform checks the minimum age. 3. Student applies.',
  'Sometimes the opportunity is cancelled because of weather.',
  'Which opportunities near Northvale accept 15-year-olds? -> Park clean-up on Saturday\nWhich charities offer group volunteering? -> Northvale Food Bank',
  'Our CRM and a shared spreadsheet.',
  'Paid placements are out of scope.',
];

async function interview(agent: Agent) {
  const s = await agent.post(`/api/ontologies/${demoId}/interviews`).send({});
  expect(s.status).toBe(201);
  let r;
  for (const content of SCRIPT) {
    r = await agent.post(`/api/interviews/${s.body.id}/messages`).send({ content });
    expect(r.status).toBe(200);
    if (r.body.session.done) break;
  }
  if (!r!.body.session.done) await agent.post(`/api/interviews/${s.body.id}/finish`);
  return { sessionId: s.body.id as string, useCaseId: r!.body.useCase.id as string };
}

describe('sharing modes', () => {
  it('shows signed-out visitors only public use cases, and the working group its own as well', async () => {
    const anon = await request(app).get(`/api/ontologies/${demoId}/use-cases`);
    expect(anon.status).toBe(200);
    // The anonymised version of Mei's private use case keeps its title, so look only at non-anonymous ones.
    const names = anon.body.filter((u: UC) => !u.anonymous).map((u: UC) => u.sections.name);
    expect(names).toContain('Aggregate volunteering opportunities across platforms');
    expect(names).toContain('Find weekly shifts that need volunteers');
    expect(names).not.toContain('Publish recurring shifts once'); // working group only
    expect(names).not.toContain('Report volunteering hours to our funders'); // private
    expect(anon.body.every((u: UC) => u.visibility === 'public')).toBe(true);

    const member = await login('member', 'Member Mo');
    const m = await member.get(`/api/ontologies/${demoId}/use-cases`);
    const mNames = m.body.filter((u: UC) => !u.anonymous).map((u: UC) => u.sections.name);
    expect(mNames).toContain('Publish recurring shifts once');
    expect(mNames).not.toContain('Report volunteering hours to our funders');

    // A contributor is not a working group member.
    const contributor = await login('contributor', 'Contributor Cy');
    const c = await contributor.get(`/api/ontologies/${demoId}/use-cases`);
    expect(c.body.map((u: UC) => u.sections.name)).not.toContain('Publish recurring shifts once');
  });

  it('numbers use cases and hides the author of anonymised ones', async () => {
    const anon = await request(app).get(`/api/ontologies/${demoId}/use-cases`);
    const numbers = anon.body.map((u: UC) => u.number);
    expect(new Set(numbers).size).toBe(numbers.length);
    const synthetic = anon.body.find((u: UC) => u.anonymous);
    expect(synthetic).toBeTruthy();
    expect(synthetic.authorId).toBe('anonymous');
    expect(synthetic.anonymisation).toBeUndefined();
    // Nothing identifying survives the anonymisation.
    const text = JSON.stringify(synthetic);
    expect(text).not.toMatch(/Mei|St Anne|stannes|Lottery Community Fund/);
    // The activity feed doesn't say who published it.
    const act = await request(app).get(`/api/activity?ontologyId=${demoId}`);
    const item = act.body.find((a: { type: string }) => a.type === 'usecase.anonymised');
    expect(item).toBeTruthy();
    expect(item.actorId).toBeUndefined();
  });

  it('keeps an interview private, offers an anonymised version and publishes it only with consent', async () => {
    const author = await login('contributor', 'Jo Bloggs');
    const { sessionId, useCaseId } = await interview(author);
    const mine = await author.get(`/api/use-cases/${useCaseId}`);
    expect(mine.status).toBe(200);
    expect(mine.body.visibility).toBe('private');
    expect(mine.body.status).toBe('draft');
    expect(mine.body.anonymisation.status).toBe('proposed');
    const draft = mine.body.anonymisation.draft;
    expect(JSON.stringify(draft)).not.toMatch(/jo\.bloggs@example\.org|Riverside Youth Trust|Bloggs/);
    expect(draft.changes.length).toBeGreaterThan(0);
    expect(mine.body.can.changeVisibility).toBe(true);

    // The interviewer asks for consent in the conversation.
    const s = await author.get(`/api/interviews/${sessionId}`);
    expect(s.body.messages.at(-1).content).toMatch(/anonymised, synthetic version/);

    // Nobody else can see it, or tell that it exists.
    const editor = await login('editor', 'Editor Ian');
    expect((await editor.get(`/api/use-cases/${useCaseId}`)).status).toBe(404);
    expect((await request(app).get(`/api/use-cases/${useCaseId}`)).status).toBe(404);
    expect((await editor.get(`/api/ontologies/${demoId}/use-cases`)).body.some((u: UC) => u.id === useCaseId)).toBe(false);
    expect((await editor.post(`/api/use-cases/${useCaseId}/visibility`).send({ visibility: 'public' })).status).toBe(404);

    // It can't be used for a change request directly.
    const syn = await author.post(`/api/ontologies/${demoId}/synthesise`).send({ useCaseIds: [useCaseId] });
    expect(syn.status).toBe(409);

    // The author edits the title and consents.
    const pub = await author.post(`/api/use-cases/${useCaseId}/anonymise/publish`).send({ draft: { sections: { ...draft.sections, name: 'Match young people with local opportunities' } } });
    expect(pub.status).toBe(200);
    expect(pub.body.original.anonymisation.status).toBe('published');
    const publishedId = pub.body.published.id;
    expect(pub.body.published.visibility).toBe('public');
    expect(pub.body.published.status).toBe('triage');

    const seen = await request(app).get(`/api/use-cases/${publishedId}`);
    expect(seen.status).toBe(200);
    expect(seen.body.sections.name).toBe('Match young people with local opportunities');
    expect(seen.body.authorId).toBe('anonymous');
    expect(seen.body.trace.source.kind).toBe('anonymised');
    expect(JSON.stringify(seen.body)).not.toMatch(/Jo Bloggs|jo\.bloggs/);
    // Publishing twice is refused.
    expect((await author.post(`/api/use-cases/${useCaseId}/anonymise/publish`).send({})).status).toBe(409);
    // The anonymised version can't be made private again (it would orphan the public record).
    expect((await author.post(`/api/use-cases/${publishedId}/visibility`).send({ visibility: 'private' })).status).toBe(409);
  });

  it('submits a private use case for triage when its author shares it', async () => {
    const author = await login('contributor', 'Sharer Sue');
    const { useCaseId } = await interview(author);
    const shared = await author.post(`/api/use-cases/${useCaseId}/visibility`).send({ visibility: 'group' });
    expect(shared.status).toBe(200);
    expect(shared.body.visibility).toBe('group');
    expect(shared.body.status).toBe('triage');
    expect(shared.body.anonymisation).toBeDefined(); // still the author's
    const member = await login('member', 'Member Max');
    const seen = await member.get(`/api/use-cases/${useCaseId}`);
    expect(seen.status).toBe(200);
    expect(seen.body.anonymisation).toBeUndefined();
    expect(seen.body.transcriptUrl).toBeUndefined();
  });

  it('declines the anonymised version and keeps everything private', async () => {
    const author = await login('contributor', 'Private Pat');
    const { useCaseId } = await interview(author);
    const d = await author.post(`/api/use-cases/${useCaseId}/anonymise/decline`);
    expect(d.body.anonymisation.status).toBe('declined');
    expect(d.body.visibility).toBe('private');
    const again = await author.post(`/api/use-cases/${useCaseId}/anonymise`);
    expect(again.body.anonymisation.status).toBe('proposed');
  });
});

describe('links', () => {
  it('links a call and its use case both ways, with the transcript lines', async () => {
    const member = await login('member', 'Member Lin');
    const meetings = await member.get(`/api/ontologies/${demoId}/meetings`);
    const call = meetings.body.find((m: { title: string }) => m.title === 'Working group call: recurring shifts');
    expect(call.useCases).toHaveLength(1);
    const ref = call.useCases[0];
    expect(ref.title).toBe('Publish recurring shifts once');
    expect(ref.sourceLines.length).toBeGreaterThan(0);

    const uc = await member.get(`/api/use-cases/${ref.id}`);
    expect(uc.body.trace.source.kind).toBe('meeting');
    expect(uc.body.trace.source.id).toBe(call.id);
    expect(uc.body.trace.source.href).toBe(`/o/${demoId}/meetings/${call.id}`);
    expect(uc.body.trace.source.lines.some((l: { text: string }) => /recurrence/.test(l.text))).toBe(true);
    // Related use case, linked by hand.
    expect(uc.body.trace.related[0].title).toBe('Find weekly shifts that need volunteers');
    expect(uc.body.trace.related[0].direction).toBe('out');

    // ...and seen from the other side.
    const other = await member.get(`/api/use-cases/${uc.body.trace.related[0].id}`);
    expect(other.body.trace.related.some((r: { id: string; direction: string }) => r.id === ref.id && r.direction === 'in')).toBe(true);
    // A signed-out visitor sees the public use case but not the working group link.
    const anon = await request(app).get(`/api/use-cases/${uc.body.trace.related[0].id}`);
    expect(anon.body.trace.related).toHaveLength(0);
    const anonCall = await request(app).get(`/api/meetings/${call.id}`);
    expect(anonCall.body.useCases).toHaveLength(0);
  });

  it('turns a call into use cases once, linked back to the call', async () => {
    const steward = await login('steward', 'Steward Uma');
    const transcript = `Priya Shah: What do you need from the standard?\nAisha Rahman: A "rota" is a weekly pattern of shifts. Which weekly shifts still need volunteers this Saturday?\nMei Chen: How many hours were given per cause last quarter?\n`;
    const m = await steward.post(`/api/ontologies/${demoId}/meetings/upload`).send({ title: 'Link test call', transcript });
    const p1 = await steward.post(`/api/meetings/${m.body.id}/propose`);
    expect(p1.status).toBe(200);
    const n = p1.body.useCases.length;
    expect(n).toBeGreaterThan(0);
    expect(p1.body.useCases.every((u: UC) => u.visibility === 'group' && u.source === 'meeting')).toBe(true);
    const p2 = await steward.post(`/api/meetings/${m.body.id}/propose`);
    expect(p2.body.useCases.map((u: UC) => u.id).sort()).toEqual(p1.body.useCases.map((u: UC) => u.id).sort());
    const got = await steward.get(`/api/meetings/${m.body.id}`);
    expect(got.body.useCases).toHaveLength(n);
    if (p1.body.changeRequest) {
      const cr = await steward.get(`/api/change-requests/${p1.body.changeRequest.id}`);
      expect(cr.body.useCases.length).toBe(n);
    }
  });

  it('adds and removes related links, and rejects bad ones', async () => {
    const member = await login('member', 'Member Rel');
    const list = (await member.get(`/api/ontologies/${demoId}/use-cases`)).body as UC[];
    const a = byName(list, 'Aggregate volunteering opportunities across platforms')!;
    const b = byName(list, 'Find weekly shifts that need volunteers')!;
    const linked = await member.post(`/api/use-cases/${a.id}/links`).send({ type: 'use-case', id: b.id, relation: 'depends-on' });
    expect(linked.status).toBe(200);
    expect(linked.body.trace.related.find((r: { id: string }) => r.id === b.id).relation).toBe('depends-on');
    expect((await member.post(`/api/use-cases/${a.id}/links`).send({ type: 'use-case', id: a.id })).status).toBe(400);
    expect((await member.post(`/api/use-cases/${a.id}/links`).send({ type: 'url', url: 'javascript:alert(1)' })).status).toBe(400);
    const url = await member.post(`/api/use-cases/${a.id}/links`).send({ type: 'url', url: 'https://www.w3.org/TR/vc-use-cases/', label: 'VC use cases' });
    expect(url.body.trace.other[0].url).toBe('https://www.w3.org/TR/vc-use-cases/');
    const removed = await member.delete(`/api/use-cases/${a.id}/links/${b.id}`);
    expect(removed.body.trace.related.some((r: { id: string }) => r.id === b.id)).toBe(false);
  });
});

describe('lifecycle and the requirements document', () => {
  it('has a published 1.0.0 document that tells a story with links to its use cases', async () => {
    const doc = await request(app).get(`/api/ontologies/${demoId}/requirements/1.0.0`);
    expect(doc.status).toBe(200);
    expect(doc.body.status).toBe('published');
    const tom = doc.body.useCases.find((u: { title: string }) => u.title === 'Aggregate volunteering opportunities across platforms');
    expect(tom.status).toBe('closed');
    expect(tom.coveredIn).toBe('1.0.0');
    const allText = [doc.body.intro, ...doc.body.sections.map((s: { markdown: string }) => s.markdown)].join('\n');
    expect(allText).toContain(`](#uc-${tom.id})`);
    expect(doc.body.requirements.length).toBeGreaterThan(0);
    expect(doc.body.requirements[0].id).toBe('R1');
    expect(doc.body.requirements.every((r: { useCaseIds: string[] }) => r.useCaseIds.length > 0)).toBe(true);
    // Only public use cases.
    expect(doc.body.useCases.every((u: { anonymised: boolean; sourceKind: string }) => u.sourceKind !== undefined)).toBe(true);
    const md = await request(app).get(`/api/ontologies/${demoId}/requirements/1.0.0/markdown`);
    expect(md.text).toMatch(/^# /);
    expect(md.text).toContain(`<a id="uc-${tom.id}"></a>`);
  });

  it('moves a use case from triage to closed as its change is merged and released', async () => {
    const steward = await login('steward', 'Steward Sam');
    const editor = await login('editor', 'Editor Eve');
    const reviewer = await login('reviewer', 'Reviewer Rae');
    const author = await login('contributor', 'Author Al');

    // A public use case, triaged and accepted.
    const { useCaseId } = await interview(author);
    await author.post(`/api/use-cases/${useCaseId}/visibility`).send({ visibility: 'public' });
    expect((await author.post(`/api/use-cases/${useCaseId}/triage`).send({ status: 'accepted' })).status).toBe(403);
    const accepted = await editor.post(`/api/use-cases/${useCaseId}/triage`).send({ status: 'accepted', note: 'In scope for 1.1' });
    expect(accepted.body.status).toBe('accepted');
    expect(accepted.body.resolution.note).toBe('In scope for 1.1');

    // A change request that addresses it.
    const created = await editor.post(`/api/ontologies/${demoId}/change-requests`).send({
      title: 'Say whether groups can take part',
      description: 'So young people can find opportunities they can join.',
      kind: 'feature',
      useCaseIds: [useCaseId],
      ops: [
        {
          op: 'addDatatypeProperty',
          localName: 'suitableForGroups',
          label: 'suitable for groups',
          definition: 'Whether a whole group, such as a school class, can take up a volunteering opportunity together.',
          domain: ['https://w3id.org/odi/volunteering#VolunteeringOpportunity'],
          range: ['http://www.w3.org/2001/XMLSchema#boolean'],
        },
      ],
    });
    expect(created.status).toBe(201);
    expect(created.body.useCases.map((u: { id: string }) => u.id)).toEqual([useCaseId]);
    const id = created.body.id;
    expect((await author.get(`/api/use-cases/${useCaseId}`)).body.status).toBe('in-progress');

    await editor.post(`/api/change-requests/${id}/submit`);
    await reviewer.post(`/api/change-requests/${id}/reviews`).send({ decision: 'approve' });
    await steward.post(`/api/change-requests/${id}/reviews`).send({ decision: 'approve' });
    await steward.post('/api/simulation/clock').send({ advanceDays: 8 });
    expect((await steward.get(`/api/change-requests/${id}`)).body.status).toBe('merged');
    const addressed = await author.get(`/api/use-cases/${useCaseId}`);
    expect(addressed.body.status).toBe('addressed');
    expect(addressed.body.trace.changeRequests[0].id).toBe(id);

    // Draft the release; the document is drafted with it.
    await steward.post(`/api/ontologies/${demoId}/releases`).send({});
    const draft = (await steward.get(`/api/ontologies/${demoId}/releases`)).body.find((r: { status: string }) => r.status === 'draft' || r.status === 'voting');
    const gen = await steward.post(`/api/releases/${draft.id}/requirements`);
    expect(gen.status).toBe(201);
    expect(gen.body.status).toBe('draft');
    const projected = gen.body.useCases.find((u: { id: string }) => u.id === useCaseId);
    expect(projected.status).toBe('closed');
    expect(projected.coveredIn).toBe(draft.version);
    // Drafts are for the working group; the public sees published documents only.
    expect((await request(app).get(`/api/ontologies/${demoId}/requirements/${draft.version}`)).status).toBe(404);
    expect((await steward.get(`/api/ontologies/${demoId}/requirements/${draft.version}`)).status).toBe(200);
    expect((await author.post(`/api/releases/${draft.id}/requirements`)).status).toBe(403);

    const rel = await steward.get(`/api/releases/${draft.id}`);
    expect(rel.body.useCases.map((u: { id: string }) => u.id)).toContain(useCaseId);
    expect(rel.body.requirements.status).toBe('draft');

    const published = await steward.post(`/api/releases/${draft.id}/publish`);
    expect(published.status).toBe(200);
    expect(published.body.requirements.status).toBe('published');
    const closed = await author.get(`/api/use-cases/${useCaseId}`);
    expect(closed.body.status).toBe('closed');
    expect(closed.body.resolution.version).toBe(draft.version);
    expect(closed.body.trace.releases[0].version).toBe(draft.version);
    expect(closed.body.trace.documents.map((d: { version: string }) => d.version)).toContain(draft.version);

    const pub = await request(app).get(`/api/ontologies/${demoId}/requirements/${draft.version}`);
    expect(pub.status).toBe(200);
    expect(pub.body.coverage.closed).toBeGreaterThanOrEqual(1);
    expect((await steward.post(`/api/releases/${draft.id}/requirements`)).status).toBe(409);
    // The released commit includes USE_CASES.md.
    const list = await request(app).get(`/api/ontologies/${demoId}/requirements`);
    expect(list.body.map((d: { version: string }) => d.version)).toContain(draft.version);
  });

  it('lets editors close a use case already covered, defer it, or rule it out of scope', async () => {
    const editor = await login('editor', 'Editor Tri');
    const list = (await editor.get(`/api/ontologies/${demoId}/use-cases`)).body as UC[];
    const call = byName(list, 'Publish recurring shifts once')!;
    const deferred = await editor.post(`/api/use-cases/${call.id}/triage`).send({ status: 'deferred', note: 'After 2.0' });
    expect(deferred.body.status).toBe('deferred');
    const closed = await editor.post(`/api/use-cases/${call.id}/triage`).send({ status: 'closed', note: 'vol:Session already covers it' });
    expect(closed.body.status).toBe('closed');
    expect(closed.body.resolution.version).toBeTruthy();
    expect((await editor.post(`/api/use-cases/${call.id}/triage`).send({ status: 'nonsense' })).status).toBe(400);
  });

  it('serves public use cases without sign-in and never includes private ones', async () => {
    const res = await request(app).get(`/api/ontologies/${demoId}/public-use-cases`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(1);
    expect(res.body[0].ref).toMatch(/^UC-\d+$/);
    // Not the working group use case, and not Mei's private original (only its anonymised version).
    expect(JSON.stringify(res.body)).not.toMatch(/Publish recurring shifts once|St Anne|Mei Chen|stannes/);
    const synthetic = res.body.find((u: { anonymised: boolean }) => u.anonymised);
    expect(synthetic.attribution).toBeUndefined();
    expect(synthetic.origin.kind).toBe('synthetic');
  });
});

describe('offline anonymiser', () => {
  it('removes contact details and the author, and swaps named places and organisations', () => {
    const out = heuristicAnonymise(
      {
        sections: { name: 'Fill shifts at the Northvale Food Bank', goal: 'Jo Bloggs at Riverside Youth Trust wants volunteers. Call 0161 496 0000 or see https://example.org.', notes: 'secret' },
        competencyQuestions: [{ id: 'q', question: 'Which shifts at Northvale Food Bank need people?', status: 'draft' }],
        terms: [{ label: 'shift', kind: 'class', evidence: ['Jo said shifts'] }],
      },
      'Jo Bloggs',
    );
    const text = JSON.stringify(out);
    expect(text).not.toMatch(/Bloggs|Riverside Youth Trust|0161|example\.org|Northvale|secret/);
    expect(out.terms[0].evidence).toBeUndefined();
    expect(out.changes.join(' ')).toMatch(/fictional/);
  });
});
