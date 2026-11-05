import request from 'supertest';
import { setTimeout as sleep } from 'node:timers/promises';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { seedDemo } from '../src/services/simulation.js';

const app = createApp();
type Agent = ReturnType<typeof request.agent>;

async function login(role: string, name = `Tester ${role}`): Promise<Agent> {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/demo').send({ name, role });
  expect(res.status).toBe(200);
  expect(res.body.user.webId).toMatch(/#me$/);
  return agent;
}

let demoId: string;

beforeAll(async () => {
  openDb();
  const demo = await seedDemo();
  demoId = demo!.id;
});

describe('demo seed', () => {
  it('has the volunteering ontology at 1.0.0 with members and open change requests', async () => {
    const agent = await login('member', 'Seed reader');
    const res = await agent.get(`/api/ontologies/volunteering`);
    expect(res.status).toBe(200);
    expect(res.body.currentVersion).toBe('1.0.0');
    expect(res.body.members.length).toBeGreaterThanOrEqual(6);
    const crs = await agent.get(`/api/ontologies/${demoId}/change-requests`);
    const byTitle = Object.fromEntries(crs.body.map((c: { title: string }) => [c.title, c]));
    expect(byTitle['Clarify the definition of cause'].status).toBe('merged');
    expect(byTitle['Clarify the definition of cause'].classification.level).toBe('patch');
    expect(byTitle['Say whether an opportunity reimburses expenses'].classification.level).toBe('minor');
    expect(byTitle['Allow only one location per session'].classification.level).toBe('major');
  });

  it('serves the ontology in every format, including LinkML', async () => {
    for (const format of ['turtle', 'linkml', 'jsonld', 'rdfxml', 'manchester', 'shacl', 'ntriples']) {
      const res = await request(app).get(`/api/ontologies/${demoId}/source?format=${format}`);
      expect(res.status, format).toBe(200);
      expect(res.text.length, format).toBeGreaterThan(200);
    }
    const linkml = await request(app).get(`/api/ontologies/${demoId}/source?format=linkml`);
    expect(linkml.text).toMatch(/classes:/);
    expect(linkml.text).toMatch(/VolunteeringOpportunity/);
  });

  it('validates the working draft as consistent and FAIR', async () => {
    const res = await (await login('contributor')).get(`/api/ontologies/${demoId}/validation`);
    expect(res.status).toBe(200);
    expect(res.body.reasoner.consistent).toBe(true);
    expect(res.body.fair.score).toBeGreaterThan(0.7);
  });
});

describe('change request lifecycle', () => {
  it('classifies, reviews, merges and releases a minor change', async () => {
    const steward = await login('steward', 'Steward Sam');
    const editor = await login('editor', 'Editor Eve');
    const reviewer = await login('reviewer', 'Reviewer Rae');

    const created = await editor.post(`/api/ontologies/${demoId}/change-requests`).send({
      title: 'Add a minimum commitment note',
      description: 'Lets organisations say what the minimum commitment is in words.',
      kind: 'feature',
      ops: [
        {
          op: 'addDatatypeProperty',
          localName: 'commitmentNote',
          label: 'commitment note',
          definition: 'A short free-text description of the minimum time commitment a volunteering opportunity asks of volunteers.',
          domain: ['https://w3id.org/odi/volunteering#VolunteeringOpportunity'],
          range: ['http://www.w3.org/2001/XMLSchema#string'],
        },
      ],
    });
    expect(created.status).toBe(201);
    expect(created.body.classification.level).toBe('minor');
    expect(created.body.validation.passed).toBe(true);
    const id = created.body.id;

    const submitted = await editor.post(`/api/change-requests/${id}/submit`);
    expect(submitted.body.status).toBe('review');

    // Working group: minor needs 2 approvals and a 7-day review period.
    await reviewer.post(`/api/change-requests/${id}/reviews`).send({ decision: 'approve', comment: 'Fine' });
    const approved2 = await steward.post(`/api/change-requests/${id}/reviews`).send({ decision: 'approve' });
    expect(approved2.body.governance.approvals).toBe(2);
    expect(approved2.body.status).toBe('review');
    expect(approved2.body.governance.reviewPeriodOver).toBe(false);

    await steward.post('/api/simulation/clock').send({ advanceDays: 8 });
    const after = await steward.get(`/api/change-requests/${id}`);
    expect(after.body.status).toBe('merged');

    const term = await steward.get(`/api/ontologies/${demoId}/terms/${encodeURIComponent('vol:commitmentNote')}`);
    expect(term.status).toBe(200);
    expect(term.body.label).toBe('commitment note');

    const rel = await steward.post(`/api/ontologies/${demoId}/releases`).send({});
    expect([200, 201, 409]).toContain(rel.status);
    const list = await steward.get(`/api/ontologies/${demoId}/releases`);
    const draft = list.body.find((r: { status: string }) => r.status === 'draft' || r.status === 'voting');
    expect(draft.version).toBe('1.1.0');
    const published = await steward.post(`/api/releases/${draft.id}/publish`);
    expect(published.status).toBe(200);
    expect(published.body.status).toBe('published');
    const v = await steward.get(`/api/ontologies/${demoId}/source?format=turtle&ref=1.1.0`);
    expect(v.text).toMatch(/owl:versionInfo "1\.1\.0"/);
    expect(v.text).toMatch(/owl:backwardCompatibleWith/);
  });

  it('rejects edits that make the ontology inconsistent from being approved', async () => {
    const editor = await login('editor', 'Editor Ed');
    const res = await editor.post(`/api/ontologies/${demoId}/change-requests`).send({
      title: 'Make skills a kind of cause',
      description: 'Contradicts the disjointness axiom.',
      kind: 'feature',
      ops: [{ op: 'setSuperClasses', iri: 'https://w3id.org/odi/volunteering#Skill', superClasses: ['https://w3id.org/odi/volunteering#Cause'] }],
      submit: true,
    });
    expect(res.status).toBe(201);
    expect(res.body.validation.passed).toBe(false);
    expect(['needs-work', 'review']).toContain(res.body.status);
    expect(res.body.governance.validationOk).toBe(false);
  });

  it('drafts edits from plain language offline', async () => {
    const editor = await login('editor', 'Editor Nat');
    const res = await editor.post(`/api/ontologies/${demoId}/change-requests`).send({ title: '', description: '', kind: 'feature', naturalLanguage: 'Add a class called Badge as a subclass of vol:Skill' });
    expect(res.status).toBe(201);
    expect(res.body.ops[0].op).toBe('addClass');
    expect(res.body.ops[0].localName).toBe('Badge');
  });
});

describe('requirements', () => {
  it('runs a scripted interview into a use case', async () => {
    const tester = await login('contributor', 'Contributor Cal');
    const s = await tester.post(`/api/ontologies/${demoId}/interviews`).send({});
    expect(s.status).toBe(201);
    let session = s.body;
    const answers = [
      'We want to match young people with short volunteering opportunities near their school.',
      'Students, teachers, the council youth service and local charities.',
      'A Year 10 student in Northvale wants a one-off Saturday activity for their Duke of Edinburgh award.',
      'A teacher wants to find group opportunities for a whole class.',
      '1. Charity posts an opportunity. 2. Platform checks the minimum age. 3. Student applies.',
      'Sometimes the opportunity is cancelled because of weather.',
      'Which opportunities near Northvale accept 15-year-olds? -> Park clean-up on Saturday\nWhich charities offer group volunteering? -> Northvale Food Bank',
    ];
    for (const a of answers) {
      const r = await tester.post(`/api/interviews/${session.id}/messages`).send({ content: a });
      expect(r.status).toBe(200);
      session = r.body.session;
      if (r.body.useCase.competencyQuestions.length) expect(r.body.useCase.competencyQuestions[0].question).toMatch(/\?$/);
    }
    const detail = await tester.get(`/api/interviews/${session.id}`);
    expect(detail.body.useCase.sections.goal).toMatch(/young people/);
    expect(detail.body.useCase.competencyQuestions.length).toBe(2);
    expect(detail.body.useCase.completeness).toBeGreaterThan(0.4);
  });

  it('parses a Meet transcript and proposes use cases', async () => {
    const tester = await login('steward', 'Steward Uma');
    const transcript = `Volunteering call - Transcript\n\nTranscript\n\n00:00:00\n\nPriya Shah: Welcome everyone. What do you need from the standard?\nAisha Rahman: A "rota" is a weekly pattern of shifts. Which weekly shifts still need volunteers this Saturday?\n00:01:10\nMei Chen: How many hours were given per cause last quarter? A volunteering record is basically a record of the hours one person gave to one opportunity.\n`;
    const m = await tester.post(`/api/ontologies/${demoId}/meetings/upload`).send({ title: 'Test call', transcript });
    expect(m.status).toBe(201);
    expect(m.body.transcript.length).toBe(3);
    expect(m.body.analysis.competencyQuestions.length).toBeGreaterThanOrEqual(2);
    const p = await tester.post(`/api/meetings/${m.body.id}/propose`);
    expect(p.status).toBe(200);
    expect(p.body.useCases.length).toBeGreaterThanOrEqual(1);
  });

  it('replays a simulated call with co-facilitator prompts', async () => {
    const tester = await login('steward', 'Steward Vic');
    const m = await tester.post(`/api/ontologies/${demoId}/meetings/simulate?delayMs=0`).send({ title: 'Sim' });
    expect(m.status).toBe(201);
    const got = await tester.get(`/api/meetings/${m.body.id}`);
    expect(got.body.transcript.length).toBeGreaterThan(10);
    expect(got.body.facilitatorPrompts.length).toBeGreaterThan(0);
    expect(got.body.status).toBe('analysed');
  });
});

describe('agents over MCP', () => {
  it('lists ontologies, searches terms and reports a gap', async () => {
    const tester = await login('contributor', 'Dev Dee');
    const tok = await tester.post('/api/agent-tokens').send({ name: 'Claude Code' });
    expect(tok.body.token).toMatch(/^cnc_/);
    const call = (id: number, method: string, params: unknown) =>
      request(app)
        .post('/mcp')
        .set('Authorization', `Bearer ${tok.body.token}`)
        .set('Accept', 'application/json, text/event-stream')
        .send({ jsonrpc: '2.0', id, method, params });
    const parse = (res: request.Response) => {
      const text = res.text.includes('data:') ? res.text.split('\n').find((l) => l.startsWith('data:'))!.slice(5) : res.text;
      return JSON.parse(text);
    };
    const init = await call(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-agent', version: '1' } });
    expect(init.status).toBe(200);
    const tools = parse(await call(2, 'tools/list', {}));
    expect(tools.result.tools.map((t: { name: string }) => t.name)).toEqual(expect.arrayContaining(['list_ontologies', 'get_ontology', 'search_terms', 'report_gap', 'validate_data']));
    const search = parse(await call(3, 'tools/call', { name: 'search_terms', arguments: { ontology: 'volunteering', query: 'skill' } }));
    expect(search.result.content[0].text).toMatch(/vol:Skill/);
    const linkml = parse(await call(4, 'tools/call', { name: 'get_ontology', arguments: { ontology: 'vol', format: 'linkml' } }));
    expect(linkml.result.content[0].text).toMatch(/classes:/);
    const data = parse(
      await call(5, 'tools/call', {
        name: 'validate_data',
        arguments: { ontology: 'volunteering', turtle: '@prefix vol: <https://w3id.org/odi/volunteering#> . <#x> a vol:VolunteeringOpportunity ; vol:notATerm "x" .' },
      }),
    );
    expect(JSON.parse(data.result.content[0].text).valid).toBe(false);
    const gap = parse(await call(6, 'tools/call', { name: 'report_gap', arguments: { ontology: 'volunteering', kind: 'missing-concept', summary: 'No badges for volunteers', details: 'We award digital badges to volunteers for completed hours.' } }));
    const out = JSON.parse(gap.result.content[0].text);
    expect(out.recommendation).toBeDefined();
  });

  it('refuses requests without a token', async () => {
    const res = await request(app).post('/mcp').send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(res.status).toBe(401);
  });
});

describe('feedback', () => {
  it('walks the structured questionnaire and records answers', async () => {
    const qs = await request(app).get('/api/feedback/questions');
    expect(qs.body.some((q: { section: string }) => q.section === 'Governance')).toBe(true);
    expect(qs.body.at(-1).id).toBe('comments');
    let answers = {};
    let messages: { role: string; content: string; id: string; at: string }[] = [];
    const first = await request(app).post('/api/feedback/chat').send({ pathway: 'structured', messages, answers });
    expect(first.body.nextQuestionId).toBe('role');
    messages = [{ id: '1', role: 'assistant', content: first.body.reply, at: '' }, { id: '2', role: 'user', content: "I'm a developer", at: '' }];
    const second = await request(app).post('/api/feedback/chat').send({ pathway: 'structured', messages, answers, currentQuestionId: 'role' });
    answers = second.body.answers;
    expect(second.body.answers.role).toBe('Developer or implementer');
    expect(second.body.nextQuestionId).toBe('familiarity');
    const sub = await request(app).post('/api/feedback').send({ pathway: 'structured', answers, transcript: messages, usedVoice: false });
    expect(sub.status).toBe(201);
  });
});

describe('anonymous access', () => {
  it('keeps use cases, interviews, meetings, change requests, releases and feedback behind sign-in', async () => {
    const agent = await login('contributor', 'Private author');
    const uc = await agent.post(`/api/ontologies/${demoId}/interviews`).send({});
    expect(uc.status).toBe(201);
    const useCaseId = uc.body.useCaseId ?? uc.body.session?.useCaseId;
    const ucs = (await agent.get(`/api/ontologies/${demoId}/use-cases`)).body as { id: string }[];
    const cr = (await agent.get(`/api/ontologies/${demoId}/change-requests`)).body[0] as { id: string };
    const rel = (await agent.get(`/api/ontologies/${demoId}/releases`)).body[0] as { id: string };
    const meetings = (await agent.get(`/api/ontologies/${demoId}/meetings`)).body as { id: string }[];
    const paths = [
      `/api/ontologies/${demoId}/use-cases`,
      `/api/use-cases/${useCaseId ?? ucs[0].id}`,
      `/api/interviews/${uc.body.id}`,
      `/api/ontologies/${demoId}/change-requests`,
      `/api/change-requests/${cr.id}`,
      `/api/ontologies/${demoId}/releases`,
      `/api/releases/${rel.id}`,
      `/api/ontologies/${demoId}/meetings`,
      ...(meetings[0] ? [`/api/meetings/${meetings[0].id}`] : []),
      `/api/ontologies/${demoId}/agent-reports`,
      '/api/activity',
      '/api/feedback',
      '/api/feedback/summary',
    ];
    for (const path of paths) {
      expect((await agent.get(path)).status, `signed in: ${path}`).not.toBe(401);
      const anon = await request(app).get(path);
      expect(anon.status, `anonymous: ${path}`).toBe(401);
      expect(JSON.stringify(anon.body)).not.toContain('Private author');
    }
  });

  it('still serves the ontologies themselves, without members or commit authors', async () => {
    for (const path of ['/api/ontologies', `/api/ontologies/${demoId}/view`, `/api/ontologies/${demoId}/source`, '/api/governance/templates', '/api/feedback/questions', '/api/session']) {
      expect((await request(app).get(path)).status, path).toBe(200);
    }
    // Paths that don't exist are still 404, not 401.
    expect((await request(app).get('/api/no-such-thing/pending')).status).toBe(404);
    const detail = await request(app).get('/api/ontologies/volunteering');
    expect(detail.status).toBe(200);
    expect(detail.body.members).toEqual([]);
    expect(detail.body.history).toEqual([]);
    // Owner ids lead to names via /people, and the counts reveal private work.
    for (const s of [detail.body, ...(await request(app).get('/api/ontologies')).body]) {
      expect(s.ownerIds).toEqual([]);
      expect(s.stats.useCases).toBeUndefined();
      expect(s.stats.openChangeRequests).toBeUndefined();
      expect(s.stats.members).toBeUndefined();
      expect(s.stats.classes).toBeGreaterThanOrEqual(0);
    }
    const owner = await login('contributor', 'Owner check');
    expect((await owner.get('/api/ontologies/volunteering')).body.ownerIds.length).toBeGreaterThan(0);
  });

  it('keeps validation (private competency questions) and the simulation behind sign-in', async () => {
    expect((await request(app).get(`/api/ontologies/${demoId}/validation`)).status).toBe(401);
    expect((await request(app).get(`/api/ontologies/${demoId}/validation?ref=1.0.0`)).status).toBe(401);
    const step = await request(app).post('/api/simulation/step').send({ ontologyId: demoId });
    expect(step.status).toBe(401);
    expect(JSON.stringify(step.body)).not.toContain('events');
    expect((await request(app).post('/api/simulation/clock').send({ advanceDays: 1 })).status).toBe(401);
    const agent = await login('contributor', 'Validator');
    expect((await agent.get(`/api/ontologies/${demoId}/validation`)).status).toBe(200);
    expect((await agent.post('/api/simulation/step').send({ ontologyId: demoId })).status).toBe(200);
  });
});

describe('inline term edits', () => {
  const VOL = 'https://w3id.org/odi/volunteering#';
  const SKILL = `${VOL}Skill`;
  const termPath = (iri = SKILL) => `/api/ontologies/${demoId}/terms/${encodeURIComponent(iri)}`;
  const edit = (agent: Agent, body: object) => agent.post(`/api/ontologies/${demoId}/term-edits`).send(body);

  it('opens an editorial change request with only the changed fields, leaving the working draft alone', async () => {
    const contributor = await login('contributor', 'Contributor Kit');
    const before = (await contributor.get(termPath())).body;
    const definition = `${before.definition} It is something a volunteer can offer or develop.`;
    const body = {
      termIri: SKILL,
      set: { definition, label: before.label, altLabels: [' competence ', 'competence', ''] },
      previous: { definition: before.definition, label: before.label, altLabels: before.altLabels ?? [] },
      reason: 'Say who has skills.',
      submit: true,
    };
    // Rewording a definition needs the author to say whether the meaning is kept.
    const noIntent = await edit(contributor, body);
    expect(noIntent.status).toBe(400);
    expect(noIntent.body.error).toMatch(/keeps the term’s meaning/);

    const res = await edit(contributor, { ...body, definitionIntent: 'same-meaning' });
    expect(res.status).toBe(201);
    expect(res.body.kind).toBe('editorial');
    expect(res.body.origin).toEqual({ type: 'term-edit', termIri: SKILL });
    expect(res.body.status).toBe('review');
    expect(res.body.title).toMatch(/definition and alternative labels of “/);
    expect(res.body.description).toMatch(/Say who has skills\./);
    expect(res.body.description).toMatch(/confirms the new definition keeps the term’s meaning/);
    expect(res.body.ops).toEqual([
      { op: 'updateAnnotations', iri: SKILL, set: { definition, altLabels: ['competence'] }, expect: { definition: before.definition, altLabels: before.altLabels ?? [] } },
    ]);
    expect(res.body.classification.level).toBe('patch');
    expect(res.body.validation.passed).toBe(true);
    // Nothing changes until the change request is approved and merged.
    expect((await contributor.get(termPath())).body.definition).toBe(before.definition);

    // Working group: a patch needs one editor or steward sign-off and a day open for comment.
    const editor = await login('editor', 'Editor Ines');
    const approved = await editor.post(`/api/change-requests/${res.body.id}/reviews`).send({ decision: 'approve' });
    expect(approved.body.governance.approvals).toBe(1);
    await editor.post('/api/simulation/clock').send({ advanceDays: 2 });
    expect((await editor.get(`/api/change-requests/${res.body.id}`)).body.status).toBe('merged');
    const after = (await contributor.get(termPath())).body;
    expect(after.definition).toBe(definition);
    expect(after.altLabels).toEqual(['competence']);
  });

  it('never lets a later merge silently overwrite an earlier edit to the same field', async () => {
    const TC = `${VOL}TimeCommitment`;
    const a = await login('contributor', 'Contributor Ana');
    const b = await login('contributor', 'Contributor Ben');
    const editor = await login('editor', 'Editor Oz');
    const original = (await a.get(termPath(TC))).body.comment ?? '';
    // Both start from the same original comment.
    const first = await edit(a, { termIri: TC, set: { comment: 'Usually agreed with the organisation.' }, previous: { comment: original }, submit: true });
    const second = await edit(b, { termIri: TC, set: { comment: 'Measured in hours per week.' }, previous: { comment: original }, submit: true });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    await editor.post(`/api/change-requests/${first.body.id}/reviews`).send({ decision: 'approve' });
    await editor.post(`/api/change-requests/${second.body.id}/reviews`).send({ decision: 'approve' });
    await editor.post('/api/simulation/clock').send({ advanceDays: 2 });

    const states = await Promise.all([first, second].map(async (r) => (await editor.get(`/api/change-requests/${r.body.id}`)).body));
    const merged = states.filter((c) => c.status === 'merged');
    const blocked = states.filter((c) => c.status !== 'merged');
    expect(merged).toHaveLength(1);
    expect(blocked).toHaveLength(1);
    expect(blocked[0].status).toBe('needs-work');
    expect(JSON.stringify(blocked[0])).toMatch(/comment of <.*TimeCommitment> has changed since this edit was proposed/);
    // The term keeps the merged edit, not a silent overwrite by the other.
    expect((await a.get(termPath(TC))).body.comment).toBe(merged[0].ops[0].set.comment);
  });

  it('merges into one ontology one at a time, so concurrent merges cannot both overwrite the same field', async () => {
    const crsMod = await import('../src/services/changeRequests.js');
    const { put } = await import('../src/db.js');
    const SESSION = `${VOL}Session`;
    const a = await login('contributor', 'Contributor Race A');
    const b = await login('contributor', 'Contributor Race B');
    const original = (await a.get(termPath(SESSION))).body.editorialNote ?? '';
    const one = await edit(a, { termIri: SESSION, set: { editorialNote: 'Race note A' }, previous: { editorialNote: original } });
    const two = await edit(b, { termIri: SESSION, set: { editorialNote: 'Race note B' }, previous: { editorialNote: original } });
    // Both approved (one sign-off each, review period treated as over), then merged at the same time.
    const editor = await login('editor', 'Editor Race');
    for (const id of [one.body.id, two.body.id]) {
      await (id === one.body.id ? a : b).post(`/api/change-requests/${id}/submit`);
      await editor.post(`/api/change-requests/${id}/reviews`).send({ decision: 'approve' });
      put('changeRequests', { ...crsMod.getCR(id), status: 'approved', reviewStartedAt: '2000-01-01T00:00:00Z' }, demoId);
    }
    const results = await Promise.all([crsMod.merge(crsMod.getCR(one.body.id), undefined), crsMod.merge(crsMod.getCR(two.body.id), undefined)]);
    expect(results.map((r) => r.status).sort()).toEqual(['merged', 'needs-work']);
    const loser = results.find((r) => r.status === 'needs-work')!;
    expect(JSON.stringify(loser.timeline)).toMatch(/Earlier approvals no longer count/);
    const winner = results.find((r) => r.status === 'merged')!;
    expect((await a.get(termPath(SESSION))).body.editorialNote).toBe((winner.ops[0] as { set: { editorialNote?: string } }).set.editorialNote);
  });

  it('asks someone other than the author to confirm a reworded definition, even where patches need no approval', async () => {
    const { evaluate, GOVERNANCE_TEMPLATES } = await import('../src/services/governance.js');
    const base = {
      policy: GOVERNANCE_TEMPLATES['lazy-consensus'],
      level: 'patch' as const,
      kind: 'change' as const,
      status: 'review' as const,
      statusSince: '2026-01-01T00:00:00Z',
      reviewStartedAt: '2026-01-01T00:00:00Z',
      authorId: 'author',
      reviews: [],
      votes: [],
      members: [{ ontologyId: 'o', userId: 'steward', roles: ['steward' as const], addedAt: '2026-01-01T00:00:00Z' }],
      validationOk: true,
      now: new Date('2026-02-01T00:00:00Z'),
    };
    expect(evaluate(base).outcome).toBe('approved');
    const confirm = evaluate({ ...base, independentConfirmation: 'A definition was reworded.' });
    expect(confirm.requiredApprovals).toBe(1);
    expect(confirm.outcome).toBe('review');
    expect(confirm.unmet.join(' ')).toMatch(/A definition was reworded/);
    const confirmed = evaluate({ ...base, independentConfirmation: 'x', reviews: [{ id: 'r', changeRequestId: 'c', userId: 'steward', roles: ['steward'], decision: 'approve', at: '2026-01-02T00:00:00Z' }] });
    expect(confirmed.outcome).toBe('approved');

    // Every entry point is classified the same way: here a plain change request with no intent answer.
    const editor = await login('editor', 'Editor Reword');
    const current = (await editor.get(termPath())).body.definition;
    const res = await editor.post(`/api/ontologies/${demoId}/change-requests`).send({ title: 'Reword skill', description: '', kind: 'editorial', ops: [{ op: 'updateAnnotations', iri: SKILL, set: { definition: `${current} Reworded.` } }], submit: true });
    expect(res.body.classification.reasons.map((r: { rule: string }) => r.rule)).toContain('definition-reworded');
  });

  it('keeps a withdrawal made while a re-triage was running', async () => {
    const crsMod = await import('../src/services/changeRequests.js');
    const contributor = await login('contributor', 'Contributor Withdraw');
    const created = await edit(contributor, { termIri: SKILL, set: { examples: ['withdraw me'] }, submit: true });
    const snapshot = crsMod.getCR(created.body.id); // what a slow re-triage started from
    expect((await contributor.post(`/api/change-requests/${created.body.id}/withdraw`)).status).toBe(200);
    const after = await crsMod.triage(snapshot);
    expect(after.status).toBe('withdrawn');
    expect(crsMod.getCR(created.body.id).status).toBe('withdrawn');
  });

  it('does not count an approval from someone who rewrote the edits', async () => {
    const contributor = await login('contributor', 'Contributor Orig');
    const rewriter = await login('editor', 'Editor Rewriter');
    const other = await login('editor', 'Editor Other');
    const created = await edit(contributor, { termIri: SKILL, set: { comment: 'Original wording.' }, submit: true });
    const id = created.body.id;
    const patched = await rewriter.patch(`/api/change-requests/${id}`).send({ ops: [{ op: 'updateAnnotations', iri: SKILL, set: { comment: 'Rewritten wording.' } }] });
    expect(patched.status).toBe(200);
    expect(patched.body.revisedBy).toContain((await rewriter.get('/api/session')).body.user.id);
    const own = await rewriter.post(`/api/change-requests/${id}/reviews`).send({ decision: 'approve' });
    expect(own.body.governance.approvals).toBe(0);
    const independent = await other.post(`/api/change-requests/${id}/reviews`).send({ decision: 'approve' });
    expect(independent.body.governance.approvals).toBe(1);
  });

  it('classifies a stale draft against the current draft when it is submitted', async () => {
    const contributor = await login('contributor', 'Contributor Stale');
    const editor = await login('editor', 'Editor Stale');
    const TC = `${VOL}TimeCommitment`;
    const original = (await contributor.get(termPath(TC))).body.definition;
    // A draft that "sets" the definition to what it already is: no change, so nothing to confirm.
    const stale = await contributor.post(`/api/ontologies/${demoId}/change-requests`).send({ title: 'Keep definition', description: '', kind: 'editorial', ops: [{ op: 'updateAnnotations', iri: TC, set: { definition: original } }] });
    expect(stale.body.classification.reasons.map((r: { rule: string }) => r.rule)).not.toContain('definition-reworded');
    // Someone else's reworded definition is approved and merged meanwhile.
    const reworded = await edit(editor, { termIri: TC, set: { definition: `${original} It can be regular or one-off.` }, previous: { definition: original }, definitionIntent: 'same-meaning', submit: true });
    await (await login('steward', 'Steward Stale')).post(`/api/change-requests/${reworded.body.id}/reviews`).send({ decision: 'approve' });
    await editor.post('/api/simulation/clock').send({ advanceDays: 2 });
    expect((await editor.get(`/api/change-requests/${reworded.body.id}`)).body.status).toBe('merged');
    // Submitting the stale draft now would put the old definition back: that is a rewording that needs confirming.
    const submitted = await contributor.post(`/api/change-requests/${stale.body.id}/submit`);
    expect(submitted.body.classification.reasons.map((r: { rule: string }) => r.rule)).toContain('definition-reworded');
    expect(submitted.body.status).not.toBe('approved');
    expect(submitted.body.governance.requiredApprovals).toBeGreaterThanOrEqual(1);
  });

  it('keeps a draft when not submitted, and classifies removing a definition or changing its meaning as major', async () => {
    const contributor = await login('contributor', 'Contributor Lou');
    const res = await edit(contributor, { termIri: SKILL, set: { definition: '' } });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('draft');
    expect(res.body.ops[0].set).toEqual({ definition: '' });
    expect(res.body.classification.level).toBe('major');

    const current = (await contributor.get(termPath())).body.definition;
    const meaning = await edit(contributor, { termIri: SKILL, set: { definition: 'A paid employment contract held by a volunteer.' }, previous: { definition: current }, definitionIntent: 'new-meaning' });
    expect(meaning.status).toBe(201);
    expect(meaning.body.classification.level).toBe('major');
    expect(meaning.body.classification.reasons.map((r: { rule: string }) => r.rule)).toContain('meaning-changed');
    expect(meaning.body.description).toMatch(/changes what the term means/);
  });

  it('lets oversized existing text be shortened', async () => {
    const editor = await login('editor', 'Editor Long');
    const steward = await login('steward', 'Steward Long');
    const LOC = `${VOL}Location`;
    const long = 'x'.repeat(4100);
    const created = await editor.post(`/api/ontologies/${demoId}/change-requests`).send({ title: 'Long note', description: '', kind: 'editorial', ops: [{ op: 'updateAnnotations', iri: LOC, set: { editorialNote: long } }], submit: true });
    await steward.post(`/api/change-requests/${created.body.id}/reviews`).send({ decision: 'approve' });
    await steward.post('/api/simulation/clock').send({ advanceDays: 2 });
    expect((await editor.get(termPath(LOC))).body.editorialNote).toBe(long);

    const contributor = await login('contributor', 'Contributor Short');
    const res = await edit(contributor, { termIri: LOC, set: { editorialNote: 'Short note.' }, previous: { editorialNote: long } });
    expect(res.status).toBe(201);
    expect((await edit(contributor, { termIri: LOC, set: { comment: 'y'.repeat(4001) } })).status).toBe(400);
  });

  it('limits how much validation and triage one person can trigger, across term edits and re-triage', async () => {
    const { triageBudget } = await import('../src/services/budget.js');
    const saved = { ...triageBudget };
    triageBudget.max = 2;
    try {
      const contributor = await login('contributor', 'Contributor Busy');
      const first = await edit(contributor, { termIri: SKILL, set: { examples: ['example 1'] } });
      expect(first.status).toBe(201);
      expect((await contributor.post(`/api/change-requests/${first.body.id}/retriage`)).status).toBe(200);
      const third = await edit(contributor, { termIri: SKILL, set: { examples: ['example 3'] } });
      expect(third.status).toBe(429);
      expect((await contributor.post(`/api/change-requests/${first.body.id}/retriage`)).status).toBe(429);
      // Every other path that validates and triages shares the same budget.
      expect((await contributor.post(`/api/ontologies/${demoId}/change-requests`).send({ title: 'More', description: '', kind: 'editorial', ops: [{ op: 'updateAnnotations', iri: SKILL, set: { examples: ['x'] } }] })).status).toBe(429);
      expect((await contributor.patch(`/api/change-requests/${first.body.id}`).send({ ops: [{ op: 'updateAnnotations', iri: SKILL, set: { examples: ['y'] } }] })).status).toBe(429);
      expect((await contributor.post(`/api/ontologies/${demoId}/bug-reports`).send({ title: 'Bug', description: 'Broken' })).status).toBe(429);
      // Someone else is unaffected.
      expect((await edit(await login('contributor', 'Contributor Calm'), { termIri: SKILL, set: { examples: ['calm'] } })).status).toBe(201);
    } finally {
      Object.assign(triageBudget, saved);
    }
  });

  it('refuses no-op, empty-label, unknown-term, stale and anonymous edits', async () => {
    const contributor = await login('contributor', 'Contributor Mo');
    const current = (await contributor.get(termPath())).body;
    expect((await edit(contributor, { termIri: SKILL, set: { label: current.label } })).status).toBe(400);
    expect((await edit(contributor, { termIri: SKILL, set: { label: '   ' } })).status).toBe(400);
    expect((await edit(contributor, { termIri: SKILL, set: { altLabels: 'not a list' } })).status).toBe(400);
    expect((await edit(contributor, { termIri: SKILL, set: { comment: 'x' }, definitionIntent: 'maybe' })).status).toBe(400);
    expect((await edit(contributor, { termIri: `${VOL}NoSuchTerm`, set: { label: 'x' } })).status).toBe(404);
    const stale = await edit(contributor, { termIri: SKILL, set: { comment: 'New comment' }, previous: { comment: 'Something someone else replaced' } });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatch(/changed since you opened the editor/);
    const anon = await request(app).post(`/api/ontologies/${demoId}/term-edits`).send({ termIri: SKILL, set: { comment: 'x' } });
    expect(anon.status).toBe(401);
  });

  it('keeps multi-line examples intact', async () => {
    const contributor = await login('contributor', 'Contributor Lines');
    const editor = await login('editor', 'Editor Lines');
    const SESSION = `${VOL}Session`;
    const multi = 'Saturday 10:00 to 12:00\nat the community garden';
    const created = await edit(contributor, { termIri: SESSION, set: { examples: [multi, 'A one-off beach clean'] }, submit: true });
    expect(created.status).toBe(201);
    await editor.post(`/api/change-requests/${created.body.id}/reviews`).send({ decision: 'approve' });
    await editor.post('/api/simulation/clock').send({ advanceDays: 2 });
    const examples = (await contributor.get(termPath(SESSION))).body.examples;
    expect(examples).toHaveLength(2);
    expect(examples).toContain(multi);
    // Editing another field with the multi-line examples as the starting point is not a conflict.
    const next = await edit(contributor, { termIri: SESSION, set: { comment: 'Sessions can repeat.', examples }, previous: { examples, comment: '' } });
    expect(next.status).toBe(201);
    expect(Object.keys(next.body.ops[0].set)).toEqual(['comment']);
  });

  /* Concurrency and budget: every change to a request is made under the ontology's lock, from its latest stored copy. */
  const gate = () => {
    let open!: () => void;
    const p = new Promise<void>((resolve) => (open = resolve));
    return { p, open };
  };
  const userOf = async (agent: Agent) => {
    const { getUser } = await import('../src/services/users.js');
    return getUser((await agent.get('/api/session')).body.user.id)!;
  };

  it('keeps the working-draft lock while a slow holder is alive, and stops a holder that lost it from writing', async () => {
    const { withWorkingDraftLock, assertStillHeld, lockTiming } = await import('../src/services/repoLock.js');
    const { get, put, remove } = await import('../src/db.js');
    const crsMod = await import('../src/services/changeRequests.js');
    const saved = { ...lockTiming };
    Object.assign(lockTiming, { heartbeatMs: 10, leaseMs: 80, waitMs: 150 });
    const key = `working-draft-lock:${demoId}`;
    try {
      // A slow but live holder keeps renewing its lease, so it never looks abandoned to another process.
      await withWorkingDraftLock({ id: demoId }, async () => {
        await sleep(300);
        expect(get<{ expiresAt: number }>('kv', key)!.expiresAt).toBeGreaterThan(Date.now());
        assertStillHeld({ id: demoId });
      });
      expect(get('kv', key)).toBeUndefined();

      // Another process's live lease: we wait, then give up, without touching it.
      put('kv', { id: key, token: 'another-process', pid: 0, expiresAt: Date.now() + 60_000 });
      await expect(withWorkingDraftLock({ id: demoId }, async () => 'got it')).rejects.toMatchObject({ status: 503 });
      expect(get('kv', key)).toMatchObject({ token: 'another-process' });
      remove('kv', key);

      // A holder that stalled past its lease and was taken over can no longer write, and leaves its successor's lease alone.
      const contributor = await login('contributor', 'Contributor Stalled');
      const created = await edit(contributor, { termIri: SKILL, set: { examples: ['stalled'] }, submit: true });
      const user = await userOf(contributor);
      await expect(
        withWorkingDraftLock({ id: demoId }, async () => {
          put('kv', { id: key, token: 'successor', pid: 0, expiresAt: Date.now() + 60_000 });
          return crsMod.withdraw(crsMod.getCR(created.body.id), user);
        }),
      ).rejects.toMatchObject({ status: 503 });
      expect(crsMod.getCR(created.body.id).status).toBe('review');
      expect(get('kv', key)).toMatchObject({ token: 'successor' });
      remove('kv', key);
    } finally {
      Object.assign(lockTiming, saved);
    }
  });

  it('never lets a slow AI revision undo a withdrawal or someone else’s edits', async () => {
    const { llm } = await import('../src/llm/provider.js');
    const crsMod = await import('../src/services/changeRequests.js');
    const original = llm.json;
    let held = gate();
    const spy = vi.spyOn(llm, 'json').mockImplementation(async function (this: typeof llm, call) {
      if (call.task === 'revise') await held.p;
      return original.call(llm, call as never) as never;
    });
    const revises = () => spy.mock.calls.filter(([c]) => c.task === 'revise').length;
    try {
      const contributor = await login('contributor', 'Contributor Slow AI');
      const editorA = await login('editor', 'Editor Slow AI');
      const editorB = await login('editor', 'Editor Quick');

      // Withdrawn while the AI was revising: it stays withdrawn.
      const first = await edit(contributor, { termIri: SKILL, set: { comment: 'Revise me.' }, submit: true });
      const revising = editorA.post(`/api/change-requests/${first.body.id}/revise`).send({ instruction: 'Add a class Gadget' }).then((r) => r);
      await vi.waitFor(() => expect(revises()).toBe(1));
      expect((await contributor.post(`/api/change-requests/${first.body.id}/withdraw`)).status).toBe(200);
      held.open();
      expect((await revising).status).toBe(409);
      expect(crsMod.getCR(first.body.id).status).toBe('withdrawn');

      // Someone else rewrote the edits while the AI was revising: theirs are kept, and they still can't approve their own rewrite.
      held = gate();
      const second = await edit(contributor, { termIri: SKILL, set: { comment: 'Revise me too.' }, submit: true });
      const revising2 = editorA.post(`/api/change-requests/${second.body.id}/revise`).send({ instruction: 'Add a class Gizmo' }).then((r) => r);
      await vi.waitFor(() => expect(revises()).toBe(2));
      const theirs = [{ op: 'updateAnnotations', iri: SKILL, set: { comment: 'Editor B’s wording.' } }];
      expect((await editorB.patch(`/api/change-requests/${second.body.id}`).send({ ops: theirs })).status).toBe(200);
      held.open();
      const late = await revising2;
      expect(late.status).toBe(409);
      expect(late.body.error).toMatch(/changed the edits while they were being revised/);
      const stored = crsMod.getCR(second.body.id);
      expect(stored.ops).toEqual(theirs);
      expect(stored.revisedBy).toContain((await userOf(editorB)).id);
      expect((await editorB.post(`/api/change-requests/${second.body.id}/reviews`).send({ decision: 'approve' })).body.governance.approvals).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('makes edits wait for a merge in progress, so a merge never commits edits nobody reviewed', async () => {
    const crsMod = await import('../src/services/changeRequests.js');
    const { ontologyStore } = await import('../src/services/ontologyStore.js');
    const { put } = await import('../src/db.js');
    const LOC = `${VOL}Location`;
    const author = await login('contributor', 'Contributor Mid-merge');
    const editor = await login('editor', 'Editor Mid-merge');
    const before = (await author.get(termPath(LOC))).body;
    const created = await edit(author, { termIri: LOC, set: { comment: 'Reviewed comment.' }, previous: { comment: before.comment ?? '' } });
    put('changeRequests', { ...crsMod.getCR(created.body.id), status: 'approved', approvedAs: { level: 'patch', confirmation: false } }, demoId);

    const held = gate();
    const original = ontologyStore.working;
    let calls = 0;
    const spy = vi.spyOn(ontologyStore, 'working').mockImplementation(async (p) => {
      if (calls++ === 0) await held.p; // the merge's own re-check is slow
      return original.call(ontologyStore, p);
    });
    try {
      const merging = crsMod.merge(crsMod.getCR(created.body.id), await userOf(editor));
      await vi.waitFor(() => expect(calls).toBeGreaterThan(0));
      const patching = crsMod
        .updateOps(crsMod.getCR(created.body.id), await userOf(author), { ops: [{ op: 'updateAnnotations', iri: LOC, set: { definition: 'Unreviewed definition.' } }] })
        .then(() => 'saved', (err: { status?: number }) => err.status);
      await sleep(50);
      held.open();
      expect((await merging).status).toBe('merged');
      expect(await patching).toBe(409);
    } finally {
      spy.mockRestore();
    }
    const after = (await author.get(termPath(LOC))).body;
    expect(after.comment).toBe('Reviewed comment.');
    expect(after.definition).toBe(before.definition);
  });

  it('merges a request approved after its vote without reopening the vote, but sends one that grew back to review', async () => {
    const crsMod = await import('../src/services/changeRequests.js');
    const { put } = await import('../src/db.js');
    const ORG = `${VOL}Session`;
    const contributor = await login('contributor', 'Contributor Voted');
    const steward = await login('steward', 'Steward Voted');
    const stewardUser = await userOf(steward);
    const current = (await contributor.get(termPath(ORG))).body.definition;

    // Approved as major, after the vote passed: merging doesn't start another vote.
    const voted = await edit(contributor, { termIri: ORG, set: { definition: 'A scheduled period of volunteering, possibly repeating.' }, previous: { definition: current }, definitionIntent: 'new-meaning' });
    expect(voted.body.classification.level).toBe('major');
    put('changeRequests', { ...crsMod.getCR(voted.body.id), status: 'approved', approvedAs: { level: 'major', confirmation: true } }, demoId);
    const merged = await crsMod.merge(crsMod.getCR(voted.body.id), stewardUser);
    expect(merged.status).toBe('merged');
    expect((await contributor.get(termPath(ORG))).body.definition).toBe('A scheduled period of volunteering, possibly repeating.');

    // Approved as a patch, but a major change on today's draft: back to review, nothing merged.
    const now = (await contributor.get(termPath(ORG))).body.definition;
    const grew = await edit(contributor, { termIri: ORG, set: { definition: 'An employment shift.' }, previous: { definition: now }, definitionIntent: 'new-meaning' });
    put('changeRequests', { ...crsMod.getCR(grew.body.id), status: 'approved', approvedAs: { level: 'patch', confirmation: false } }, demoId);
    const back = await crsMod.merge(crsMod.getCR(grew.body.id), stewardUser);
    expect(back.status).not.toBe('merged');
    expect(back.status).not.toBe('approved');
    expect(JSON.stringify(back.timeline)).toMatch(/back in review: on the latest draft this is a major change/);
    expect((await contributor.get(termPath(ORG))).body.definition).toBe(now);
  });

  it('charges merges to the budget of whoever triggers them, and re-checks other requests without the LLM', async () => {
    const { triageBudget } = await import('../src/services/budget.js');
    const { llm } = await import('../src/llm/provider.js');
    const crsMod = await import('../src/services/changeRequests.js');
    const { put } = await import('../src/db.js');
    const saved = { ...triageBudget };
    triageBudget.max = 1;
    const spy = vi.spyOn(llm, 'json');
    try {
      const editor = await login('editor', 'Editor Spent');
      const a = await login('contributor', 'Contributor Budget A');
      const b = await login('contributor', 'Contributor Budget B');
      const TC = `${VOL}TimeCommitment`;
      const one = await edit(a, { termIri: TC, set: { examples: ['two hours a week'] }, submit: true });
      expect((await editor.post(`/api/change-requests/${one.body.id}/retriage`)).status).toBe(200); // the editor's one allowance
      put('changeRequests', { ...crsMod.getCR(one.body.id), status: 'approved', approvedAs: { level: 'patch', confirmation: false } }, demoId);
      // A manual merge re-validates the change, so it needs budget too.
      expect((await editor.post(`/api/change-requests/${one.body.id}/merge`)).status).toBe(429);
      expect(crsMod.getCR(one.body.id).status).toBe('approved');

      // An approval that would trigger an automatic merge: recorded, and the merge waits for the approver's budget.
      const LOC = `${VOL}Location`;
      const two = await edit(b, { termIri: LOC, set: { examples: ['a village hall'] }, submit: true });
      await editor.post('/api/simulation/clock').send({ advanceDays: 2 });
      expect(crsMod.getCR(one.body.id).status).toBe('merged');
      spy.mockClear();
      const approved = await editor.post(`/api/change-requests/${two.body.id}/reviews`).send({ decision: 'approve' });
      expect(approved.status).toBe(200);
      expect(approved.body.status).toBe('approved');
      expect(approved.body.autoMergeBy).toBe((await userOf(editor)).id);
      await editor.post('/api/simulation/clock').send({ advanceDays: 0.01 });
      expect(crsMod.getCR(two.body.id).status).toBe('approved');
      // Once they have budget again, the governance clock merges it, on their budget.
      triageBudget.max = 2;
      await editor.post('/api/simulation/clock').send({ advanceDays: 0.01 });
      expect(crsMod.getCR(two.body.id).status).toBe('merged');
      expect(crsMod.getCR(two.body.id).autoMergeBy).toBeUndefined();
      // That merge used the editor's second allowance (the first was the re-triage).
      expect((await editor.post(`/api/change-requests/${one.body.id}/retriage`)).status).toBe(429);
      // Re-checking the other open requests after each merge used no LLM triage.
      expect(spy.mock.calls.filter(([c]) => c.task === 'triage')).toHaveLength(0);
    } finally {
      spy.mockRestore();
      Object.assign(triageBudget, saved);
    }
  });

  it('re-validates the combined result at merge, and does not merge if it now fails', async () => {
    const crsMod = await import('../src/services/changeRequests.js');
    const { put } = await import('../src/db.js');
    const HELPER = `${VOL}Helper`;
    const PERSON = `${VOL}Person`;
    const editor = await login('editor', 'Editor Combined');
    const steward = await userOf(await login('steward', 'Steward Combined'));
    const create = (title: string, ops: object[]) => editor.post(`/api/ontologies/${demoId}/change-requests`).send({ title, description: '', kind: 'change', ops });
    const approve = (r: { body: { id: string; classification: { level: 'patch' | 'minor' | 'major' } } }) =>
      put('changeRequests', { ...crsMod.getCR(r.body.id), status: 'approved', approvedAs: { level: r.body.classification.level, confirmation: false } }, demoId);
    const helper = await create('Add helper', [{ op: 'addClass', localName: 'Helper', label: 'helper', definition: 'An agent that helps out with a volunteering opportunity.', subClassOf: [`${VOL}Agent`] }]);
    approve(helper);
    expect((await crsMod.merge(crsMod.getCR(helper.body.id), steward)).status).toBe('merged');
    // Each passes on its own; together Helper would be unsatisfiable.
    const sub = await create('Helpers are people', [{ op: 'setSuperClasses', iri: HELPER, superClasses: [PERSON] }]);
    const disjoint = await create('Helpers are not people', [{ op: 'addDisjointness', classes: [HELPER, PERSON] }]);
    expect(sub.body.validation.passed).toBe(true);
    expect(disjoint.body.validation.passed).toBe(true);
    approve(sub);
    approve(disjoint);
    const { ontologyStore } = await import('../src/services/ontologyStore.js');
    const { getProject } = await import('../src/services/ontologies.js');
    const head = async () => ontologyStore.head(getProject(demoId));
    expect((await crsMod.merge(crsMod.getCR(sub.body.id), steward)).status).toBe('merged');
    const before = await head();
    const second = await crsMod.merge(crsMod.getCR(disjoint.body.id), steward);
    expect(second.status).toBe('needs-work');
    expect(second.validation!.passed).toBe(false);
    expect(JSON.stringify(second.timeline)).toMatch(/fails validation/);
    expect(await head()).toEqual(before);
  });

  it('lets a blocking review added after approval stop the merge', async () => {
    const crsMod = await import('../src/services/changeRequests.js');
    const { put } = await import('../src/db.js');
    const contributor = await login('contributor', 'Contributor Blocked');
    const editor = await login('editor', 'Editor Blocker');
    const created = await edit(contributor, { termIri: `${VOL}Cause`, set: { comment: 'Blocked later.' }, submit: true });
    put('changeRequests', { ...crsMod.getCR(created.body.id), status: 'approved', approvedAs: { level: 'patch', confirmation: false } }, demoId);
    const blocked = await editor.post(`/api/change-requests/${created.body.id}/reviews`).send({ decision: 'request-changes', comment: 'Not yet.' });
    expect(blocked.body.status).toBe('needs-work');
    expect((await editor.post(`/api/change-requests/${created.body.id}/merge`)).status).toBe(409);
    expect((await contributor.get(termPath(`${VOL}Cause`))).body.comment).not.toBe('Blocked later.');
  });

  it('re-checks a request approved before approval details were recorded', async () => {
    const crsMod = await import('../src/services/changeRequests.js');
    const { put } = await import('../src/db.js');
    const contributor = await login('contributor', 'Contributor Legacy');
    const TC = `${VOL}TimeCommitment`;
    const current = (await contributor.get(termPath(TC))).body.definition;
    // A definition rewording with no reviews, stored as approved by an older version (no approvedAs).
    const created = await edit(contributor, { termIri: TC, set: { definition: `${current} Legacy.` }, previous: { definition: current }, definitionIntent: 'same-meaning' });
    const legacy = { ...crsMod.getCR(created.body.id), status: 'approved' as const };
    delete legacy.approvedAs;
    put('changeRequests', legacy, demoId);
    const result = await crsMod.merge(crsMod.getCR(created.body.id), await userOf(await login('steward', 'Steward Legacy')));
    expect(result.status).not.toBe('merged');
    expect((await contributor.get(termPath(TC))).body.definition).toBe(current);
  });

  it('never moves the working draft from a stale base', async () => {
    const { ontologyStore } = await import('../src/services/ontologyStore.js');
    const { getProject } = await import('../src/services/ontologies.js');
    const project = getProject(demoId);
    const { graph, head } = await ontologyStore.workingAt(project);
    const stale = ontologyStore.log(project, 2)[1].sha;
    await expect(ontologyStore.commitWorking(project, graph, 'stale writer', { name: 'Stale' }, stale)).rejects.toMatchObject({ status: 409 });
    // Even a no-op against the stale base is refused, rather than reported as committed.
    const staleGraph = await ontologyStore.at(project, 'working').then(() => import('@concord/core')).then(async ({ OntologyGraph }) => OntologyGraph.fromTurtle(ontologyStore.readWorkingText(project, stale)));
    await expect(ontologyStore.commitWorking(project, staleGraph, 'stale no-op', { name: 'Stale' }, stale)).rejects.toMatchObject({ status: 409 });
    await expect(ontologyStore.writeRelease(project, '9.9.9', graph, {}, 'stale release', { name: 'Stale' }, stale)).rejects.toMatchObject({ status: 409 });
    expect(ontologyStore.head(project)).toBe(head);
    expect(ontologyStore.versions(project)).not.toContain('9.9.9');
  });

  it('never lands a merge if the request changed after it was checked, even by a writer that ignored the lock', async () => {
    const crsMod = await import('../src/services/changeRequests.js');
    const { ontologyStore } = await import('../src/services/ontologyStore.js');
    const { getProject } = await import('../src/services/ontologies.js');
    const { put } = await import('../src/db.js');
    const { newId } = await import('../src/ids.js');
    const contributor = await login('contributor', 'Contributor Fenced');
    const editor = await login('editor', 'Editor Fenced');
    const steward = await userOf(await login('steward', 'Steward Fenced'));
    const editorId = (await userOf(editor)).id;
    // What another process does after this merger's lease lapsed: it only touches the database.
    const meddle: Record<string, (id: string) => void> = {
      withdraw: (id) => put('changeRequests', { ...crsMod.getCR(id), status: 'withdrawn', rev: (crsMod.getCR(id).rev ?? 0) + 1 }, demoId),
      'request changes': (id) => {
        put('reviews', { id: newId('rev'), changeRequestId: id, userId: editorId, roles: ['editor'], decision: 'request-changes', at: new Date().toISOString() }, id);
        put('changeRequests', { ...crsMod.getCR(id), rev: (crsMod.getCR(id).rev ?? 0) + 1 }, demoId);
      },
      patch: (id) => put('changeRequests', { ...crsMod.getCR(id), ops: [{ op: 'updateAnnotations', iri: SKILL, set: { comment: 'Unreviewed.' } }], rev: (crsMod.getCR(id).rev ?? 0) + 1 }, demoId),
    };
    for (const [what, fn] of Object.entries(meddle)) {
      const created = await edit(contributor, { termIri: `${VOL}Role`, set: { examples: [`fenced ${what}`] }, submit: true });
      put('changeRequests', { ...crsMod.getCR(created.body.id), status: 'approved', approvedAs: { level: 'patch', confirmation: false } }, demoId);
      const head = ontologyStore.head(getProject(demoId));
      const original = ontologyStore.commitWorking;
      const spy = vi.spyOn(ontologyStore, 'commitWorking').mockImplementation(async function (this: typeof ontologyStore, ...args) {
        fn(created.body.id); // lands just before the merge's commit
        return original.apply(ontologyStore, args);
      });
      try {
        await expect(crsMod.merge(crsMod.getCR(created.body.id), steward), what).rejects.toMatchObject({ status: 409 });
      } finally {
        spy.mockRestore();
      }
      expect(ontologyStore.head(getProject(demoId)), what).toBe(head);
      expect(crsMod.getCR(created.body.id).status, what).not.toBe('merged');
    }
  });

  it('does not commit when the merge-time checks could not run', async () => {
    const crsMod = await import('../src/services/changeRequests.js');
    const { ontologyStore } = await import('../src/services/ontologyStore.js');
    const { getProject } = await import('../src/services/ontologies.js');
    const { put } = await import('../src/db.js');
    const contributor = await login('contributor', 'Contributor Flaky');
    const created = await edit(contributor, { termIri: `${VOL}Role`, set: { comment: 'Checked or not at all.' }, submit: true });
    put('changeRequests', { ...crsMod.getCR(created.body.id), status: 'approved', approvedAs: { level: 'patch', confirmation: false } }, demoId);
    const head = ontologyStore.head(getProject(demoId));
    const spy = vi.spyOn(ontologyStore, 'working').mockRejectedValueOnce(new Error('transient read failure'));
    try {
      const result = await crsMod.merge(crsMod.getCR(created.body.id), await userOf(await login('steward', 'Steward Flaky')));
      expect(result.status).not.toBe('merged');
    } finally {
      spy.mockRestore();
    }
    expect(ontologyStore.head(getProject(demoId))).toBe(head);
  });

  it('sends an approved request to a vote when a late objection asks for one', async () => {
    const crsMod = await import('../src/services/changeRequests.js');
    const { getProject, updateProject } = await import('../src/services/ontologies.js');
    const { GOVERNANCE_TEMPLATES } = await import('../src/services/governance.js');
    const { put } = await import('../src/db.js');
    const project = getProject(demoId);
    const saved = project.governance;
    updateProject({ ...project, governance: GOVERNANCE_TEMPLATES['lazy-consensus'] });
    try {
      const contributor = await login('contributor', 'Contributor Objected');
      const editor = await login('editor', 'Editor Objector');
      const created = await edit(contributor, { termIri: `${VOL}Role`, set: { editorialNote: 'Objected to later.' } });
      put('changeRequests', { ...crsMod.getCR(created.body.id), status: 'approved', reviewStartedAt: '2000-01-01T00:00:00Z', approvedAs: { level: 'patch', confirmation: false } }, demoId);
      const objected = await editor.post(`/api/change-requests/${created.body.id}/reviews`).send({ decision: 'object', comment: 'Let us vote on it.' });
      expect(objected.body.status).toBe('voting');
      expect((await editor.post(`/api/change-requests/${created.body.id}/merge`)).status).toBe(409);
      // A request already approved by a vote is not sent to another one by the same rule.
      const voted = await edit(contributor, { termIri: `${VOL}Role`, set: { comment: 'Voted through.' } });
      put('changeRequests', { ...crsMod.getCR(voted.body.id), status: 'approved', reviewStartedAt: '2000-01-01T00:00:00Z', approvedAs: { level: 'patch', confirmation: false, voted: true } }, demoId);
      await editor.post(`/api/change-requests/${voted.body.id}/reviews`).send({ decision: 'object' });
      expect(crsMod.getCR(voted.body.id).status).not.toBe('voting');
    } finally {
      updateProject({ ...getProject(demoId), governance: saved });
    }
  });

  it('publishes a release from the draft as it is once nothing else is changing it, so a merge just before is kept', async () => {
    const crsMod = await import('../src/services/changeRequests.js');
    const releases = await import('../src/services/releases.js');
    const { withWorkingDraftLock } = await import('../src/services/repoLock.js');
    const { put, list } = await import('../src/db.js');
    const steward = await login('steward', 'Steward Release');
    const stewardUser = await userOf(steward);
    const contributor = await login('contributor', 'Contributor Release');
    const created = await edit(contributor, { termIri: `${VOL}Agent`, set: { comment: 'Merged while the release waited.' } });
    put('changeRequests', { ...crsMod.getCR(created.body.id), status: 'approved', approvedAs: { level: 'patch', confirmation: false } }, demoId);
    await steward.post(`/api/ontologies/${demoId}/releases`).send({});
    const pending = list<{ id: string; status: string; ontologyId: string }>('releases', demoId).find((r) => r.status === 'draft' || r.status === 'voting')!;
    // Treated as ready to publish (its vote, if it needs one, is beside the point here).
    const draft = put('releases', { ...pending, status: 'draft' }, demoId);

    // A merge is under way (holding the lock) when the release is asked for.
    let finish!: () => void;
    const finishing = new Promise<void>((resolve) => (finish = resolve));
    let started!: () => void;
    const inside = new Promise<void>((resolve) => (started = resolve));
    const merging = withWorkingDraftLock({ id: demoId }, async () => {
      started();
      await finishing;
      return crsMod.merge(crsMod.getCR(created.body.id), stewardUser);
    });
    await inside;
    const publishing = releases.publishRelease(draft as never, stewardUser);
    await sleep(50);
    finish();
    expect((await merging).status).toBe('merged');
    const published = await publishing;
    expect(published.status).toBe('published');
    expect((await contributor.get(termPath(`${VOL}Agent`))).body.comment).toBe('Merged while the release waited.');
  });

  /* Git is a projection of the database: kill points between the two, and repair through ordinary reads. */
  const repo = async () => {
    const { ontologyStore } = await import('../src/services/ontologyStore.js');
    const { getProject } = await import('../src/services/ontologies.js');
    const { execFileSync } = await import('node:child_process');
    const path = await import('node:path');
    const fs = await import('node:fs');
    const { config } = await import('../src/config.js');
    const project = getProject(demoId);
    // The repository as it is on disk, without the repair that reads through ontologyStore do first.
    const raw = path.join(config.dataDir, 'ontologies', project.slug);
    const rawGit = (...args: string[]) => execFileSync('git', args, { cwd: raw, encoding: 'utf8' }).trim();
    const rawFile = (name: string) => fs.readFileSync(path.join(raw, name), 'utf8');
    return { ontologyStore, project, rawGit, rawFile, raw };
  };
  const approvedEdit = async (who: string, iri: string, set: object) => {
    const crsMod = await import('../src/services/changeRequests.js');
    const { put } = await import('../src/db.js');
    const created = await edit(await login('contributor', who), { termIri: iri, set, submit: true });
    put('changeRequests', { ...crsMod.getCR(created.body.id), status: 'approved', approvedAs: { level: 'patch', confirmation: false } }, demoId);
    return created.body.id as string;
  };
  /**
   * Runs a merge or publication in another process, which is SIGKILLed the
   * instant the database transaction moving the working draft commits (see
   * writerProcess.ts): nothing after COMMIT runs, not even a finally block.
   */
  const killedAfterCommit = async (op: 'merge' | 'publish', id: string, userId: string) => {
    const { spawnSync } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const { remove } = await import('../src/db.js');
    const script = fileURLToPath(new URL('./writerProcess.ts', import.meta.url));
    const child = spawnSync(process.execPath, ['--no-warnings', '--import', 'tsx', script, op, id, userId], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', env: process.env, timeout: 90_000 });
    expect(child.signal, `${child.stdout}\n${child.stderr}`).toBe('SIGKILL');
    // The dead process's working-draft lease would lapse in a minute; let the test go on without waiting.
    remove('kv', `working-draft-lock:${demoId}`);
  };
  /** No pins are left: the draft (and through it all its history) is held by refs/concord/draft alone. */
  const onlyDraftPins = (rawGit: (...args: string[]) => string, head: string) => {
    expect(rawGit('for-each-ref', 'refs/concord/commits/')).toBe('');
    expect(rawGit('rev-parse', 'refs/concord/draft')).toBe(head);
  };
  const pinnedCommits = (rawGit: (...args: string[]) => string) => rawGit('for-each-ref', '--format=%(objectname)', 'refs/concord/commits/').split('\n').filter(Boolean);
  const collectGarbage = (rawGit: (...args: string[]) => string) => {
    rawGit('reflog', 'expire', '--expire=now', '--all');
    rawGit('gc', '-q', '--prune=now');
  };
  /** A writer in another process committing a draft with one more triple; with afterPin it is killed, or stopped until SIGCONT, right after pinning its commit. */
  const writerProcess = async (label: string, afterPin?: 'kill' | 'stop') => {
    const { spawn } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const fs = await import('node:fs');
    const { project } = await repo();
    const child = spawn(process.execPath, ['--no-warnings', '--import', 'tsx', fileURLToPath(new URL('./writerProcess.ts', import.meta.url)), 'advance', label], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, WRITER_AFTER_PIN: afterPin ?? '', WRITER_SLUG: project.slug },
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
    const stopped = async () => {
      for (let i = 0; i < 1200; i++) {
        const stat = fs.readFileSync(`/proc/${child.pid}/stat`, 'utf8');
        if (stat.slice(stat.lastIndexOf(')') + 2).startsWith('T')) return;
        await sleep(50);
      }
      throw new Error(`writer never stopped: ${out}`);
    };
    return { child, exited, stopped, output: () => out.trim() };
  };

  it('never lets a copy read before a merge be saved over it', async () => {
    const crsMod = await import('../src/services/changeRequests.js');
    const { put } = await import('../src/db.js');
    const id = await approvedEdit('Contributor Stale Copy', `${VOL}Cause`, { examples: ['stale copy'] });
    // A writer holding a copy, paused before saving while a merge recorded itself: its save is refused.
    await expect(
      crsMod.updateCR(crsMod.getCR(id), (c) => {
        put('changeRequests', { ...crsMod.getCR(id), status: 'merged', mergedCommit: 'abc', rev: (c.rev ?? 0) + 1 }, demoId);
        c.status = 'withdrawn';
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(crsMod.getCR(id)).toMatchObject({ status: 'merged', mergedCommit: 'abc' });
    // And a copy that is already out of date is refused before anything is written.
    const old = { ...crsMod.getCR(id), rev: 0 };
    await expect(crsMod.updateCR(old, (c) => (c.title = 'Overwritten'))).rejects.toMatchObject({ status: 409 });
  });

  it('writes a review only together with the request it was given on', async () => {
    const crsMod = await import('../src/services/changeRequests.js');
    const { clock } = await import('../src/clock.js');
    const { put, list } = await import('../src/db.js');
    const contributor = await login('contributor', 'Contributor Atomic Review');
    const editor = await login('editor', 'Editor Atomic Review');
    const created = await edit(contributor, { termIri: `${VOL}Cause`, set: { comment: 'Reviewed atomically.' }, submit: true });
    const id = created.body.id;
    // Someone else writes the request between the review being made and saved: both are refused, together.
    const iso = clock.iso.bind(clock);
    let calls = 0;
    const spy = vi.spyOn(clock, 'iso').mockImplementation(() => {
      if (++calls === 2) put('changeRequests', { ...crsMod.getCR(id), rev: (crsMod.getCR(id).rev ?? 0) + 1 }, demoId);
      return iso();
    });
    try {
      expect((await editor.post(`/api/change-requests/${id}/reviews`).send({ decision: 'request-changes', comment: 'Lost with its save.' })).status).toBe(409);
    } finally {
      spy.mockRestore();
    }
    expect(list<{ comment?: string }>('reviews', id).some((r) => r.comment === 'Lost with its save.')).toBe(false);
  });

  it('keeps a committed merge if the process dies before git is updated, and repairs git on the next read', async () => {
    const crsMod = await import('../src/services/changeRequests.js');
    const { ontologyStore, project, rawGit, rawFile } = await repo();
    const id = await approvedEdit('Contributor Crash', `${VOL}Cause`, { comment: 'Survives a crash.' });
    const before = ontologyStore.head(project);
    await killedAfterCommit('merge', id, (await userOf(await login('steward', 'Steward Crash'))).id);
    // The merge and its bookkeeping landed together in the database...
    const merged = ontologyStore.head(project);
    expect(merged).not.toBe(before);
    expect(crsMod.getCR(id)).toMatchObject({ status: 'merged', mergedCommit: merged });
    // ...while git was never touched.
    expect(rawGit('rev-parse', 'HEAD')).toBe(before);
    // The commit only the database names survives garbage collection.
    rawGit('reflog', 'expire', '--expire=now', '--all');
    rawGit('gc', '-q', '--prune=now');
    expect(rawGit('cat-file', '-t', merged)).toBe('commit');
    // An ordinary read puts git right: branch, index and files.
    expect((await (await login('member', 'Reader Crash')).get(termPath(`${VOL}Cause`))).body.comment).toBe('Survives a crash.');
    expect(rawGit('rev-parse', 'HEAD')).toBe(merged);
    expect(rawGit('status', '--porcelain', '--untracked-files=no')).toBe('');
    expect(rawFile('ontology.ttl')).toContain('Survives a crash.');
    onlyDraftPins(rawGit, merged);
  });

  it('repairs checked-out files that failed to update, and files an older sync put back', async () => {
    const crsMod = await import('../src/services/changeRequests.js');
    const { ontologyStore, project, rawGit, rawFile, raw } = await repo();
    const fs = await import('node:fs');
    const path = await import('node:path');
    const id = await approvedEdit('Contributor Checkout', `${VOL}Cause`, { editorialNote: 'Checked out eventually.' });
    const spy = vi.spyOn(ontologyStore, 'checkout').mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    try {
      expect((await crsMod.merge(crsMod.getCR(id), await userOf(await login('steward', 'Steward Checkout')))).status).toBe('merged');
    } finally {
      spy.mockRestore();
    }
    await ontologyStore.working(project);
    expect(rawGit('status', '--porcelain', '--untracked-files=no')).toBe('');
    expect(rawFile('ontology.ttl')).toBe(ontologyStore.readWorkingText(project, ontologyStore.head(project)));

    // An older sync (from another process) put the previous draft's files back and recorded that it had.
    const head = ontologyStore.head(project);
    const older = rawGit('rev-parse', `${head}~1`);
    rawGit('read-tree', '--reset', '-u', older);
    const stamp = path.join(raw, '.git', 'concord-synced');
    fs.writeFileSync(stamp, fs.readFileSync(stamp, 'utf8').replace(head, older));
    ontologyStore.versions(project);
    expect(rawFile('ontology.ttl')).toContain('Checked out eventually.');
    // A branch ahead of the database is put back too.
    rawGit('update-ref', 'HEAD', rawGit('commit-tree', `${head}^{tree}`, '-p', head, '-m', 'stray'));
    ontologyStore.log(project);
    expect(rawGit('rev-parse', 'HEAD')).toBe(head);
  });

  it('restores release tags from the published releases, including ones from before', async () => {
    const { ontologyStore, project, rawGit } = await repo();
    const { list } = await import('../src/db.js');
    const published = list<{ version: string; status: string; commit?: string }>('releases', demoId).filter((r) => r.status === 'published' && r.commit);
    expect(published.length).toBeGreaterThan(0);
    for (const r of published) rawGit('tag', '-d', `v${r.version}`);
    await ontologyStore.at(project, published[0].version);
    for (const r of published) expect(rawGit('rev-parse', `v${r.version}^{commit}`)).toBe(r.commit);
  });

  it('drops the pin of an advance that was refused', async () => {
    const { ontologyStore, project, rawGit } = await repo();
    const graph = await ontologyStore.working(project);
    const stale = rawGit('rev-parse', `${ontologyStore.head(project)}~1`);
    await expect(ontologyStore.commitWorking(project, graph, 'refused', { name: 'Refused' }, stale)).rejects.toMatchObject({ status: 409 });
    onlyDraftPins(rawGit, ontologyStore.head(project));
  });

  it('records a release atomically, survives dying before its tag, and refuses a second publisher', async () => {
    const crsMod = await import('../src/services/changeRequests.js');
    const releases = await import('../src/services/releases.js');
    const { ontologyStore, project, rawGit } = await repo();
    const { put, list } = await import('../src/db.js');
    const { getProject } = await import('../src/services/ontologies.js');
    const steward = await login('steward', 'Steward Atomic');
    const stewardUser = await userOf(steward);
    const id = await approvedEdit('Contributor Atomic', `${VOL}Cause`, { examples: ['released atomically'] });
    expect((await crsMod.merge(crsMod.getCR(id), stewardUser)).status).toBe('merged');
    await steward.post(`/api/ontologies/${demoId}/releases`).send({});
    const pending = list<{ id: string; status: string; version: string; changeRequestIds: string[] }>('releases', demoId).find((r) => r.status === 'draft' || r.status === 'voting')!;
    const draft = put('releases', { ...pending, status: 'draft' }, demoId);
    const tag = `v${draft.version}`;

    // The publisher's process is killed the moment its transaction commits.
    await killedAfterCommit('publish', draft.id, stewardUser.id);
    // Everything the release records landed with the commit.
    const stored = list<{ id: string; status: string; commit?: string }>('releases', demoId).find((r) => r.id === draft.id)!;
    expect(stored.status).toBe('published');
    expect(stored.commit).toBe(ontologyStore.head(project));
    expect(getProject(demoId).currentVersion).toBe(draft.version);
    for (const crId of draft.changeRequestIds) expect(crsMod.getCR(crId).status).toBe('released');
    // The tag follows from the database on the next ordinary read.
    expect(() => rawGit('rev-parse', '-q', '--verify', `refs/tags/${tag}`)).toThrow();
    expect((await steward.get(`/api/ontologies/${demoId}/source?format=turtle&ref=${draft.version}`)).status).toBe(200);
    expect(rawGit('rev-parse', `${tag}^{commit}`)).toBe(stored.commit);
    // Publishing again (from a copy read before) is refused rather than rewriting the version.
    const released = ontologyStore.readReleaseFile(project, draft.version, 'ontology.ttl');
    await expect(releases.publishRelease({ ...draft } as never, stewardUser)).rejects.toMatchObject({ status: 409 });
    expect(ontologyStore.readReleaseFile(project, draft.version, 'ontology.ttl')).toBe(released);
  });

  it('does not publish a release that was rejected or redrafted while it was being published', async () => {
    const crsMod = await import('../src/services/changeRequests.js');
    const releases = await import('../src/services/releases.js');
    const { ontologyStore, project, rawGit } = await repo();
    const { put, list } = await import('../src/db.js');
    const steward = await login('steward', 'Steward Rejected');
    const stewardUser = await userOf(steward);
    for (const [what, change] of [
      ['rejected', (r: { id: string; notes: string }) => ({ ...r, status: 'rejected' })],
      ['redrafted', (r: { id: string; notes: string }) => ({ ...r, notes: `${r.notes}\n\nRedrafted.` })],
    ] as const) {
      const id = await approvedEdit(`Contributor ${what}`, `${VOL}Cause`, { examples: [`release ${what}`] });
      expect((await crsMod.merge(crsMod.getCR(id), stewardUser)).status).toBe('merged');
      await steward.post(`/api/ontologies/${demoId}/releases`).send({});
      const pending = list<{ id: string; status: string; version: string; notes: string }>('releases', demoId).find((r) => r.status === 'draft' || r.status === 'voting')!;
      const draft = put('releases', { ...pending, status: 'draft' }, demoId);
      const head = ontologyStore.head(project);
      const original = ontologyStore.writeRelease;
      const spy = vi.spyOn(ontologyStore, 'writeRelease').mockImplementationOnce(async function (this: typeof ontologyStore, ...args) {
        put('releases', change(list<typeof draft>('releases', demoId).find((r) => r.id === draft.id)! as never), demoId);
        return original.apply(ontologyStore, args);
      });
      try {
        await expect(releases.publishRelease({ ...draft } as never, stewardUser), what).rejects.toMatchObject({ status: 409 });
      } finally {
        spy.mockRestore();
      }
      expect(ontologyStore.head(project), what).toBe(head);
      expect(list<{ id: string; status: string }>('releases', demoId).find((r) => r.id === draft.id)!.status, what).not.toBe('published');
      expect(() => rawGit('rev-parse', '-q', '--verify', `refs/tags/v${draft.version}`), what).toThrow();
      // Leave nothing pending for the next round.
      put('releases', { ...list<typeof draft>('releases', demoId).find((r) => r.id === draft.id)!, status: 'rejected' }, demoId);
    }
  });

  it('keeps a vote that passed for requests approved before votes were recorded on approval', async () => {
    const crsMod = await import('../src/services/changeRequests.js');
    const { getProject, updateProject } = await import('../src/services/ontologies.js');
    const { GOVERNANCE_TEMPLATES } = await import('../src/services/governance.js');
    const { put } = await import('../src/db.js');
    const { newId } = await import('../src/ids.js');
    const project = getProject(demoId);
    const saved = project.governance;
    const lazy = GOVERNANCE_TEMPLATES['lazy-consensus'];
    // Lazy consensus where one yes vote passes, so the test can hold a real, completed vote.
    updateProject({ ...project, governance: { ...lazy, changes: { ...lazy.changes, patch: { ...lazy.changes.patch, vote: { ...lazy.changes.patch.vote!, quorum: 0, threshold: 0.5 } } } } });
    try {
      const contributor = await login('contributor', 'Contributor Legacy Vote');
      const editor = await login('editor', 'Editor Legacy Vote');
      const editorUser = await userOf(editor);
      const created = await edit(contributor, { termIri: `${VOL}Cause`, set: { comment: 'Voted through long ago.' } });
      const id = created.body.id;
      // Objected to, voted on (and passed), then approved, all by an older version: approvedAs has no `voted`.
      put('reviews', { id: newId('rev'), changeRequestId: id, userId: editorUser.id, roles: ['editor'], decision: 'object', at: '2000-01-01T12:00:00Z' }, id);
      put('votes', { id: newId('vote'), subjectType: 'change-request', subjectId: id, userId: editorUser.id, roles: ['editor'], choice: 'yes', at: '2000-01-03T00:00:00Z' }, id);
      const cr = crsMod.getCR(id);
      put(
        'changeRequests',
        {
          ...cr,
          status: 'approved',
          opsUpdatedAt: '2000-01-01T00:00:00Z',
          reviewStartedAt: '2000-01-01T00:00:00Z',
          approvedAs: { level: 'patch', confirmation: false },
          timeline: [...cr.timeline, { at: '2000-01-02T00:00:00Z', type: 'status', message: 'vote opened (An objection was raised, so this goes to a vote.)' }, { at: '2000-01-06T00:00:00Z', type: 'status', message: 'approved — The vote passed.' }],
        },
        demoId,
      );
      const merged = await crsMod.merge(crsMod.getCR(id), await userOf(await login('steward', 'Steward Legacy Vote')));
      expect(merged.status).toBe('merged');
    } finally {
      updateProject({ ...getProject(demoId), governance: saved });
    }
  });

  it('writes a vote only together with the request it was cast on', async () => {
    const crsMod = await import('../src/services/changeRequests.js');
    const { getProject, updateProject } = await import('../src/services/ontologies.js');
    const { GOVERNANCE_TEMPLATES } = await import('../src/services/governance.js');
    const { clock } = await import('../src/clock.js');
    const { put, list } = await import('../src/db.js');
    const project = getProject(demoId);
    const saved = project.governance;
    updateProject({ ...project, governance: GOVERNANCE_TEMPLATES['lazy-consensus'] });
    try {
      const contributor = await login('contributor', 'Contributor Atomic Vote');
      const editor = await login('editor', 'Editor Atomic Vote');
      const created = await edit(contributor, { termIri: `${VOL}Cause`, set: { comment: 'Voted on atomically.' } });
      const id = created.body.id;
      put('changeRequests', { ...crsMod.getCR(id), status: 'voting', statusSince: clock.iso() }, demoId);
      // Someone else keeps writing the request while the vote is being made: the vote and its save are refused together.
      const iso = clock.iso.bind(clock);
      const spy = vi.spyOn(clock, 'iso').mockImplementation(() => {
        put('changeRequests', { ...crsMod.getCR(id), rev: (crsMod.getCR(id).rev ?? 0) + 1 }, demoId);
        return iso();
      });
      try {
        expect((await editor.post(`/api/change-requests/${id}/votes`).send({ choice: 'no', comment: 'Lost with its save.' })).status).toBe(409);
      } finally {
        spy.mockRestore();
      }
      expect(list<{ comment?: string }>('votes', id).some((v) => v.comment === 'Lost with its save.')).toBe(false);
      put('changeRequests', { ...crsMod.getCR(id), status: 'withdrawn' }, demoId);
    } finally {
      updateProject({ ...getProject(demoId), governance: saved });
    }
  });

  it('never lets a release vote begun before the release was published undo the publication', async () => {
    const releases = await import('../src/services/releases.js');
    const { put, list, mustGet, remove } = await import('../src/db.js');
    const { newId } = await import('../src/ids.js');
    const voter = await userOf(await login('editor', 'Editor Release Race'));
    const now = new Date().toISOString();
    // A major release whose vote has closed without quorum: anyone looking at this copy would reject it.
    const stale = put(
      'releases',
      { id: newId('rel'), ontologyId: demoId, version: '99.0.0', level: 'major' as const, status: 'voting' as const, changeRequestIds: [], notes: 'Raced.', versionIRI: 'https://example.org/raced/99.0.0', createdBy: voter.id, createdAt: now, statusSince: '2000-01-01T00:00:00Z' },
      demoId,
    );
    try {
      expect(releases.releaseGovernance(stale).outcome).toBe('rejected');
      // Another process publishes it after the vote (and the clock) read it.
      put('releases', { ...stale, status: 'published', commit: 'c0ffee', publishedAt: now, statusSince: now, rev: 1 }, demoId);
      await expect(releases.voteOnRelease({ ...stale }, voter, 'no')).rejects.toMatchObject({ status: 409 });
      expect(list('votes', stale.id)).toHaveLength(0);
      expect(await releases.advanceRelease({ ...stale })).toMatchObject({ status: 'published', commit: 'c0ffee' });
      expect(mustGet('releases', stale.id)).toMatchObject({ status: 'published', commit: 'c0ffee', publishedAt: now, rev: 1 });
    } finally {
      remove('releases', stale.id);
    }
  });

  it('never lets a sync that read an older draft drop what holds the newer one', async () => {
    const { ontologyStore, project, rawGit } = await repo();
    const gc = () => {
      rawGit('reflog', 'expire', '--expire=now', '--all');
      rawGit('gc', '-q', '--prune=now');
    };
    const later = Date.now() + 24 * 3600_000;
    const { OntologyGraph } = await import('@concord/core');
    const withLabel = (label: string) => OntologyGraph.fromTurtle(`${ontologyStore.readWorkingText(project)}\n<urn:concord-test:${label}> <http://www.w3.org/2000/01/rdf-schema#label> "${label}" .\n`);
    // A newer draft recorded while git still shows the older one, then a sync that read the older draft, a day later.
    const older = ontologyStore.head(project);
    const sync = vi.spyOn(ontologyStore, 'sync').mockImplementationOnce(() => undefined);
    let newer: string;
    try {
      newer = await ontologyStore.commitWorking(project, await withLabel('newer'), 'newer draft', { name: 'Newer' });
    } finally {
      sync.mockRestore();
    }
    expect(rawGit('rev-parse', 'HEAD')).toBe(older);
    // (It read the older draft both for the branch and for pruning; only the reclaim's own transaction reads the database afresh.)
    const head = vi.spyOn(ontologyStore, 'head').mockReturnValueOnce(older).mockReturnValueOnce(older);
    const now = vi.spyOn(Date, 'now').mockReturnValue(later);
    try {
      ontologyStore.sync(project);
    } finally {
      head.mockRestore();
      now.mockRestore();
    }
    gc();
    expect(rawGit('cat-file', '-t', newer)).toBe('commit');
    // And reads put git back on the newer draft, leaving only its own pins.
    ontologyStore.log(project);
    expect(rawGit('rev-parse', 'HEAD')).toBe(ontologyStore.head(project));
    onlyDraftPins(rawGit, ontologyStore.head(project));

    // Once git holds the newer draft (and its pin is gone), a sync that read the older draft can't move what holds it back.
    const stale = vi.spyOn(ontologyStore, 'head').mockReturnValueOnce(older).mockReturnValueOnce(older);
    try {
      ontologyStore.sync(project);
    } finally {
      stale.mockRestore();
    }
    collectGarbage(rawGit);
    expect(rawGit('cat-file', '-t', newer)).toBe('commit');
    expect(rawGit('rev-parse', 'refs/concord/draft')).toBe(newer);
    ontologyStore.log(project);
    expect(rawGit('rev-parse', 'HEAD')).toBe(newer);
  });

  it('stops a sync that was overtaken from undoing its successor, and repairs files it put back anyway', async () => {
    const { ontologyStore, project, rawGit, rawFile, raw } = await repo();
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { get, put, remove } = await import('../src/db.js');
    const stamp = path.join(raw, '.git', 'concord-synced');
    const lease = `git-sync:${project.slug}`;
    ontologyStore.ensureSynced(project);
    const head = ontologyStore.head(project);
    // Files an overtaken sync put back after its successor finished: branch and record of the sync both look right.
    const stampBefore = fs.readFileSync(stamp, 'utf8');
    rawGit('read-tree', '--reset', '-u', `${head}~1`);
    expect(fs.readFileSync(stamp, 'utf8')).toBe(stampBefore);
    ontologyStore.log(project);
    expect(rawGit('status', '--porcelain', '--untracked-files=no')).toBe('');
    expect(rawFile('ontology.ttl')).toBe(ontologyStore.readWorkingText(project, head));

    // A sync presumed dead and replaced mid-way: it stops, leaves no record of a sync, and leaves its successor's lease alone.
    const checkout = vi.spyOn(ontologyStore, 'checkout').mockImplementationOnce(() => {
      put('kv', { id: lease, token: 'successor', until: Date.now() + 60_000 });
    });
    try {
      expect(() => ontologyStore.sync(project)).toThrow('another sync took over');
    } finally {
      checkout.mockRestore();
    }
    expect(get<{ token: string }>('kv', lease)?.token).toBe('successor');
    expect(fs.existsSync(stamp)).toBe(false);
    // While the successor holds the lease, others leave the job to it.
    ontologyStore.ensureSynced(project);
    expect(fs.existsSync(stamp)).toBe(false);
    // Once it is gone, the next read finishes the job.
    remove('kv', lease);
    ontologyStore.versions(project);
    expect(fs.existsSync(stamp)).toBe(true);
    expect(get('kv', lease)).toBeUndefined();
  });

  it('keeps a slow writer’s pin, and reclaims a stalled one’s only by refusing its commit', async () => {
    const { ontologyStore, project, rawGit } = await repo();
    const { PIN_GRACE_MS } = await import('../src/services/ontologyStore.js');
    // Slow: stopped right after pinning; meanwhile another process syncs and collects garbage, within the grace period.
    const slow = await writerProcess('slow', 'stop');
    await slow.stopped();
    const [slowCommit] = pinnedCommits(rawGit);
    ontologyStore.sync(project);
    collectGarbage(rawGit);
    expect(rawGit('cat-file', '-t', slowCommit)).toBe('commit');
    slow.child.kill('SIGCONT');
    await slow.exited;
    expect(slow.output()).toBe(`committed ${slowCommit}`);
    expect(ontologyStore.head(project)).toBe(slowCommit);
    collectGarbage(rawGit);
    expect(rawGit('cat-file', '-t', slowCommit)).toBe('commit');

    // Stalled past the grace period: its pin is reclaimed, and when it resumes its commit is refused, so nothing points at a lost commit.
    const stalled = await writerProcess('stalled', 'stop');
    await stalled.stopped();
    const [stalledCommit] = pinnedCommits(rawGit);
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + PIN_GRACE_MS + 60_000);
    try {
      ontologyStore.sync(project);
    } finally {
      now.mockRestore();
    }
    collectGarbage(rawGit);
    expect(() => rawGit('cat-file', '-t', stalledCommit)).toThrow();
    stalled.child.kill('SIGCONT');
    await stalled.exited;
    expect(stalled.output()).toBe('refused 409');
    expect(ontologyStore.head(project)).toBe(slowCommit);
    expect(pinnedCommits(rawGit)).toEqual([]);
  });

  it('reclaims the pins of writers that died, and keeps no pins for a draft that did not change', async () => {
    const crsMod = await import('../src/services/changeRequests.js');
    const { ontologyStore, project, rawGit } = await repo();
    const { PIN_GRACE_MS } = await import('../src/services/ontologyStore.js');
    const { OntologyGraph } = await import('@concord/core');
    for (const label of ['crashed-1', 'crashed-2', 'crashed-3']) expect((await (await writerProcess(label, 'kill')).exited).signal).toBe('SIGKILL');
    const abandoned = pinnedCommits(rawGit);
    expect(abandoned).toHaveLength(3);
    // Within the grace period they are left alone (their writers might only be slow), even as others commit.
    const graph = await OntologyGraph.fromTurtle(`${ontologyStore.readWorkingText(project)}\n<urn:concord-test:after-crash> <http://www.w3.org/2000/01/rdf-schema#label> "after crash" .\n`);
    await ontologyStore.commitWorking(project, graph, 'after the crashes', { name: 'Survivor' });
    expect(pinnedCommits(rawGit).sort()).toEqual([...abandoned].sort());
    // Past it, the next sync reclaims them, and their commits can be collected.
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + PIN_GRACE_MS + 60_000);
    try {
      ontologyStore.sync(project);
    } finally {
      now.mockRestore();
    }
    collectGarbage(rawGit);
    for (const sha of abandoned) expect(() => rawGit('cat-file', '-t', sha)).toThrow();
    const head = ontologyStore.head(project);
    onlyDraftPins(rawGit, head);

    // Advances and commits that change nothing add no pins, and neither does an ordinary merge, once synced.
    for (let i = 0; i < 20; i++) ontologyStore.advanceTo(project, head, head);
    for (let i = 0; i < 3; i++) expect(await ontologyStore.commitWorking(project, await ontologyStore.working(project), 'nothing new', { name: 'Same' })).toBe(head);
    onlyDraftPins(rawGit, head);
    const id = await approvedEdit('Contributor Pinless', `${VOL}Cause`, { comment: 'Merged without a pin left behind.' });
    expect((await crsMod.merge(crsMod.getCR(id), await userOf(await login('steward', 'Steward Pinless')))).status).toBe('merged');
    expect(ontologyStore.head(project)).not.toBe(head);
    onlyDraftPins(rawGit, ontologyStore.head(project));
  });
});
