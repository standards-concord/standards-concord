import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { openDb, put } from '../src/db.js';
import { getProject, members, updateProject } from '../src/services/ontologies.js';
import { ontologyStore } from '../src/services/ontologyStore.js';
import { seedDemo } from '../src/services/simulation.js';
import { publishRelease, releaseApproval, releaseGovernance } from '../src/services/releases.js';
import type { Release, Vote } from '@concord/shared';

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
  await openDb();
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

    // The approval is recorded at publish time: changing the policy afterwards doesn't rewrite the history.
    expect(published.body.approvalSource).toBe('recorded');
    const recorded = published.body.governance;
    const project = await steward.get(`/api/ontologies/${demoId}`);
    const policy = structuredClone(project.body.governance);
    const original = structuredClone(policy);
    policy.releases.minor.minApprovals = recorded.requiredApprovals + 3;
    policy.releases.minor.reviewPeriodDays = 99;
    expect((await steward.put(`/api/ontologies/${demoId}/governance`).send({ policy })).status).toBe(200);
    const later = await steward.get(`/api/releases/${draft.id}`);
    expect(later.body.approvalSource).toBe('recorded');
    expect(later.body.governance.requiredApprovals).toBe(recorded.requiredApprovals);
    expect(later.body.governance.rule.reviewPeriodDays).toBe(recorded.rule.reviewPeriodDays);
    expect(later.body.governance.reviewPeriodEndsAt).toBe(recorded.reviewPeriodEndsAt);
    expect((await steward.put(`/api/ontologies/${demoId}/governance`).send({ policy: original })).status).toBe(200);

    // The set-up release had no approval rules, and says so rather than borrowing today's.
    const first = (await steward.get(`/api/ontologies/${demoId}/releases`)).body.find((r: { version: string }) => r.version === '1.0.0');
    expect((await steward.get(`/api/releases/${first.id}`)).body.approvalSource).toBe('bootstrap');
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

  // A preferred prefix of "@import" used to be stored and then written into the
  // JSON-LD context, which made the server fetch the namespace URL whenever it
  // wrote JSON-LD. The browser has no control for this field, so it is tested here.
  it('refuses a change request that sets a JSON-LD keyword as the preferred prefix', async () => {
    const editor = await login('editor', 'Editor Ike');
    const res = await editor.post(`/api/ontologies/${demoId}/change-requests`).send({
      title: 'Change the prefix',
      description: 'Sets a keyword prefix.',
      kind: 'feature',
      ops: [{ op: 'setMetadata', set: { preferredPrefix: '@import', preferredNamespace: 'http://127.0.0.1:9/context' } }],
    });
    // Like any edit that can't be applied, it is kept as a draft that fails validation, so it can never merge.
    expect(res.status).toBe(201);
    expect(res.body.validation.passed).toBe(false);
    expect(res.body.validation.lint.map((l: { message: string }) => l.message).join('\n')).toMatch(/preferredPrefix must be a prefix name/);
    // Nothing was reasoned over, so the report must not claim consistency (it used to say consistent: true).
    expect(res.body.validation.reasoner).toMatchObject({ engine: 'none', available: false, checked: 'none', consistent: false });
    const jsonld = await editor.get(`/api/ontologies/${demoId}/source?format=jsonld`);
    expect(Object.keys(JSON.parse(jsonld.text)['@context'])).not.toContain('@import');
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

  // With the store async, each call's visibility check ran inside flatMap(), so the list came back as empty objects.
  it('lists the calls a signed-in person can see', async () => {
    const tester = await login('steward', 'Steward Lists');
    const m = await tester.post(`/api/ontologies/${demoId}/meetings/upload`).send({ title: 'Listed call', transcript: 'Priya Shah: Hello.\nTom Okafor: Hi.' });
    expect(m.status).toBe(201);
    const listed = await tester.get(`/api/ontologies/${demoId}/meetings`);
    expect(listed.body.find((x: { id?: string }) => x.id === m.body.id)).toMatchObject({ title: 'Listed call' });
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
    // SHACL too, in any format, against the latest release by default (as for POST to the ontology IRI).
    const shacl = parse(
      await call(7, 'tools/call', {
        name: 'validate_data',
        arguments: { ontology: 'volunteering', format: 'jsonld', data: JSON.stringify({ '@id': 'https://example.org/opp', '@type': 'https://w3id.org/odi/volunteering#VolunteeringOpportunity' }) },
      }),
    );
    const report = JSON.parse(shacl.result.content[0].text);
    expect(report.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(report.conforms).toBe(false);
    expect(report.results.some((r: { path?: string }) => r.path === 'https://w3id.org/odi/volunteering#hasRole')).toBe(true);
    expect(report.shapes).toMatch(new RegExp(`/def/volunteering/${report.version.replace(/\./g, '\\.')}\\.shacl\\.ttl$`));
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
  type Reply = { reply: string; query: string; target: string; columns: { variable: string; label: string }[]; simulated: boolean; unchanged?: boolean; offlineReason?: string; offlineState?: unknown };
  type Turn = { role: 'user' | 'assistant'; content: string };
  beforeEach(async () => (await import('../src/services/queryChat.js')).resetQueryChatLimits());

  const ask = async (agent: Agent, messages: Turn[], query = '', offlineState?: unknown) => {
    const res = await agent.post(`/api/ontologies/${demoId}/query-chat`).send({ messages, query, target: 'ontology', offlineState });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as Reply;
  };
  /** Runs a conversation the way the page does: each answer's query goes back with the next message. */
  const converse = async (agent: Agent, ...said: string[]) => {
    const history: Turn[] = [];
    let query = '';
    let state: unknown;
    const replies: Reply[] = [];
    for (const text of said) {
      history.push({ role: 'user', content: text });
      const r = await ask(agent, history, query, state);
      replies.push(r);
      history.push({ role: 'assistant', content: r.reply });
      if (!r.unchanged) (query = r.query), (state = r.offlineState);
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

  it('refuses a conversation sent on under another account', async () => {
    const agent = await login('contributor', 'Account check');
    const me = (await agent.get('/api/session')).body.user.id as string;
    const body = { messages: [{ role: 'user', content: 'List every organisation' }], query: '', target: 'data' };
    expect((await agent.post(`/api/ontologies/${demoId}/query-chat`).send({ ...body, account: 'someone-else' })).status).toBe(409);
    expect((await agent.post(`/api/ontologies/${demoId}/query-chat`).send({ ...body, account: me })).status).toBe(200);
  });

  it('says why the offline helper answered', async () => {
    const member = await login('contributor');
    expect((await ask(member, [{ role: 'user', content: 'List every organisation' }])).offlineReason).toBe('unavailable');
    const { admitQueryChat } = await import('../src/services/queryChat.js');
    const { config } = await import('../src/config.js');
    const provider = config.llm.provider;
    try {
      (config.llm as { provider: string }).provider = 'anthropic';
      const outsider = await admitQueryChat('someone-else', demoId, false);
      await outsider.done();
      expect(outsider).toMatchObject({ useClaude: false, offlineReason: 'not-member' });
      // Today's allowances are per person, per ontology and for the deployment, and kept in the database.
      const limits = { ...config.llm.queryAssistant };
      Object.assign(config.llm.queryAssistant, { perUserPerDay: 2, perOntologyPerDay: 3, perDay: 100 });
      const take = async (user: string, ontology = 'ont-quota') => {
        const g = await admitQueryChat(user, ontology, true);
        if (g.useClaude) g.spend();
        await g.done();
        return g.useClaude;
      };
      expect([await take('quota-a'), await take('quota-a'), await take('quota-a')]).toEqual([true, true, false]);
      const over = await admitQueryChat('quota-a', 'ont-quota', true);
      await over.done();
      expect(over.offlineReason).toBe('limit');
      // One person can't use up everyone's allowance, but the ontology's is shared.
      expect([await take('quota-b'), await take('quota-c')]).toEqual([true, false]);
      expect(await take('quota-c', 'another-ontology')).toBe(true);
      const { get } = await import('../src/db.js');
      const day = new Date().toISOString().slice(0, 10);
      expect((await get<{ count: number }>('kv', `query-assistant:${day}:user:quota-a`))?.count).toBe(2);
      expect((await get<{ count: number }>('kv', `query-assistant:${day}:ontology:ont-quota`))?.count).toBe(3);
      Object.assign(config.llm.queryAssistant, limits);
    } finally {
      (config.llm as { provider: string }).provider = provider;
    }
  });

  it('reserves allowances atomically: a rival can’t take the last one in the gap, and a failed write leaves nothing taken', async () => {
    const { reserveCounters, get, detached } = await import('../src/db.js');
    const ids = ['atomic:user', 'atomic:ontology', 'atomic:all'];
    const limits = ids.map((id) => ({ id, max: 1 }));
    const count = async (id: string) => (await get<{ count: number }>('kv', id))?.count ?? 0;
    // A rival (another request, or another backend process) tries to reserve in the gap between this one's read
    // and its write. It used to get the same last allowance; now it waits its turn and finds none left.
    let rival: Promise<boolean> | undefined;
    const first = await reserveCounters(limits, 'atomic', {
      afterRead: () => {
        rival = detached(() => reserveCounters(limits, 'atomic'));
      },
    });
    expect(first).toBe(true);
    expect(await rival).toBe(false);
    expect(await Promise.all(ids.map(count))).toEqual([1, 1, 1]);
    expect(await reserveCounters(limits, 'atomic')).toBe(false);

    // A failure part-way through the writes rolls all of them back, and the next attempt works.
    const fresh = ['atomic2:user', 'atomic2:ontology', 'atomic2:all'].map((id) => ({ id, max: 1 }));
    await expect(
      reserveCounters(fresh, 'atomic', {
        beforeWrite: (i) => {
          if (i === 1) throw new Error('disk full');
        },
      }),
    ).rejects.toThrow('disk full');
    expect(await Promise.all(fresh.map((k) => count(k.id)))).toEqual([0, 0, 0]);
    expect(await reserveCounters(fresh, 'atomic')).toBe(true);
  });

  it('a request that fails before Claude is called gives its allowance back and frees the person', async () => {
    const { config } = await import('../src/config.js');
    const { ontologyStore } = await import('../src/services/ontologyStore.js');
    const { get } = await import('../src/db.js');
    const agent = await login('contributor', 'Refund through the API');
    const me = (await agent.get('/api/session')).body.user.id as string;
    const day = new Date().toISOString().slice(0, 10);
    const used = async () => (await get<{ count: number }>('kv', `query-assistant:${day}:user:${me}`))?.count ?? 0;
    const provider = config.llm.provider;
    const spy = vi.spyOn(ontologyStore, 'at').mockRejectedValueOnce(new Error('the ontology failed to load'));
    try {
      (config.llm as { provider: string }).provider = 'anthropic';
      const body = { messages: [{ role: 'user', content: 'List every organisation' }], query: '', target: 'data', account: me };
      const failed = await agent.post(`/api/ontologies/${demoId}/query-chat`).send(body);
      expect(failed.status).toBe(500);
      expect(await used()).toBe(0);
      // Not stuck as "still answering": the next request is admitted.
      (config.llm as { provider: string }).provider = provider;
      const next = await agent.post(`/api/ontologies/${demoId}/query-chat`).send(body);
      expect(next.status).toBe(200);
    } finally {
      spy.mockRestore();
      (config.llm as { provider: string }).provider = provider;
    }
  });

  it('a call the spending limit refuses gives the chat allowance back', async () => {
    // The allowance was marked spent before the model call, but the deployment's dollar budget can refuse a call
    // before anything is sent to Claude: all three counters stayed taken though no request was made.
    const { config } = await import('../src/config.js');
    const { get } = await import('../src/db.js');
    const agent = await login('contributor', 'Budget refusal');
    const me = (await agent.get('/api/session')).body.user.id as string;
    const day = new Date().toISOString().slice(0, 10);
    const used = async () => (await get<{ count: number }>('kv', `query-assistant:${day}:user:${me}`))?.count ?? 0;
    const provider = config.llm.provider;
    const budget = config.llm.dailyBudgetUsd;
    try {
      (config.llm as { provider: string }).provider = 'anthropic';
      (config.llm as { dailyBudgetUsd: number }).dailyBudgetUsd = 0;
      const r = await agent.post(`/api/ontologies/${demoId}/query-chat`).send({ messages: [{ role: 'user', content: 'List every organisation' }], query: '', target: 'data', account: me });
      expect(r.status).toBe(200);
      expect(r.body.simulated).toBe(true);
      expect(await used()).toBe(0);
    } finally {
      (config.llm as { provider: string }).provider = provider;
      (config.llm as { dailyBudgetUsd: number }).dailyBudgetUsd = budget;
    }
  });

  it('gives allowances back when Claude was never called, and never leaves anyone stuck as busy', async () => {
    const { admitQueryChat } = await import('../src/services/queryChat.js');
    const { config } = await import('../src/config.js');
    const { get, put, transaction, detached, withoutWaiting } = await import('../src/db.js');
    const day = new Date().toISOString().slice(0, 10);
    const used = async (id: string) => (await get<{ count: number }>('kv', `query-assistant:${day}:${id}`))?.count ?? 0;
    const provider = config.llm.provider;
    const limits = { ...config.llm.queryAssistant };
    try {
      (config.llm as { provider: string }).provider = 'anthropic';
      Object.assign(config.llm.queryAssistant, { perUserPerDay: 1, perOntologyPerDay: 1, perDay: 1000 });
      // Something fails before the provider is called: the reservation is refunded, so the last allowance is still there.
      const failed = await admitQueryChat('refund-a', 'ont-refund', true);
      expect(failed.useClaude).toBe(true);
      expect(await used('user:refund-a')).toBe(1);
      await failed.done();
      expect([await used('user:refund-a'), await used('ontology:ont-refund')]).toEqual([0, 0]);
      const second = await admitQueryChat('refund-a', 'ont-refund', true);
      expect(second.useClaude).toBe(true);
      second.spend();
      await second.done();
      expect(await used('user:refund-a')).toBe(1);

      // When admission throws (here: another writer holds the lock), the person isn't left "busy".
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      let holding!: () => void;
      const locked = new Promise<void>((r) => (holding = r));
      const holder = detached(() =>
        transaction(async () => {
          await put('kv', { id: 'refund-lock' });
          holding();
          await held;
        }),
      );
      await locked;
      await expect(withoutWaiting(() => admitQueryChat('refund-b', 'ont-refund-b', true))).rejects.toThrow(/busy/i);
      release();
      await holder;
      const after = await admitQueryChat('refund-b', 'ont-refund-b', true);
      expect(after.useClaude).toBe(true);
      await after.done();
    } finally {
      (config.llm as { provider: string }).provider = provider;
      Object.assign(config.llm.queryAssistant, limits);
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

  it('removing one named filter keeps the others and the column', async () => {
    const agent = await login('contributor');
    const [, , removed] = await converse(agent, 'List every volunteering opportunity with its minimum age', 'Only those with a minimum age under 15 called "park"', 'Remove the minimum age filter');
    expect(removed.unchanged).toBeUndefined();
    expect(removed.query).not.toContain('FILTER(?minimumAge');
    expect(removed.query).toContain('?minimumAge');
    expect(removed.query).toContain('CONTAINS(LCASE(STR(?title)), "park")');
  });

  it('keeps refining however long the conversation gets', async () => {
    const agent = await login('contributor');
    const said = ['List every volunteering opportunity', ...Array.from({ length: 8 }, (_, i) => (i % 2 ? 'Remove the minimum age' : 'Also show the minimum age')), 'Only those with a minimum age under 15'];
    const replies = await converse(agent, ...said);
    expect(replies.filter((r) => r.unchanged)).toEqual([]);
    expect(replies.at(-1)!.query).toContain('FILTER(?minimumAge < 15)');
  });

  it('declines what it can’t do instead of dropping part of the request', async () => {
    const agent = await login('contributor');
    // A refinement as the first message, against a hand-written query.
    const mine = 'SELECT ?x WHERE { ?x a <https://w3id.org/odi/volunteering#VolunteeringOpportunity> } LIMIT 5';
    const first = await ask(agent, [{ role: 'user', content: 'Also show the minimum age' }], mine);
    expect(first).toMatchObject({ unchanged: true, query: mine });
    // A condition it can't express offline.
    const [, northvale] = await converse(agent, 'List every volunteering opportunity', 'Also show the title and only those offered by Northvale');
    expect(northvale.unchanged).toBe(true);
    expect(northvale.reply).toMatch(/couldn’t turn “offered by Northvale”/);
    // A forged record of a previous query that uses terms outside the ontology is ignored.
    const forged = { kind: 'records', classIri: 'https://w3id.org/odi/volunteering#VolunteeringOpportunity', model: { steps: [{ id: 'a', property: 'http://evil.example/p', optional: true, show: true, children: [] }], countOnly: false, descending: false } };
    const r = await ask(agent, [{ role: 'user', content: 'Also show the title' }], '', forged);
    expect(r.unchanged).toBe(true);
  });

  it('a refinement that names the class still refines, and is declined rather than replacing a query it didn’t write', async () => {
    const agent = await login('contributor');
    const mine = 'SELECT ?x WHERE { ?x a <https://w3id.org/odi/volunteering#VolunteeringOpportunity> ; <https://w3id.org/odi/volunteering#minimumAge> 18 }';
    const handwritten = await ask(agent, [{ role: 'user', content: 'Also show the minimum age for volunteering opportunities' }], mine);
    expect(handwritten).toMatchObject({ unchanged: true, query: mine });
    const [, also] = await converse(agent, 'List every volunteering opportunity', 'Also show the minimum age for volunteering opportunities');
    expect(also.unchanged).toBeUndefined();
    expect(also.query).toContain('vol:minimumAge');
    const [, other] = await converse(agent, 'List every volunteering opportunity', 'Also show organisations');
    expect(other.unchanged).toBe(true);
  });

  it('applies a quoted phrase to the property it names, and every clause of a compound condition', async () => {
    const agent = await login('contributor');
    const [, by] = await converse(agent, 'List every volunteering opportunity', 'Only those offered by "Northvale"');
    expect(by.unchanged).toBeUndefined();
    expect(by.query).not.toContain('CONTAINS(LCASE(STR(?title))');
    expect(by.query).toMatch(/vol:offeredBy \?offeredBy\b[^}]*rdfs:label \?offeredBy\w*/);
    expect(by.query).toMatch(/CONTAINS\(LCASE\(STR\(\?offeredBy\w*\)\), "northvale"\)/);
    expect(by.query).not.toMatch(/OPTIONAL \{[^}]*vol:offeredBy/);
    const [, both] = await converse(agent, 'List every volunteering opportunity', 'Only those with minimum age under 15 and offered by "Northvale"');
    expect(both.query).toContain('FILTER(?minimumAge < 15)');
    expect(both.query).toMatch(/"northvale"/);
    // One clause it can't express declines the whole message.
    const [, part] = await converse(agent, 'List every volunteering opportunity', 'Only those with minimum age under 15 and offered by Northvale');
    expect(part.unchanged).toBe(true);
    expect(part.query).not.toContain('minimumAge < 15');
    // Two conditions on one property used to overwrite each other, and stray words used to be ignored.
    for (const message of [
      'Only those with minimum age over 10 and minimum age under 15',
      'Only those called "Park" and called "Garden"',
      'Only those with minimum age under 15 offered by Northvale',
      'Only those with minimum age under 15 in London',
    ]) {
      const [list, r] = await converse(agent, 'List every volunteering opportunity with its minimum age', message);
      expect(r.unchanged, message).toBe(true);
      expect(r.query, message).toBe(list.query);
    }
  });

  it('keeps a condition from an earlier message unless told to replace it', async () => {
    const agent = await login('contributor');
    // The second condition used to silently replace the first.
    const [, over, under] = await converse(agent, 'List every volunteering opportunity with its minimum age', 'Only those with minimum age over 10', 'Also only those with minimum age under 15');
    expect(under.unchanged).toBe(true);
    expect(under.query).toBe(over.query);
    expect(under.reply).toContain('already a condition on minimum age (over 10)');
    const [, park, garden] = await converse(agent, 'List every volunteering opportunity', 'Only those called "Park"', 'Also only those called "Garden"');
    expect(garden.unchanged).toBe(true);
    expect(garden.query).toBe(park.query);
    // "Now also" adds; it used to count as permission to replace.
    for (const [first, second] of [
      ['Only those with minimum age under 15', 'Now also only those with minimum age over 10'],
      ['Only those called "Park"', 'Now also only those called "Garden"'],
      ['Only those with minimum age under 15', 'Now only those with minimum age over 10'],
      ['Only those with minimum age under 15', 'Also only those with minimum age over 10 instead'],
    ]) {
      const [, before, after] = await converse(agent, 'List every volunteering opportunity with its minimum age', first, second);
      expect(after.unchanged, second).toBe(true);
      expect(after.query, second).toBe(before.query);
    }
    // Saying so replaces it.
    const [, , instead] = await converse(agent, 'List every volunteering opportunity with its minimum age', 'Only those with minimum age over 10', 'Only those with minimum age under 15 instead');
    expect(instead.query).toContain('FILTER(?minimumAge < 15)');
    expect(instead.query).not.toContain('?minimumAge > 10');
    // A condition on another property adds to it.
    const [, , both] = await converse(agent, 'List every volunteering opportunity with its minimum age', 'Only those with minimum age over 10', 'Also only those called "Park"');
    expect(both.query).toContain('FILTER(?minimumAge > 10)');
    expect(both.query).toContain('"park"');
  });

  it('treats quoted words as values, never as instructions', async () => {
    const agent = await login('contributor');
    // "count" used to turn the list into a count, and "all rows" used to lift the limit.
    const [, count] = await converse(agent, 'List every volunteering opportunity', 'Only those called "count"');
    expect(count.query).not.toContain('COUNT(');
    expect(count.query).toContain('"count"');
    const [, rows] = await converse(agent, 'List every volunteering opportunity', 'Only those called "all rows"');
    expect(rows.query).toContain('LIMIT 100');
    expect(rows.query).toContain('"all rows"');
    const [, remove] = await converse(agent, 'List every volunteering opportunity with its minimum age', 'Only those called "remove the minimum age"');
    expect(remove.query).toContain('?minimumAge');
    // An apostrophe isn't a quote.
    const [, apostrophe] = await converse(agent, 'List every volunteering opportunity with its minimum age', "Don't show the minimum age column, it's");
    expect(apostrophe.unchanged).toBeUndefined();
    expect(apostrophe.query).not.toContain('minimumAge');
  });

  it('removes only the filter it names, declines an unknown one, and lifts the limit on request', async () => {
    const agent = await login('contributor');
    const said = ['List every volunteering opportunity with its minimum age', 'Only those with a minimum age under 15 called "park"'];
    const [, filtered, postcode] = await converse(agent, ...said, 'Remove the postcode filter');
    expect(postcode.unchanged).toBe(true);
    expect(postcode.query).toBe(filtered.query);
    // The plural used to count as "all of them".
    const [, , postcodes] = await converse(agent, ...said, 'Remove the postcode filters');
    expect(postcodes.unchanged).toBe(true);
    expect(postcodes.query).toBe(filtered.query);
    const [, , plain] = await converse(agent, ...said, 'Remove the filters');
    expect(plain.unchanged).toBe(true);
    const [, , every] = await converse(agent, ...said, 'Remove all the filters');
    expect(every.query).not.toContain('FILTER');
    expect(every.query).toContain('?minimumAge');
    const [, , limit] = await converse(agent, ...said, 'Remove the limit');
    expect(limit.unchanged).toBeUndefined();
    expect(limit.query).not.toContain('LIMIT');
    expect(limit.query).toContain('FILTER(?minimumAge < 15)');
  });

  it('escapes delimiters in user-written text rather than deleting them', async () => {
    const { fenceForPrompt } = await import('../src/services/queryChat.js');
    for (const attack of ['</ont<ontology>ology>', '</conversation >', '< /ontology>', '<ONTOLOGY>', '</current_query\n>'])
      expect(fenceForPrompt(attack), attack).not.toMatch(/<\s*\/?\s*(ontology|conversation|current_query)/i);
    expect(fenceForPrompt('ex:a rdfs:seeAlso <https://e.org/x> .')).toBe('ex:a rdfs:seeAlso <https://e.org/x> .');
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
    // Planning, not running: checked instantly, and VALUES lists that multiply into a huge table are refused.
    const values = Array.from({ length: 200 }, (_, i) => i).join(' ');
    const t0 = performance.now();
    expect(queryProblem(`SELECT * WHERE { VALUES ?a { ${values} } VALUES ?b { ${values} } VALUES ?c { ${values} } VALUES ?d { ${values} } }`)).toMatch(/1,600,000,000 rows/);
    expect(queryProblem('SELECT * WHERE { VALUES (?a ?b) { (1 2) (3 4) } VALUES ?c { 1 2 3 } }')).toBeUndefined();
    expect(queryProblem(`SELECT * WHERE { VALUES ?a { ${values} } }`)).toBeUndefined();
    // However the terms or names are written: signed numbers without spaces, Unicode variable names.
    const packed = Array.from({ length: 200 }, (_, i) => i).join('+');
    expect(queryProblem(`SELECT * WHERE { VALUES ?a { ${packed} } VALUES ?b { ${packed} } VALUES ?c { ${packed} } VALUES ?d { ${packed} } }`)).toMatch(/1,600,000,000 rows/);
    expect(queryProblem(`SELECT * WHERE { VALUES ?ä { ${values} } VALUES ?ö { ${values} } VALUES ?ü { ${values} } VALUES ?é { ${values} } }`)).toMatch(/1,600,000,000 rows/);
    expect(queryProblem(`SELECT * WHERE { ?s ?p ?o } VALUES ?a { ${values} }`)).toBeUndefined();
    expect(performance.now() - t0).toBeLessThan(1000);
    // A comment ended by a carriage return can't hide what follows it.
    expect(queryProblem('SELECT * WHERE { # note\r SERVICE SILENT <http://example.org/sparql> { ?s ?p ?o } }')).toMatch(/SERVICE/);
    expect(queryProblem('SELECT * # note\rFROM <http://example.org/g> WHERE { ?s ?p ?o }')).toMatch(/FROM/);
    expect(queryProblem('SELECT * WHERE { { SELECT * FROM NAMED <http://example.org/g> WHERE { ?s ?p ?o } } }')).toMatch(/doesn’t parse|FROM/);
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
  it('keeps interviews, meetings, change requests, releases and feedback behind sign-in, and shows signed-out visitors only public use cases', async () => {
    const agent = await login('contributor', 'Private author');
    const uc = await agent.post(`/api/ontologies/${demoId}/interviews`).send({});
    expect(uc.status).toBe(201);
    const useCaseId = uc.body.useCaseId ?? uc.body.session?.useCaseId;
    const ucs = (await agent.get(`/api/ontologies/${demoId}/use-cases`)).body as { id: string }[];
    const cr = (await agent.get(`/api/ontologies/${demoId}/change-requests`)).body[0] as { id: string };
    const rel = (await agent.get(`/api/ontologies/${demoId}/releases`)).body[0] as { id: string };
    const meetings = (await agent.get(`/api/ontologies/${demoId}/meetings`)).body as { id: string }[];
    // Use case reads are open, but check what each viewer may see: signed out, only public ones.
    const anonList = await request(app).get(`/api/ontologies/${demoId}/use-cases`);
    expect(anonList.status).toBe(200);
    expect((anonList.body as { visibility: string }[]).every((u) => u.visibility === 'public')).toBe(true);
    expect(JSON.stringify(anonList.body)).not.toContain('Private author');
    expect((await request(app).get(`/api/use-cases/${useCaseId ?? ucs[0].id}`)).status).toBe(404);
    const paths = [
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

describe('release approval provenance', () => {
  const release = (over: Partial<Release>): Release => ({
    id: 'rel_test',
    ontologyId: demoId,
    version: '9.9.9',
    level: 'minor',
    status: 'draft',
    changeRequestIds: ['cr_test'],
    notes: '',
    versionIRI: 'https://example.org/9.9.9',
    createdBy: 'system',
    createdAt: '2026-11-01T00:00:00Z',
    statusSince: '2026-11-01T00:00:00Z',
    ...over,
  });

  it('labels every decided release, rejected as well as published', async () => {
    expect((await releaseApproval(release({ status: 'voting' }))).approvalSource).toBe('live');
    expect((await releaseApproval(release({ status: 'rejected' }))).approvalSource).toBe('current-policy');
    expect((await releaseApproval(release({ status: 'published' }))).approvalSource).toBe('current-policy');
    expect((await releaseApproval(release({ status: 'published', changeRequestIds: [] }))).approvalSource).toBe('bootstrap');
    const saved = { ...(await releaseGovernance(release({ status: 'voting' }))), requiredApprovals: 42 };
    for (const status of ['published', 'rejected'] as const) {
      const shown = await releaseApproval(release({ status, approval: saved }));
      expect(shown.approvalSource).toBe('recorded');
      expect(shown.governance.requiredApprovals).toBe(42);
    }
  });

  it('re-evaluates an unrecorded decision with only the votes cast before it, each person’s last vote counting', async () => {
    const decidedAt = '2026-11-02T12:00:00Z';
    const probe = await releaseGovernance(release({ id: 'rel_votes', level: 'major', status: 'voting' }));
    const voterRoles = probe.rule.vote?.voterRoles ?? [];
    expect(voterRoles.length, 'the demo policy votes on major releases').toBeGreaterThan(0);
    const voters = (await members(demoId)).filter((m) => m.roles.some((r) => voterRoles.includes(r)));
    expect(voters.length).toBeGreaterThanOrEqual(2);
    const [a, b] = voters;
    const vote = (id: string, userId: string, choice: Vote['choice'], at: string): Vote => ({ id, subjectType: 'release', subjectId: 'rel_votes', userId, roles: ['member'], choice, at });
    // a changes their mind before the decision (no, then yes); b only votes after it.
    for (const v of [vote('v_a1', a.userId, 'no', '2026-11-01T09:00:00Z'), vote('v_a2', a.userId, 'yes', '2026-11-02T09:00:00Z'), vote('v_b', b.userId, 'no', '2026-11-03T09:00:00Z')])
      await put('votes', v, 'rel_votes');
    for (const status of ['published', 'rejected'] as const) {
      const { governance, approvalSource } = await releaseApproval(release({ id: 'rel_votes', level: 'major', status, publishedAt: status === 'published' ? decidedAt : undefined, statusSince: decidedAt }));
      expect(approvalSource).toBe('current-policy');
      expect(governance.vote).toMatchObject({ cast: 1, yes: 1, no: 0 });
    }
  });

  it('records the approval that allowed publishing, even if the policy changes while the release is written', async () => {
    // The snapshot used to be a second evaluation taken after the check that let the release through, so a policy
    // change in between was recorded as if it had applied (and might not even say "approved"). The last check runs
    // just before the files are written; a change while they're written must not reach the record.
    const project = await getProject(demoId);
    const original = structuredClone(project.governance);
    const now = new Date().toISOString();
    const r: Release = {
      id: 'rel_snapshot', ontologyId: demoId, version: '1.1.1', level: 'patch', status: 'draft', changeRequestIds: [],
      notes: 'Snapshot test', versionIRI: `${project.ontologyIRI}/1.1.1`, createdBy: 'system', createdAt: now, statusSince: now,
    };
    await put('releases', r, demoId);
    const before = await releaseGovernance(r);
    // Between the first check and the last one (while the files are built), the policy changes once: the last
    // check sees that, and it's what is recorded.
    // (The release reads the draft at the commit it captured, with graphAt.)
    const graphAt = ontologyStore.graphAt.bind(ontologyStore);
    const between = vi.spyOn(ontologyStore, 'graphAt').mockImplementationOnce(async (p, ref) => {
      const changed = await getProject(demoId);
      changed.governance.releases.patch.minApprovals = before.requiredApprovals + 2;
      changed.governance.releases.patch.reviewPeriodDays = 33;
      await updateProject(changed);
      return graphAt(p, ref);
    });
    const write = ontologyStore.writeRelease.bind(ontologyStore);
    const spy = vi.spyOn(ontologyStore, 'writeRelease').mockImplementationOnce(async (...args: Parameters<typeof write>) => {
      const changed = await getProject(demoId);
      changed.governance.releases.patch.minApprovals = before.requiredApprovals + 5;
      changed.governance.releases.patch.reviewPeriodDays = 77;
      await updateProject(changed);
      return write(...args);
    });
    try {
      const published = await publishRelease(r, undefined);
      expect(between).toHaveBeenCalled();
      expect(spy).toHaveBeenCalled();
      expect(published.approval?.requiredApprovals).toBe(before.requiredApprovals + 2);
      expect(published.approval?.rule.reviewPeriodDays).toBe(33);
      expect((await releaseApproval(published)).approvalSource).toBe('recorded');
    } finally {
      between.mockRestore();
      spy.mockRestore();
      const restored = await getProject(demoId);
      restored.governance = original;
      await updateProject(restored);
    }
  });
});
