import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
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
    const res = await request(app).get(`/api/ontologies/${demoId}/validation`);
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
});
