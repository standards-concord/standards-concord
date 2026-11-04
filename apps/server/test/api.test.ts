import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
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

describe('query assistant (offline helper)', () => {
  type Reply = { reply: string; query: string; target: string; columns: { variable: string; label: string }[]; simulated: boolean; unchanged?: boolean; offlineReason?: string };
  type Turn = { role: 'user' | 'assistant'; content: string };
  beforeEach(async () => (await import('../src/services/queryChat.js')).resetQueryChatLimits());

  const ask = async (agent: Agent, messages: Turn[], query = '') => {
    const res = await agent.post(`/api/ontologies/${demoId}/query-chat`).send({ messages, query, target: 'ontology' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as Reply;
  };
  /** Runs a conversation the way the page does: each answer's query goes back with the next message. */
  const converse = async (agent: Agent, ...said: string[]) => {
    const history: Turn[] = [];
    let query = '';
    const replies: Reply[] = [];
    for (const text of said) {
      history.push({ role: 'user', content: text });
      const r = await ask(agent, history, query);
      replies.push(r);
      history.push({ role: 'assistant', content: r.reply });
      if (!r.unchanged) query = r.query;
    }
    return replies;
  };

  it('needs a signed-in person and a message, and bounds what it is sent', async () => {
    expect((await request(app).post(`/api/ontologies/${demoId}/query-chat`).send({ messages: [{ role: 'user', content: 'hi' }] })).status).toBe(401);
    const agent = await login('contributor');
    expect((await agent.post(`/api/ontologies/${demoId}/query-chat`).send({ messages: [] })).status).toBe(400);
    const long = await agent.post(`/api/ontologies/${demoId}/query-chat`).send({ messages: [{ role: 'user', content: 'List every organisation' }], query: 'x'.repeat(8001) });
    expect(long.status).toBe(400);
    const { boundedQueryChatRequest } = await import('../src/services/queryChat.js');
    const b = boundedQueryChatRequest({
      messages: Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `${i} ${'w'.repeat(3000)}` })).concat([{ role: 'user', content: 'latest' }]),
      dataSummary: [{ classIri: 'x'.repeat(301), count: 1 }, { classIri: 'https://e.org/A', count: 2 }, { classIri: 'https://e.org/B', count: -1 }],
    });
    expect(b.messages.at(-1)).toEqual({ role: 'user', content: 'latest' });
    expect(b.messages.reduce((n, m) => n + m.content.length, 0)).toBeLessThanOrEqual(8000);
    expect(b.dataSummary).toEqual([{ classIri: 'https://e.org/A', count: 2 }]);
  });

  it('limits each person to one question at a time and a number per ten minutes', async () => {
    const { QUERY_CHAT_LIMITS } = await import('../src/services/queryChat.js');
    const agent = await login('contributor', 'Rate limited');
    const one = [{ role: 'user' as const, content: 'Which classes have no definition?' }];
    for (let i = 0; i < QUERY_CHAT_LIMITS.perUser; i++) await ask(agent, one);
    const over = await agent.post(`/api/ontologies/${demoId}/query-chat`).send({ messages: one, query: '', target: 'ontology' });
    expect(over.status).toBe(429);
  });

  it('says why the offline helper answered', async () => {
    const member = await login('contributor');
    expect((await ask(member, [{ role: 'user', content: 'List every organisation' }])).offlineReason).toBe('unavailable');
    const { admitQueryChat } = await import('../src/services/queryChat.js');
    const { config } = await import('../src/config.js');
    const provider = config.llm.provider;
    try {
      (config.llm as { provider: string }).provider = 'anthropic';
      const outsider = admitQueryChat('someone-else', false);
      outsider.done();
      expect(outsider).toMatchObject({ useClaude: false, offlineReason: 'not-member' });
      const limit = config.llm.queryAssistantDailyLimit;
      config.llm.queryAssistantDailyLimit = 0;
      const spent = admitQueryChat('a-member', true);
      spent.done();
      expect(spent).toMatchObject({ useClaude: false, offlineReason: 'limit' });
      config.llm.queryAssistantDailyLimit = limit;
    } finally {
      (config.llm as { provider: string }).provider = provider;
    }
  });

  it('writes, refines step by step and counts, keeping earlier filters', async () => {
    const agent = await login('contributor');
    const [first, more, under, title, count] = await converse(
      agent,
      'List every volunteering opportunity',
      'Also show the minimum age and who it is offered by',
      'Only those with a minimum age under 15',
      'Also show the title',
      'How many are there?',
    );
    expect(first).toMatchObject({ simulated: true, target: 'data' });
    expect(first.query).toContain('vol:VolunteeringOpportunity');
    expect(first.columns.map((c) => c.label)).toContain('title');
    expect(first.query).toContain('LIMIT 100');
    expect(first.reply).toContain('up to 100 rows');
    expect(more.query).toContain('vol:minimumAge');
    expect(more.query).toContain('vol:offeredBy');
    expect(under.query).toContain('FILTER(?minimumAge < 15)');
    expect(under.query).toContain('vol:offeredBy');
    // A later refinement keeps the filter.
    expect(title.query).toContain('FILTER(?minimumAge < 15)');
    expect(count.query).toContain('COUNT(DISTINCT');
    expect(count.query).toContain('FILTER(?minimumAge < 15)');
    expect(count.columns[0].label).toMatch(/Number of volunteering opportunity/i);
  });

  it('"at least" includes the boundary, "remove" removes and "all of them" lifts the limit', async () => {
    const agent = await login('contributor');
    const [, atLeast, removed, all] = await converse(agent, 'List every volunteering opportunity with its minimum age', 'Only those with a minimum age of at least 16', 'Remove the minimum age', 'Show all of them');
    expect(atLeast.query).toContain('FILTER(?minimumAge >= 16)');
    expect(atLeast.reply).toContain('at least 16');
    expect(removed.query).not.toContain('minimumAge');
    expect(all.query).not.toContain('LIMIT');
  });

  it('a new question starts afresh, and questions about the model run against the ontology', async () => {
    const agent = await login('contributor');
    const [, model, orgs] = await converse(agent, 'List every volunteering opportunity with its minimum age', 'Which classes have no definition?', 'How many organisations are there?');
    expect(model.target).toBe('ontology');
    expect(model.query).toContain('FILTER NOT EXISTS');
    expect(orgs.query).toContain('vol:Organisation');
    expect(orgs.query).not.toContain('minimumAge');
  });

  it('never rewrites a query edited by hand', async () => {
    const agent = await login('contributor');
    const [first] = await converse(agent, 'List every volunteering opportunity');
    const edited = first.query.replace('LIMIT 100', 'LIMIT 5');
    const r = await ask(agent, [{ role: 'user', content: 'List every volunteering opportunity' }, { role: 'assistant', content: first.reply }, { role: 'user', content: 'Also show the minimum age' }], edited);
    expect(r.unchanged).toBe(true);
    expect(r.query).toBe(edited);
    expect(r.reply).toMatch(/changed since/);
  });

  it('every answer passes the query policy: parsed and planned by sparq, never run', async () => {
    const { queryProblem } = await import('../src/services/queryPolicy.js');
    expect(queryProblem('SELECT ?x WHERE { ?x ?y ?z } LIMIT 1')).toBeUndefined();
    expect(queryProblem('ASK { ?s ?p ?o }')).toBeUndefined();
    expect(queryProblem('SELECT ?x WHERE { ?x ?y }')).toMatch(/doesn’t parse/);
    expect(queryProblem('SELECT * WHERE { SERVICE SILENT <http://example.org/sparql> { ?s ?p ?o } }')).toMatch(/SERVICE/);
    expect(queryProblem('SELECT * FROM <http://example.org/g> WHERE { ?s ?p ?o }')).toMatch(/FROM/);
    expect(queryProblem('INSERT DATA { <a:b> <a:c> <a:d> }')).toMatch(/read-only/);
    // Keywords inside strings, IRIs and comments don't count.
    expect(queryProblem('SELECT ?x WHERE { ?x <http://e.org/service> "SERVICE from" } # SERVICE')).toBeUndefined();
    // Planning, not running: a query whose answer would be huge is checked instantly.
    const values = Array.from({ length: 200 }, (_, i) => i).join(' ');
    const t0 = performance.now();
    expect(queryProblem(`SELECT * WHERE { VALUES ?a { ${values} } VALUES ?b { ${values} } VALUES ?c { ${values} } VALUES ?d { ${values} } }`)).toBeUndefined();
    expect(performance.now() - t0).toBeLessThan(500);
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
