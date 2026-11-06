import request from 'supertest';
import { config as storeConfig } from '../src/config.js';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { openDb, put } from '../src/db.js';
import { getCR } from '../src/services/changeRequests.js';
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

/**
 * Approve a request for real, as its policy asks: approvals from people holding an approver role (not
 * its writers) in its current round, its review period over, and, if the rule needs a vote, a "yes"
 * from every eligible member. Then it is stored as approved, as advance() would. `as` records a level
 * it was approved as, for tests where the request has since grown.
 */
async function approveForReal(id: string, { as, confirmation = false }: { as?: 'patch' | 'minor' | 'major'; confirmation?: boolean } = {}) {
  const crsMod = await import('../src/services/changeRequests.js');
  const { put } = await import('../src/db.js');
  const { newId } = await import('../src/ids.js');
  const { members } = await import('../src/services/ontologies.js');
  const { getUser } = await import('../src/services/users.js');
  const { effectiveRule } = await import('../src/services/governance.js');
  const { getProject } = await import('../src/services/ontologies.js');
  const cr = await getCR(id);
  // The rule of the level it is approved as.
  const rule = as ? effectiveRule((await getProject(cr.ontologyId)).governance, as, 'change') : (await crsMod.governanceFor(cr)).rule;
  const role = rule.approverRoles[0];
  let seq = cr.decisionSeq ?? 0;
  for (let i = 0; i < rule.minApprovals; i++) {
    const agent = await login(role, `Approver ${i + 1} of #${cr.number}`);
    const user = (await getUser((await agent.get('/api/session')).body.user.id))!;
    await put('reviews', { id: newId('rev'), changeRequestId: id, userId: user.id, roles: [role], decision: 'approve', at: '2000-01-02T00:00:00Z', round: cr.round ?? 1, seq: ++seq }, id);
  }
  if (rule.vote)
    for (const m of (await members(cr.ontologyId)).filter((x) => x.roles.some((r) => rule.vote!.voterRoles.includes(r))))
      await put('votes', { id: newId('vote'), subjectType: 'change-request', subjectId: id, userId: m.userId, roles: m.roles, choice: 'yes', at: '2000-01-03T00:00:00Z', round: cr.round ?? 1, editsVersion: cr.editsVersion ?? 1, seq: ++seq }, id);
  const latest = await getCR(id);
  await put(
    'changeRequests',
    { ...latest, decisionSeq: seq, status: 'approved', reviewStartedAt: '2000-01-01T00:00:00Z', approvedAs: { level: as ?? latest.classification?.level ?? 'minor', confirmation, voted: !!rule.vote } },
    latest.ontologyId,
  );
}

/** The review round a decision has to name: the round of the version being decided on (read from the store). */
async function roundOf(_agent: Agent, id: string): Promise<number> {
  return (await getCR(id)).round ?? 1;
}

let demoId: string;

let dataDir: string;
/**
 * A write made straight to the database file, as another process would make it: synchronously, so a test can make
 * it from inside a stubbed synchronous call (clock.iso, Date.now), at an exact point in the code under test.
 */
function writeElsewhere(sql: string, ...params: (string | number)[]) {
  const db = new DatabaseSync(path.join(dataDir, 'concord.sqlite'));
  try {
    db.prepare(sql).run(...params);
  } finally {
    db.close();
  }
}
/** Bumps a change request's revision from "another process". */
const bumpRevElsewhere = (id: string) =>
  writeElsewhere(`UPDATE docs SET data = json_set(data, '$.rev', coalesce(json_extract(data, '$.rev'), 0) + 1) WHERE collection = 'changeRequests' AND id = ?`, id);
/** Writes a kv document from "another process". */
const putKvElsewhere = (doc: { id: string; [key: string]: unknown }) =>
  writeElsewhere(
    `INSERT INTO docs (collection, id, parent, data, created_at) VALUES ('kv', ?, NULL, ?, ?) ON CONFLICT(collection, id) DO UPDATE SET data = excluded.data`,
    doc.id,
    JSON.stringify(doc),
    new Date().toISOString(),
  );

beforeAll(async () => {
  dataDir = (await import('../src/config.js')).config.dataDir;
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
    await reviewer.post(`/api/change-requests/${id}/reviews`).send({ round: await roundOf(reviewer, id), decision: 'approve', comment: 'Fine' });
    const approved2 = await steward.post(`/api/change-requests/${id}/reviews`).send({ round: await roundOf(steward, id), decision: 'approve' });
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
    // Claude showed a generic plug for the connector: the server sent no icon. It now names
    // Concord's plane, and every icon it names is a file the web app serves.
    const info = parse(init).result.serverInfo;
    expect(info).toMatchObject({ name: 'concord', title: 'Concord' });
    expect(info.icons.map((i: { mimeType: string }) => i.mimeType)).toEqual(['image/png', 'image/png', 'image/svg+xml']);
    for (const icon of info.icons as { src: string }[]) {
      expect(icon.src.startsWith(`${storeConfig.webUrl}/`), icon.src).toBe(true);
      expect(fs.existsSync(path.join(storeConfig.webDist, '..', 'public', new URL(icon.src).pathname)), icon.src).toBe(true);
    }
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
    const approved = await editor.post(`/api/change-requests/${res.body.id}/reviews`).send({ round: await roundOf(editor, res.body.id), decision: 'approve' });
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
    await editor.post(`/api/change-requests/${first.body.id}/reviews`).send({ round: await roundOf(editor, first.body.id), decision: 'approve' });
    await editor.post(`/api/change-requests/${second.body.id}/reviews`).send({ round: await roundOf(editor, second.body.id), decision: 'approve' });
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
      await editor.post(`/api/change-requests/${id}/reviews`).send({ round: await roundOf(editor, id), decision: 'approve' });
      await put('changeRequests', { ...await crsMod.getCR(id), status: 'approved', reviewStartedAt: '2000-01-01T00:00:00Z' }, demoId);
    }
    const results = await Promise.all([crsMod.merge(await crsMod.getCR(one.body.id), undefined), crsMod.merge(await crsMod.getCR(two.body.id), undefined)]);
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
    const snapshot = await crsMod.getCR(created.body.id); // what a slow re-triage started from
    expect((await contributor.post(`/api/change-requests/${created.body.id}/withdraw`)).status).toBe(200);
    const after = await crsMod.triage(snapshot);
    expect(after.status).toBe('withdrawn');
    expect((await crsMod.getCR(created.body.id)).status).toBe('withdrawn');
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
    const own = await rewriter.post(`/api/change-requests/${id}/reviews`).send({ round: await roundOf(rewriter, id), decision: 'approve' });
    expect(own.body.governance.approvals).toBe(0);
    const independent = await other.post(`/api/change-requests/${id}/reviews`).send({ round: await roundOf(other, id), decision: 'approve' });
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
    await (await login('steward', 'Steward Stale')).post(`/api/change-requests/${reworded.body.id}/reviews`).send({ round: 1, decision: 'approve' });
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
    await steward.post(`/api/change-requests/${created.body.id}/reviews`).send({ round: await roundOf(steward, created.body.id), decision: 'approve' });
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
    await editor.post(`/api/change-requests/${created.body.id}/reviews`).send({ round: await roundOf(editor, created.body.id), decision: 'approve' });
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
    return (await getUser((await agent.get('/api/session')).body.user.id))!;
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
        expect((await get<{ expiresAt: number }>('kv', key))!.expiresAt).toBeGreaterThan(Date.now());
        await assertStillHeld({ id: demoId });
      });
      expect((await get('kv', key))).toBeUndefined();

      // Another process's live lease: we wait, then give up, without touching it.
      await put('kv', { id: key, token: 'another-process', pid: 0, expiresAt: Date.now() + 60_000 });
      await expect(withWorkingDraftLock({ id: demoId }, async () => 'got it')).rejects.toMatchObject({ status: 503 });
      expect((await get('kv', key))).toMatchObject({ token: 'another-process' });
      await remove('kv', key);

      // A holder that stalled past its lease and was taken over can no longer write, and leaves its successor's lease alone.
      const contributor = await login('contributor', 'Contributor Stalled');
      const created = await edit(contributor, { termIri: SKILL, set: { examples: ['stalled'] }, submit: true });
      const user = await userOf(contributor);
      await expect(
        withWorkingDraftLock({ id: demoId }, async () => {
          await put('kv', { id: key, token: 'successor', pid: 0, expiresAt: Date.now() + 60_000 });
          return crsMod.withdraw(await crsMod.getCR(created.body.id), user);
        }),
      ).rejects.toMatchObject({ status: 503 });
      expect((await crsMod.getCR(created.body.id)).status).toBe('review');
      expect((await get('kv', key))).toMatchObject({ token: 'successor' });
      await remove('kv', key);
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
      expect((await crsMod.getCR(first.body.id)).status).toBe('withdrawn');

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
      const stored = await crsMod.getCR(second.body.id);
      expect(stored.ops).toEqual(theirs);
      expect(stored.revisedBy).toContain((await userOf(editorB)).id);
      expect((await editorB.post(`/api/change-requests/${second.body.id}/reviews`).send({ round: await roundOf(editorB, second.body.id), decision: 'approve' })).body.governance.approvals).toBe(0);
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
    await approveForReal(created.body.id);

    const held = gate();
    const original = ontologyStore.working;
    let calls = 0;
    const spy = vi.spyOn(ontologyStore, 'working').mockImplementation(async (p) => {
      if (calls++ === 0) await held.p; // the merge's own re-check is slow
      return original.call(ontologyStore, p);
    });
    try {
      const merging = crsMod.merge(await crsMod.getCR(created.body.id), await userOf(editor));
      await vi.waitFor(() => expect(calls).toBeGreaterThan(0));
      const patching = crsMod
        .updateOps(await crsMod.getCR(created.body.id), await userOf(author), { ops: [{ op: 'updateAnnotations', iri: LOC, set: { definition: 'Unreviewed definition.' } }] })
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
    await put('changeRequests', { ...await crsMod.getCR(voted.body.id), status: 'approved', approvedAs: { level: 'major', confirmation: true, voted: true } }, demoId);
    const merged = await crsMod.merge(await crsMod.getCR(voted.body.id), stewardUser);
    expect(merged.status).toBe('merged');
    expect((await contributor.get(termPath(ORG))).body.definition).toBe('A scheduled period of volunteering, possibly repeating.');

    // Approved as a patch, but a major change on today's draft: back to review, nothing merged.
    const now = (await contributor.get(termPath(ORG))).body.definition;
    const grew = await edit(contributor, { termIri: ORG, set: { definition: 'An employment shift.' }, previous: { definition: now }, definitionIntent: 'new-meaning' });
    await approveForReal(grew.body.id, { as: 'patch' });
    const back = await crsMod.merge(await crsMod.getCR(grew.body.id), stewardUser);
    expect(back.status).not.toBe('merged');
    expect(back.status).not.toBe('approved');
    // Approved by the patch rule, it no longer holds under the major rule: a vote opens, or it goes back to review.
    expect(JSON.stringify(back.timeline)).toMatch(/vote opened|back in review/);
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
      await approveForReal(one.body.id);
      // A manual merge re-validates the change, so it needs budget too.
      expect((await editor.post(`/api/change-requests/${one.body.id}/merge`)).status).toBe(429);
      expect((await crsMod.getCR(one.body.id)).status).toBe('approved');

      // An approval that would trigger an automatic merge: recorded, and the merge waits for the approver's budget.
      const LOC = `${VOL}Location`;
      const two = await edit(b, { termIri: LOC, set: { examples: ['a village hall'] }, submit: true });
      await editor.post('/api/simulation/clock').send({ advanceDays: 2 });
      expect((await crsMod.getCR(one.body.id)).status).toBe('merged');
      spy.mockClear();
      const approved = await editor.post(`/api/change-requests/${two.body.id}/reviews`).send({ round: await roundOf(editor, two.body.id), decision: 'approve' });
      expect(approved.status).toBe(200);
      expect(approved.body.status).toBe('approved');
      expect(approved.body.autoMergeBy).toBe((await userOf(editor)).id);
      await editor.post('/api/simulation/clock').send({ advanceDays: 0.01 });
      expect((await crsMod.getCR(two.body.id)).status).toBe('approved');
      // Once they have budget again, the governance clock merges it, on their budget.
      triageBudget.max = 2;
      await editor.post('/api/simulation/clock').send({ advanceDays: 0.01 });
      expect((await crsMod.getCR(two.body.id)).status).toBe('merged');
      expect((await crsMod.getCR(two.body.id)).autoMergeBy).toBeUndefined();
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
    const approve = async (r: { body: { id: string; classification: { level: 'patch' | 'minor' | 'major' } } }) =>
      await approveForReal(r.body.id);
    const helper = await create('Add helper', [{ op: 'addClass', localName: 'Helper', label: 'helper', definition: 'An agent that helps out with a volunteering opportunity.', subClassOf: [`${VOL}Agent`] }]);
    await approve(helper);
    expect((await crsMod.merge(await crsMod.getCR(helper.body.id), steward)).status).toBe('merged');
    // Each passes on its own; together Helper would be unsatisfiable.
    const sub = await create('Helpers are people', [{ op: 'setSuperClasses', iri: HELPER, superClasses: [PERSON] }]);
    const disjoint = await create('Helpers are not people', [{ op: 'addDisjointness', classes: [HELPER, PERSON] }]);
    expect(sub.body.validation.passed).toBe(true);
    expect(disjoint.body.validation.passed).toBe(true);
    await approve(sub);
    await approve(disjoint);
    const { ontologyStore } = await import('../src/services/ontologyStore.js');
    const { getProject } = await import('../src/services/ontologies.js');
    const head = async () => await ontologyStore.head((await getProject(demoId)));
    expect((await crsMod.merge(await crsMod.getCR(sub.body.id), steward)).status).toBe('merged');
    const before = await head();
    const second = await crsMod.merge(await crsMod.getCR(disjoint.body.id), steward);
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
    await put('changeRequests', { ...await crsMod.getCR(created.body.id), status: 'approved', approvedAs: { level: 'patch', confirmation: false } }, demoId);
    const blocked = await editor.post(`/api/change-requests/${created.body.id}/reviews`).send({ round: await roundOf(editor, created.body.id), decision: 'request-changes', comment: 'Not yet.' });
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
    const legacy = { ...await crsMod.getCR(created.body.id), status: 'approved' as const };
    delete legacy.approvedAs;
    await put('changeRequests', legacy, demoId);
    const result = await crsMod.merge(await crsMod.getCR(created.body.id), await userOf(await login('steward', 'Steward Legacy')));
    expect(result.status).not.toBe('merged');
    expect((await contributor.get(termPath(TC))).body.definition).toBe(current);
  });

  it('never moves the working draft from a stale base', async () => {
    const { ontologyStore } = await import('../src/services/ontologyStore.js');
    const { getProject } = await import('../src/services/ontologies.js');
    const project = (await getProject(demoId));
    const { graph, head } = await ontologyStore.workingAt(project);
    const stale = (await ontologyStore.log(project, 2))[1].sha;
    await expect(ontologyStore.commitWorking(project, graph, 'stale writer', { name: 'Stale' }, stale)).rejects.toMatchObject({ status: 409 });
    // Even a no-op against the stale base is refused, rather than reported as committed.
    const staleGraph = await ontologyStore.at(project, 'working').then(() => import('@concord/core')).then(async ({ OntologyGraph }) => OntologyGraph.fromTurtle(await ontologyStore.readWorkingText(project, stale)));
    await expect(ontologyStore.commitWorking(project, staleGraph, 'stale no-op', { name: 'Stale' }, stale)).rejects.toMatchObject({ status: 409 });
    await expect(ontologyStore.writeRelease(project, '9.9.9', graph, {}, 'stale release', { name: 'Stale' }, stale)).rejects.toMatchObject({ status: 409 });
    expect(await ontologyStore.head(project)).toBe(head);
    expect(await ontologyStore.versions(project)).not.toContain('9.9.9');
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
    const meddle: Record<string, (id: string) => Promise<unknown>> = {
      withdraw: async (id) => (await put('changeRequests', { ...await crsMod.getCR(id), status: 'withdrawn', rev: ((await crsMod.getCR(id)).rev ?? 0) + 1 }, demoId)),
      'request changes': async (id) => {
        await put('reviews', { id: newId('rev'), changeRequestId: id, userId: editorId, roles: ['editor'], decision: 'request-changes', at: new Date().toISOString() }, id);
        await put('changeRequests', { ...await crsMod.getCR(id), rev: ((await crsMod.getCR(id)).rev ?? 0) + 1 }, demoId);
      },
      patch: async (id) => (await put('changeRequests', { ...await crsMod.getCR(id), ops: [{ op: 'updateAnnotations', iri: SKILL, set: { comment: 'Unreviewed.' } }], rev: ((await crsMod.getCR(id)).rev ?? 0) + 1 }, demoId)),
    };
    for (const [what, fn] of Object.entries(meddle)) {
      const created = await edit(contributor, { termIri: `${VOL}Role`, set: { examples: [`fenced ${what}`] }, submit: true });
      await approveForReal(created.body.id);
      const head = await ontologyStore.head((await getProject(demoId)));
      const original = ontologyStore.commitWorking;
      const spy = vi.spyOn(ontologyStore, 'commitWorking').mockImplementation(async function (this: typeof ontologyStore, ...args) {
        await fn(created.body.id); // lands just before the merge's commit
        return original.apply(ontologyStore, args);
      });
      try {
        await expect(crsMod.merge(await crsMod.getCR(created.body.id), steward), what).rejects.toMatchObject({ status: 409 });
      } finally {
        spy.mockRestore();
      }
      expect(await ontologyStore.head((await getProject(demoId))), what).toBe(head);
      expect((await crsMod.getCR(created.body.id)).status, what).not.toBe('merged');
    }
  });

  it('does not commit when the merge-time checks could not run', async () => {
    const crsMod = await import('../src/services/changeRequests.js');
    const { ontologyStore } = await import('../src/services/ontologyStore.js');
    const { getProject } = await import('../src/services/ontologies.js');
    const { put } = await import('../src/db.js');
    const contributor = await login('contributor', 'Contributor Flaky');
    const created = await edit(contributor, { termIri: `${VOL}Role`, set: { comment: 'Checked or not at all.' }, submit: true });
    await approveForReal(created.body.id);
    const head = await ontologyStore.head((await getProject(demoId)));
    const spy = vi.spyOn(ontologyStore, 'working').mockRejectedValueOnce(new Error('transient read failure'));
    try {
      const result = await crsMod.merge(await crsMod.getCR(created.body.id), await userOf(await login('steward', 'Steward Flaky')));
      expect(result.status).not.toBe('merged');
    } finally {
      spy.mockRestore();
    }
    expect(await ontologyStore.head((await getProject(demoId)))).toBe(head);
  });

  it('sends an approved request to a vote when a late objection asks for one', async () => {
    const crsMod = await import('../src/services/changeRequests.js');
    const { getProject, updateProject } = await import('../src/services/ontologies.js');
    const { GOVERNANCE_TEMPLATES } = await import('../src/services/governance.js');
    const { put } = await import('../src/db.js');
    const project = (await getProject(demoId));
    const saved = project.governance;
    await updateProject({ ...project, governance: GOVERNANCE_TEMPLATES['lazy-consensus'] });
    try {
      const contributor = await login('contributor', 'Contributor Objected');
      const editor = await login('editor', 'Editor Objector');
      const created = await edit(contributor, { termIri: `${VOL}Role`, set: { editorialNote: 'Objected to later.' } });
      await put('changeRequests', { ...await crsMod.getCR(created.body.id), status: 'approved', reviewStartedAt: '2000-01-01T00:00:00Z', approvedAs: { level: 'patch', confirmation: false } }, demoId);
      const objected = await editor.post(`/api/change-requests/${created.body.id}/reviews`).send({ round: await roundOf(editor, created.body.id), decision: 'object', comment: 'Let us vote on it.' });
      expect(objected.body.status).toBe('voting');
      expect((await editor.post(`/api/change-requests/${created.body.id}/merge`)).status).toBe(409);
      // A request already approved by a vote is not sent to another one by the same rule.
      const voted = await edit(contributor, { termIri: `${VOL}Role`, set: { comment: 'Voted through.' } });
      await put('changeRequests', { ...await crsMod.getCR(voted.body.id), status: 'approved', reviewStartedAt: '2000-01-01T00:00:00Z', approvedAs: { level: 'patch', confirmation: false, voted: true } }, demoId);
      await editor.post(`/api/change-requests/${voted.body.id}/reviews`).send({ round: await roundOf(editor, voted.body.id), decision: 'object' });
      expect((await crsMod.getCR(voted.body.id)).status).not.toBe('voting');
    } finally {
      await updateProject({ ...(await getProject(demoId)), governance: saved });
    }
  });

  it('publishes a release from the draft as it is once nothing else is changing it, so a merge just before is kept', async () => {
    const crsMod = await import('../src/services/changeRequests.js');
    const releases = await import('../src/services/releases.js');
    const { put, list } = await import('../src/db.js');
    const steward = await login('steward', 'Steward Release');
    const stewardUser = await userOf(steward);
    const contributor = await login('contributor', 'Contributor Release');
    const created = await edit(contributor, { termIri: `${VOL}Agent`, set: { comment: 'Merged while the release waited.' } });
    await approveForReal(created.body.id);
    await steward.post(`/api/ontologies/${demoId}/releases`).send({});
    const pending = (await list<{ id: string; status: string; ontologyId: string }>('releases', demoId)).find((r) => r.status === 'draft' || r.status === 'voting')!;
    // Treated as ready to publish (its vote, if it needs one, is beside the point here).
    const draft = (await put('releases', { ...pending, status: 'draft' }, demoId));

    // A merge is under way (holding the ontology's locks, consent then working draft, as a merge does) when the release is asked for.
    let finish!: () => void;
    const finishing = new Promise<void>((resolve) => (finish = resolve));
    let started!: () => void;
    const inside = new Promise<void>((resolve) => (started = resolve));
    const merging = crsMod.withOntologyLocks(demoId, async () => {
      started();
      await finishing;
      return crsMod.merge(await crsMod.getCR(created.body.id), stewardUser);
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
  // With ONTOLOGY_STORE=db there is no repository to fall out of line: the tests of the git-backed store's own
  // machinery (pins, syncs, the claim on the repositories) run only on it, and the others skip their git checks.
  const onGit = storeConfig.ontologyStore === 'git';
  const gitOnly = it.runIf(onGit);
  const repo = async () => {
    const { gitStore: ontologyStore, ontologyStore: store } = await import('../src/services/ontologyStore.js');
    const { getProject } = await import('../src/services/ontologies.js');
    const { execFileSync } = await import('node:child_process');
    const path = await import('node:path');
    const fs = await import('node:fs');
    const { config } = await import('../src/config.js');
    const project = (await getProject(demoId));
    // The repository as it is on disk, without the repair that reads through ontologyStore do first.
    const raw = path.join(config.dataDir, 'ontologies', project.slug);
    // CI runners have no git identity, so commits made here name one (as the store does).
    const identity = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@localhost', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@localhost' };
    const rawGit = (...args: string[]) => execFileSync('git', args, { cwd: raw, encoding: 'utf8', env: { ...process.env, ...identity } }).trim();
    const rawFile = (name: string) => fs.readFileSync(path.join(raw, name), 'utf8');
    // `ontologyStore` is the git-backed store (for the tests of its machinery); `store` is the one in use.
    return { ontologyStore, store, project, rawGit, rawFile, raw };
  };
  const approvedEdit = async (who: string, iri: string, set: object) => {
    const crsMod = await import('../src/services/changeRequests.js');
    const { put } = await import('../src/db.js');
    const created = await edit(await login('contributor', who), { termIri: iri, set, submit: true });
    await approveForReal(created.body.id);
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
    await remove('kv', `working-draft-lock:${demoId}`);
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
  /**
   * A writer in another process (see writerProcess.ts): `advance <label>` commits a draft with one more
   * triple, `prune` cleans up pins. With `at`, it is killed, or paused until resume(), at that point.
   * Always stop() it in a finally block.
   */
  const writerProcess = async (args: string[], opts: { at?: 'pin' | 'draft-read'; then?: 'kill' | 'pause' } = {}) => {
    const { spawn } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { project } = await repo();
    const resumeFile = path.join(os.tmpdir(), `concord-resume-${Math.random().toString(36).slice(2)}`);
    const child = spawn(process.execPath, ['--no-warnings', '--import', 'tsx', fileURLToPath(new URL('./writerProcess.ts', import.meta.url)), ...args], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, WRITER_AT: opts.at ?? '', WRITER_DO: opts.then ?? '', WRITER_RESUME: resumeFile, WRITER_SLUG: project.slug },
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    let done = false;
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) =>
      child.on('exit', (code, signal) => {
        done = true;
        resolve({ code, signal });
      }),
    );
    return {
      exited,
      output: () => out.replace(/^paused\n/, '').trim(),
      /** Resolves once it is waiting at its pause point. */
      paused: async () => {
        for (let i = 0; i < 1200 && !out.startsWith('paused\n'); i++) {
          if (done) throw new Error(`writer exited instead of pausing: ${out}`);
          await sleep(50);
        }
        if (!out.startsWith('paused\n')) throw new Error(`writer never paused: ${out}`);
      },
      resume: async () => {
        fs.writeFileSync(resumeFile, '');
        return exited;
      },
      stop: () => {
        if (!done) child.kill('SIGKILL');
        fs.rmSync(resumeFile, { force: true });
      },
    };
  };

  it('never lets a copy read before a merge be saved over it', async () => {
    const crsMod = await import('../src/services/changeRequests.js');
    const { put } = await import('../src/db.js');
    const id = await approvedEdit('Contributor Stale Copy', `${VOL}Cause`, { examples: ['stale copy'] });
    // A writer holding a copy, paused before saving while a merge recorded itself: its save is refused.
    await expect(
      crsMod.updateCR(await crsMod.getCR(id), async (c) => {
        await put('changeRequests', { ...await crsMod.getCR(id), status: 'merged', mergedCommit: 'abc', rev: (c.rev ?? 0) + 1 }, demoId);
        c.status = 'withdrawn';
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await crsMod.getCR(id)).toMatchObject({ status: 'merged', mergedCommit: 'abc' });
    // And a copy that is already out of date is refused before anything is written.
    const old = { ...await crsMod.getCR(id), rev: 0 };
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
      if (++calls === 2) bumpRevElsewhere(id);
      return iso();
    });
    try {
      expect((await editor.post(`/api/change-requests/${id}/reviews`).send({ round: await roundOf(editor, id), decision: 'request-changes', comment: 'Lost with its save.' })).status).toBe(409);
    } finally {
      spy.mockRestore();
    }
    expect((await list<{ comment?: string }>('reviews', id)).some((r) => r.comment === 'Lost with its save.')).toBe(false);
  });

  it('keeps a committed merge if the process dies before git is updated, and repairs git on the next read', async () => {
    const crsMod = await import('../src/services/changeRequests.js');
    const { store, project, rawGit, rawFile } = await repo();
    const id = await approvedEdit('Contributor Crash', `${VOL}Cause`, { comment: 'Survives a crash.' });
    const before = await store.head(project);
    await killedAfterCommit('merge', id, (await userOf(await login('steward', 'Steward Crash'))).id);
    // The merge and its bookkeeping landed together in the database...
    const merged = await store.head(project);
    expect(merged).not.toBe(before);
    expect(await crsMod.getCR(id)).toMatchObject({ status: 'merged', mergedCommit: merged });
    if (onGit) {
      // ...while git was never touched.
      expect(rawGit('rev-parse', 'HEAD')).toBe(before);
      // The commit only the database names survives garbage collection.
      rawGit('reflog', 'expire', '--expire=now', '--all');
      rawGit('gc', '-q', '--prune=now');
      expect(rawGit('cat-file', '-t', merged)).toBe('commit');
    }
    // An ordinary read shows it (and, on git, puts git right: branch, index and files).
    expect((await (await login('member', 'Reader Crash')).get(termPath(`${VOL}Cause`))).body.comment).toBe('Survives a crash.');
    if (onGit) {
      expect(rawGit('rev-parse', 'HEAD')).toBe(merged);
      expect(rawGit('status', '--porcelain', '--untracked-files=no')).toBe('');
      expect(rawFile('ontology.ttl')).toContain('Survives a crash.');
      onlyDraftPins(rawGit, merged);
    }
  });

  gitOnly('repairs checked-out files that failed to update, and files an older sync put back', async () => {
    const crsMod = await import('../src/services/changeRequests.js');
    const { ontologyStore, project, rawGit, rawFile, raw } = await repo();
    const fs = await import('node:fs');
    const path = await import('node:path');
    const id = await approvedEdit('Contributor Checkout', `${VOL}Cause`, { editorialNote: 'Checked out eventually.' });
    const spy = vi.spyOn(ontologyStore, 'checkout').mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    try {
      expect((await crsMod.merge(await crsMod.getCR(id), await userOf(await login('steward', 'Steward Checkout')))).status).toBe('merged');
    } finally {
      spy.mockRestore();
    }
    await ontologyStore.working(project);
    expect(rawGit('status', '--porcelain', '--untracked-files=no')).toBe('');
    expect(rawFile('ontology.ttl')).toBe(await ontologyStore.readWorkingText(project, await ontologyStore.head(project)));

    // An older sync (from another process) put the previous draft's files back and recorded that it had.
    const head = await ontologyStore.head(project);
    const older = rawGit('rev-parse', `${head}~1`);
    rawGit('read-tree', '--reset', '-u', older);
    const stamp = path.join(raw, '.git', 'concord-synced');
    fs.writeFileSync(stamp, fs.readFileSync(stamp, 'utf8').replace(head, older));
    await ontologyStore.versions(project);
    expect(rawFile('ontology.ttl')).toContain('Checked out eventually.');
    // A branch ahead of the database is put back too.
    rawGit('update-ref', 'HEAD', rawGit('commit-tree', `${head}^{tree}`, '-p', head, '-m', 'stray'));
    await ontologyStore.log(project);
    expect(rawGit('rev-parse', 'HEAD')).toBe(head);
  });

  gitOnly('restores release tags from the published releases, including ones from before', async () => {
    const { ontologyStore, project, rawGit } = await repo();
    const { list } = await import('../src/db.js');
    const published = (await list<{ version: string; status: string; commit?: string }>('releases', demoId)).filter((r) => r.status === 'published' && r.commit);
    expect(published.length).toBeGreaterThan(0);
    for (const r of published) rawGit('tag', '-d', `v${r.version}`);
    await ontologyStore.at(project, published[0].version);
    for (const r of published) expect(rawGit('rev-parse', `v${r.version}^{commit}`)).toBe(r.commit);
  });

  gitOnly('drops the pin of an advance that was refused', async () => {
    const { ontologyStore, project, rawGit } = await repo();
    const graph = await ontologyStore.working(project);
    const stale = rawGit('rev-parse', `${await ontologyStore.head(project)}~1`);
    await expect(ontologyStore.commitWorking(project, graph, 'refused', { name: 'Refused' }, stale)).rejects.toMatchObject({ status: 409 });
    onlyDraftPins(rawGit, await ontologyStore.head(project));
  });

  it('records a release atomically, survives dying before its tag, and refuses a second publisher', async () => {
    const crsMod = await import('../src/services/changeRequests.js');
    const releases = await import('../src/services/releases.js');
    const { store: ontologyStore, project, rawGit } = await repo();
    const { put, list } = await import('../src/db.js');
    const { getProject } = await import('../src/services/ontologies.js');
    const steward = await login('steward', 'Steward Atomic');
    const stewardUser = await userOf(steward);
    const id = await approvedEdit('Contributor Atomic', `${VOL}Cause`, { examples: ['released atomically'] });
    expect((await crsMod.merge(await crsMod.getCR(id), stewardUser)).status).toBe('merged');
    await steward.post(`/api/ontologies/${demoId}/releases`).send({});
    const pending = (await list<{ id: string; status: string; version: string; changeRequestIds: string[] }>('releases', demoId)).find((r) => r.status === 'draft' || r.status === 'voting')!;
    const draft = (await put('releases', { ...pending, status: 'draft' }, demoId));
    const tag = `v${draft.version}`;

    // The publisher's process is killed the moment its transaction commits.
    await killedAfterCommit('publish', draft.id, stewardUser.id);
    // Everything the release records landed with the commit.
    const stored = (await list<{ id: string; status: string; commit?: string }>('releases', demoId)).find((r) => r.id === draft.id)!;
    expect(stored.status).toBe('published');
    expect(stored.commit).toBe(await ontologyStore.head(project));
    expect((await getProject(demoId)).currentVersion).toBe(draft.version);
    for (const crId of draft.changeRequestIds) expect((await crsMod.getCR(crId)).status).toBe('released');
    // The tag follows from the database on the next ordinary read.
    if (onGit) expect(() => rawGit('rev-parse', '-q', '--verify', `refs/tags/${tag}`)).toThrow();
    expect((await steward.get(`/api/ontologies/${demoId}/source?format=turtle&ref=${draft.version}`)).status).toBe(200);
    if (onGit) expect(rawGit('rev-parse', `${tag}^{commit}`)).toBe(stored.commit);
    // Publishing again (from a copy read before) is refused rather than rewriting the version.
    const released = await ontologyStore.readReleaseFile(project, draft.version, 'ontology.ttl');
    await expect(releases.publishRelease({ ...draft } as never, stewardUser)).rejects.toMatchObject({ status: 409 });
    expect(await ontologyStore.readReleaseFile(project, draft.version, 'ontology.ttl')).toBe(released);
  });

  it('does not publish a release that was rejected or redrafted while it was being published', async () => {
    const crsMod = await import('../src/services/changeRequests.js');
    const releases = await import('../src/services/releases.js');
    const { store: ontologyStore, project, rawGit } = await repo();
    const { put, list } = await import('../src/db.js');
    const steward = await login('steward', 'Steward Rejected');
    const stewardUser = await userOf(steward);
    for (const [what, change] of [
      ['rejected', (r: { id: string; notes: string }) => ({ ...r, status: 'rejected' })],
      ['redrafted', (r: { id: string; notes: string }) => ({ ...r, notes: `${r.notes}\n\nRedrafted.` })],
    ] as const) {
      const id = await approvedEdit(`Contributor ${what}`, `${VOL}Cause`, { examples: [`release ${what}`] });
      expect((await crsMod.merge(await crsMod.getCR(id), stewardUser)).status).toBe('merged');
      await steward.post(`/api/ontologies/${demoId}/releases`).send({});
      const pending = (await list<{ id: string; status: string; version: string; notes: string }>('releases', demoId)).find((r) => r.status === 'draft' || r.status === 'voting')!;
      const draft = (await put('releases', { ...pending, status: 'draft' }, demoId));
      const head = await ontologyStore.head(project);
      const original = ontologyStore.writeRelease;
      const spy = vi.spyOn(ontologyStore, 'writeRelease').mockImplementationOnce(async function (this: typeof ontologyStore, ...args) {
        await put('releases', change((await list<typeof draft>('releases', demoId)).find((r) => r.id === draft.id)! as never), demoId);
        return original.apply(ontologyStore, args);
      });
      try {
        await expect(releases.publishRelease({ ...draft } as never, stewardUser), what).rejects.toMatchObject({ status: 409 });
      } finally {
        spy.mockRestore();
      }
      expect(await ontologyStore.head(project), what).toBe(head);
      expect((await list<{ id: string; status: string }>('releases', demoId)).find((r) => r.id === draft.id)!.status, what).not.toBe('published');
      if (onGit) expect(() => rawGit('rev-parse', '-q', '--verify', `refs/tags/v${draft.version}`), what).toThrow();
      // Leave nothing pending for the next round.
      await put('releases', { ...(await list<typeof draft>('releases', demoId)).find((r) => r.id === draft.id)!, status: 'rejected' }, demoId);
    }
  });

  it('keeps a vote that passed for requests approved before votes were recorded on approval', async () => {
    const crsMod = await import('../src/services/changeRequests.js');
    const { getProject, updateProject } = await import('../src/services/ontologies.js');
    const { GOVERNANCE_TEMPLATES } = await import('../src/services/governance.js');
    const { put } = await import('../src/db.js');
    const { newId } = await import('../src/ids.js');
    const project = (await getProject(demoId));
    const saved = project.governance;
    const lazy = GOVERNANCE_TEMPLATES['lazy-consensus'];
    // Lazy consensus where one yes vote passes, so the test can hold a real, completed vote.
    await updateProject({ ...project, governance: { ...lazy, changes: { ...lazy.changes, patch: { ...lazy.changes.patch, vote: { ...lazy.changes.patch.vote!, quorum: 0, threshold: 0.5 } } } } });
    try {
      const contributor = await login('contributor', 'Contributor Legacy Vote');
      const editor = await login('editor', 'Editor Legacy Vote');
      const editorUser = await userOf(editor);
      const created = await edit(contributor, { termIri: `${VOL}Cause`, set: { comment: 'Voted through long ago.' } });
      const id = created.body.id;
      // Objected to, voted on (and passed), then approved, all by an older version: approvedAs has no `voted`.
      await put('reviews', { id: newId('rev'), changeRequestId: id, userId: editorUser.id, roles: ['editor'], decision: 'object', at: '2000-01-01T12:00:00Z' }, id);
      await put('votes', { id: newId('vote'), subjectType: 'change-request', subjectId: id, userId: editorUser.id, roles: ['editor'], choice: 'yes', at: '2000-01-03T00:00:00Z' }, id);
      const cr = await crsMod.getCR(id);
      await put(
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
      const merged = await crsMod.merge(await crsMod.getCR(id), await userOf(await login('steward', 'Steward Legacy Vote')));
      expect(merged.status).toBe('merged');
    } finally {
      await updateProject({ ...(await getProject(demoId)), governance: saved });
    }
  });

  it('writes a vote only together with the request it was cast on', async () => {
    const crsMod = await import('../src/services/changeRequests.js');
    const { getProject, updateProject } = await import('../src/services/ontologies.js');
    const { GOVERNANCE_TEMPLATES } = await import('../src/services/governance.js');
    const { clock } = await import('../src/clock.js');
    const { put, list } = await import('../src/db.js');
    const project = (await getProject(demoId));
    const saved = project.governance;
    await updateProject({ ...project, governance: GOVERNANCE_TEMPLATES['lazy-consensus'] });
    try {
      const contributor = await login('contributor', 'Contributor Atomic Vote');
      const editor = await login('editor', 'Editor Atomic Vote');
      const created = await edit(contributor, { termIri: `${VOL}Cause`, set: { comment: 'Voted on atomically.' } });
      const id = created.body.id;
      await put('changeRequests', { ...await crsMod.getCR(id), status: 'voting', statusSince: clock.iso() }, demoId);
      // Someone else keeps writing the request while the vote is being made: the vote and its save are refused together.
      const iso = clock.iso.bind(clock);
      const spy = vi.spyOn(clock, 'iso').mockImplementation(() => {
        try {
          bumpRevElsewhere(id);
        } catch {
          /* busy: this process is inside its own write just now */
        }
        return iso();
      });
      try {
        expect((await editor.post(`/api/change-requests/${id}/votes`).send({ round: await roundOf(editor, id), choice: 'no', comment: 'Lost with its save.' })).status).toBe(409);
      } finally {
        spy.mockRestore();
      }
      expect((await list<{ comment?: string }>('votes', id)).some((v) => v.comment === 'Lost with its save.')).toBe(false);
      await put('changeRequests', { ...await crsMod.getCR(id), status: 'withdrawn' }, demoId);
    } finally {
      await updateProject({ ...(await getProject(demoId)), governance: saved });
    }
  });

  it('never lets a release vote begun before the release was published undo the publication', async () => {
    const releases = await import('../src/services/releases.js');
    const { put, list, mustGet, remove } = await import('../src/db.js');
    const { newId } = await import('../src/ids.js');
    const voter = await userOf(await login('editor', 'Editor Release Race'));
    const now = new Date().toISOString();
    // A major release whose vote has closed without quorum: anyone looking at this copy would reject it.
    const stale = (await put(
      'releases',
      { id: newId('rel'), ontologyId: demoId, version: '99.0.0', level: 'major' as const, status: 'voting' as const, changeRequestIds: [], notes: 'Raced.', versionIRI: 'https://example.org/raced/99.0.0', createdBy: voter.id, createdAt: now, statusSince: '2000-01-01T00:00:00Z' },
      demoId,
    ));
    try {
      expect((await releases.releaseGovernance(stale)).outcome).toBe('rejected');
      // Another process publishes it after the vote (and the clock) read it.
      await put('releases', { ...stale, status: 'published', commit: 'c0ffee', publishedAt: now, statusSince: now, rev: 1 }, demoId);
      await expect(releases.voteOnRelease({ ...stale }, voter, 'no')).rejects.toMatchObject({ status: 409 });
      expect((await list('votes', stale.id))).toHaveLength(0);
      expect(await releases.advanceRelease({ ...stale })).toMatchObject({ status: 'published', commit: 'c0ffee' });
      expect((await mustGet('releases', stale.id))).toMatchObject({ status: 'published', commit: 'c0ffee', publishedAt: now, rev: 1 });
    } finally {
      await remove('releases', stale.id);
    }
  });

  gitOnly('never lets a sync that read an older draft drop what holds the newer one', async () => {
    const { ontologyStore, project, rawGit } = await repo();
    const gc = () => {
      rawGit('reflog', 'expire', '--expire=now', '--all');
      rawGit('gc', '-q', '--prune=now');
    };
    const later = Date.now() + 24 * 3600_000;
    const { OntologyGraph } = await import('@concord/core');
    const withLabel = async (label: string) => OntologyGraph.fromTurtle(`${await ontologyStore.readWorkingText(project)}\n<urn:concord-test:${label}> <http://www.w3.org/2000/01/rdf-schema#label> "${label}" .\n`);
    // A newer draft recorded while git still shows the older one, then a sync that read the older draft, a day later.
    const older = await ontologyStore.head(project);
    const sync = vi.spyOn(ontologyStore, 'sync').mockImplementationOnce(async () => undefined);
    let newer: string;
    try {
      newer = await ontologyStore.commitWorking(project, await withLabel('newer'), 'newer draft', { name: 'Newer' });
    } finally {
      sync.mockRestore();
    }
    expect(rawGit('rev-parse', 'HEAD')).toBe(older);
    // (It read the older draft both for the branch and for pruning; only the reclaim's own transaction reads the database afresh.)
    const head = vi.spyOn(ontologyStore, 'head').mockResolvedValueOnce(older).mockResolvedValueOnce(older);
    const now = vi.spyOn(Date, 'now').mockReturnValue(later);
    try {
      await ontologyStore.sync(project);
    } finally {
      head.mockRestore();
      now.mockRestore();
    }
    gc();
    expect(rawGit('cat-file', '-t', newer)).toBe('commit');
    // And reads put git back on the newer draft, leaving only its own pins.
    await ontologyStore.log(project);
    expect(rawGit('rev-parse', 'HEAD')).toBe(await ontologyStore.head(project));
    onlyDraftPins(rawGit, await ontologyStore.head(project));

    // Once git holds the newer draft (and its pin is gone), a sync that read the older draft can't move what holds it back.
    const stale = vi.spyOn(ontologyStore, 'head').mockResolvedValueOnce(older).mockResolvedValueOnce(older);
    try {
      await ontologyStore.sync(project);
    } finally {
      stale.mockRestore();
    }
    collectGarbage(rawGit);
    expect(rawGit('cat-file', '-t', newer)).toBe('commit');
    expect(rawGit('rev-parse', 'refs/concord/draft')).toBe(newer);
    await ontologyStore.log(project);
    expect(rawGit('rev-parse', 'HEAD')).toBe(newer);
  });

  gitOnly('stops a sync that was overtaken from undoing its successor, and repairs files it put back anyway', async () => {
    const { ontologyStore, project, rawGit, rawFile, raw } = await repo();
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { get, put, remove } = await import('../src/db.js');
    const stamp = path.join(raw, '.git', 'concord-synced');
    const lease = `git-sync:${project.slug}`;
    await ontologyStore.ensureSynced(project);
    const head = await ontologyStore.head(project);
    // Files an overtaken sync put back after its successor finished: branch and record of the sync both look right.
    const stampBefore = fs.readFileSync(stamp, 'utf8');
    rawGit('read-tree', '--reset', '-u', `${head}~1`);
    expect(fs.readFileSync(stamp, 'utf8')).toBe(stampBefore);
    await ontologyStore.log(project);
    expect(rawGit('status', '--porcelain', '--untracked-files=no')).toBe('');
    expect(rawFile('ontology.ttl')).toBe(await ontologyStore.readWorkingText(project, head));

    // A sync presumed dead and replaced mid-way: it stops, leaves no record of a sync, and leaves its successor's lease alone.
    const checkout = vi.spyOn(ontologyStore, 'checkout').mockImplementationOnce(async () => {
      await put('kv', { id: lease, token: 'successor', until: Date.now() + 60_000 });
    });
    try {
      await expect(ontologyStore.sync(project)).rejects.toThrow('another sync took over');
    } finally {
      checkout.mockRestore();
    }
    expect((await get<{ token: string }>('kv', lease))?.token).toBe('successor');
    expect(fs.existsSync(stamp)).toBe(false);
    // While the successor holds the lease, others leave the job to it.
    await ontologyStore.ensureSynced(project);
    expect(fs.existsSync(stamp)).toBe(false);
    // Once it is gone, the next read finishes the job.
    await remove('kv', lease);
    await ontologyStore.versions(project);
    expect(fs.existsSync(stamp)).toBe(true);
    expect((await get('kv', lease))).toBeUndefined();
  });

  gitOnly('keeps a slow writer’s pin, and reclaims a stalled one’s only by refusing its commit', async () => {
    const { ontologyStore, project, rawGit } = await repo();
    const { PIN_GRACE_MS } = await import('../src/services/ontologyStore.js');
    // Slow: paused right after pinning; meanwhile another process syncs and collects garbage, within the grace period.
    const slow = await writerProcess(['advance', 'slow'], { at: 'pin', then: 'pause' });
    try {
      await slow.paused();
      const [slowCommit] = pinnedCommits(rawGit);
      await ontologyStore.sync(project);
      collectGarbage(rawGit);
      expect(rawGit('cat-file', '-t', slowCommit)).toBe('commit');
      await slow.resume();
      expect(slow.output()).toBe(`committed ${slowCommit}`);
      expect(await ontologyStore.head(project)).toBe(slowCommit);
      collectGarbage(rawGit);
      expect(rawGit('cat-file', '-t', slowCommit)).toBe('commit');
    } finally {
      slow.stop();
    }

    // Stalled past the grace period: its pin is reclaimed, and when it resumes its commit is refused, so nothing points at a lost commit.
    const before = await ontologyStore.head(project);
    const stalled = await writerProcess(['advance', 'stalled'], { at: 'pin', then: 'pause' });
    try {
      await stalled.paused();
      const [stalledCommit] = pinnedCommits(rawGit);
      const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + PIN_GRACE_MS + 60_000);
      try {
        await ontologyStore.prunePins(project);
      } finally {
        now.mockRestore();
      }
      collectGarbage(rawGit);
      expect(() => rawGit('cat-file', '-t', stalledCommit)).toThrow();
      await stalled.resume();
      expect(stalled.output()).toBe('refused 409');
      expect(await ontologyStore.head(project)).toBe(before);
      expect(pinnedCommits(rawGit)).toEqual([]);
    } finally {
      stalled.stop();
    }
  });

  gitOnly('reclaims the pins of writers that died through ordinary reads, and makes no pins for a draft that did not change', async () => {
    const crsMod = await import('../src/services/changeRequests.js');
    const { ontologyStore, project, rawGit } = await repo();
    const { PIN_GRACE_MS } = await import('../src/services/ontologyStore.js');
    const { OntologyGraph } = await import('@concord/core');
    for (const label of ['crashed-1', 'crashed-2', 'crashed-3']) {
      const crashed = await writerProcess(['advance', label], { at: 'pin', then: 'kill' });
      try {
        expect((await crashed.exited).signal).toBe('SIGKILL');
      } finally {
        crashed.stop();
      }
    }
    const abandoned = pinnedCommits(rawGit);
    expect(abandoned).toHaveLength(3);
    // Within the grace period they are left alone (their writers might only be slow), even as others commit and read.
    const graph = await OntologyGraph.fromTurtle(`${await ontologyStore.readWorkingText(project)}\n<urn:concord-test:after-crash> <http://www.w3.org/2000/01/rdf-schema#label> "after crash" .\n`);
    await ontologyStore.commitWorking(project, graph, 'after the crashes', { name: 'Survivor' });
    await ontologyStore.working(project);
    expect(pinnedCommits(rawGit).sort()).toEqual([...abandoned].sort());
    // Past it, ordinary reads (with git already in line, so no sync runs) reclaim them, and their commits can be collected.
    const sync = vi.spyOn(ontologyStore, 'sync');
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 365 * 24 * 3600_000);
    try {
      await ontologyStore.log(project);
      await ontologyStore.working(project);
      expect(sync).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
      sync.mockRestore();
    }
    collectGarbage(rawGit);
    for (const sha of abandoned) expect(() => rawGit('cat-file', '-t', sha)).toThrow();
    const head = await ontologyStore.head(project);
    onlyDraftPins(rawGit, head);

    // Advances and commits that change nothing make no pins at all (looked at with syncing, and so cleanup, off).
    const off = vi.spyOn(ontologyStore, 'sync').mockImplementation(async () => undefined);
    try {
      for (let i = 0; i < 20; i++) await ontologyStore.advanceTo(project, head, head);
      for (let i = 0; i < 3; i++) expect(await ontologyStore.commitWorking(project, await ontologyStore.working(project), 'nothing new', { name: 'Same' })).toBe(head);
      expect(pinnedCommits(rawGit)).toEqual([]);
    } finally {
      off.mockRestore();
    }
    // And an ordinary merge leaves none once synced.
    const id = await approvedEdit('Contributor Pinless', `${VOL}Cause`, { comment: 'Merged without a pin left behind.' });
    expect((await crsMod.merge(await crsMod.getCR(id), await userOf(await login('steward', 'Steward Pinless')))).status).toBe('merged');
    expect(await ontologyStore.head(project)).not.toBe(head);
    onlyDraftPins(rawGit, await ontologyStore.head(project));
  });

  gitOnly('never reclaims pins named by an earlier version, whose writers do not check for reclaims, until the draft holds them', async () => {
    const { ontologyStore, project, rawGit } = await repo();
    const head = await ontologyStore.head(project);
    // Commits only pins hold, named as earlier versions named them (<time>-<sha> and <sha>-<writer>).
    const tree = rawGit('rev-parse', `${head}^{tree}`);
    const oldStyle = rawGit('commit-tree', tree, '-p', head, '-m', 'pinned by an earlier version');
    const newerStyle = rawGit('commit-tree', tree, '-p', head, '-m', 'pinned by the previous version');
    const held = rawGit('rev-parse', `${head}~1`);
    rawGit('update-ref', `refs/concord/commits/${Date.now() - 3600_000}-${oldStyle}`, oldStyle);
    rawGit('update-ref', `refs/concord/commits/${newerStyle}-12345678-1234-4123-8123-123456789abc`, newerStyle);
    rawGit('update-ref', `refs/concord/commits/${held}-87654321-1234-4123-8123-123456789abc`, held);
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 365 * 24 * 3600_000);
    try {
      await ontologyStore.prunePins(project);
    } finally {
      now.mockRestore();
    }
    collectGarbage(rawGit);
    // A year on, the ones the draft doesn't hold are still there (and so are their commits); the one it holds is gone.
    expect(pinnedCommits(rawGit).sort()).toEqual([oldStyle, newerStyle].sort());
    for (const sha of [oldStyle, newerStyle]) expect(rawGit('cat-file', '-t', sha)).toBe('commit');
    for (const ref of rawGit('for-each-ref', '--format=%(refname)', 'refs/concord/commits/').split('\n')) rawGit('update-ref', '-d', ref);
  });

  gitOnly('lets one server at a time change the repositories, and stops one that lost its hold from changing anything', async () => {
    const { ontologyStore, project, rawGit, raw, claimGitStore, STORE_VERSION } = { ...(await import('../src/services/ontologyStore.js')), ...(await repo()) };
    const { get, put, remove } = await import('../src/db.js');
    const { OntologyGraph } = await import('@concord/core');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const withLabel = async (label: string) => OntologyGraph.fromTurtle(`${await ontologyStore.readWorkingText(project)}\n<urn:concord-test:${label}> <http://www.w3.org/2000/01/rdf-schema#label> "${label}" .\n`);
    // A live server (here, of another version) holds the repositories: this one won't start, and changes nothing.
    await put('kv', { id: 'git-store', owner: 'other', version: STORE_VERSION + 1, until: Date.now() + 60_000 });
    try {
      await expect(claimGitStore({ waitMs: 1_500 })).rejects.toThrow('Another Concord server');
      const head = await ontologyStore.head(project);
      await expect(ontologyStore.commitWorking(project, await withLabel('blocked'), 'while another holds it', { name: 'Blocked' })).rejects.toMatchObject({ status: 503 });
      expect(await ontologyStore.head(project)).toBe(head);
      expect(pinnedCommits(rawGit)).toEqual([]);
    } finally {
      await remove('kv', 'git-store');
    }

    // Once the other stops (its claim lapses), this one starts and works.
    await put('kv', { id: 'git-store', owner: 'other', version: STORE_VERSION + 1, until: Date.now() + 1_000 });
    const lost = vi.fn();
    const store = await claimGitStore({ waitMs: 5_000, onLost: lost });
    try {
      expect((await get<{ owner: string }>('kv', 'git-store'))?.owner).not.toBe('other');
      await store.renew();
      await ontologyStore.commitWorking(project, await withLabel('claimed'), 'while holding it', { name: 'Holder' });
      expect(lost).not.toHaveBeenCalled();

      // It stalls, and another server takes over: now it changes nothing, by any path, and reports the loss (once).
      const head = await ontologyStore.head(project);
      await put('kv', { id: 'git-store', owner: 'successor', version: STORE_VERSION, until: Date.now() + 60_000 });
      rawGit('read-tree', '--reset', '-u', `${head}~1`);
      await ontologyStore.log(project);
      expect(rawGit('status', '--porcelain', '--untracked-files=no')).not.toBe('');
      expect(lost).toHaveBeenCalledTimes(1);
      await expect(ontologyStore.commitWorking(project, await withLabel('stale'), 'after losing it', { name: 'Stale' })).rejects.toMatchObject({ status: 503 });
      expect(await ontologyStore.head(project)).toBe(head);
      expect(pinnedCommits(rawGit)).toEqual([]);
      await expect(ontologyStore.prunePins(project)).rejects.toThrow('lost its hold');
      const fresh = { ...project, slug: `claim-lost-${Date.now()}`, title: 'Never created' };
      await expect(ontologyStore.init(fresh as never, '', '')).rejects.toMatchObject({ status: 503 });
      expect(fs.existsSync(path.join(path.dirname(raw), fresh.slug))).toBe(false);
      // Nor does it build commits, publish to a remote (or even record one), or wipe anything.
      const objects = rawGit('count-objects', '-v');
      await expect(ontologyStore.updateReleaseFiles(project, { '1.0.0': { 'NOTE.md': 'stale' } }, 'stale release files')).rejects.toThrow('lost its hold');
      expect(rawGit('count-objects', '-v')).toBe(objects);
      const remotes = rawGit('remote', '-v');
      await expect(ontologyStore.push(project as never, path.join(path.dirname(raw), 'nowhere.git'))).rejects.toThrow('lost its hold');
      expect(rawGit('remote', '-v')).toBe(remotes);
      const simulation = await import('../src/services/simulation.js');
      await expect(simulation.resetAll()).rejects.toMatchObject({ status: 503 });
      expect((await get('ontologies', demoId))).toBeDefined();
      expect(fs.existsSync(raw)).toBe(true);
      await store.renew();
      expect(lost).toHaveBeenCalledTimes(1);
      // Shutting down gives up only its own claim, never the successor's.
      await store.release();
      expect((await get<{ owner: string }>('kv', 'git-store'))?.owner).toBe('successor');
    } finally {
      await store.release();
      await remove('kv', 'git-store');
    }
    // With no server holding them, git is put back in line.
    await ontologyStore.log(project);
    expect(rawGit('status', '--porcelain', '--untracked-files=no')).toBe('');
  });

  gitOnly('never moves the draft ref back when two cleanups race', async () => {
    const { ontologyStore, project, rawGit } = await repo();
    const { OntologyGraph } = await import('@concord/core');
    const text = await ontologyStore.readWorkingText(project);
    const triple = (label: string) => `\n<urn:concord-test:${label}> <http://www.w3.org/2000/01/rdf-schema#label> "${label}" .\n`;
    const first = await OntologyGraph.fromTurtle(text + triple('race-1'));
    const second = await OntologyGraph.fromTurtle(text + triple('race-1') + triple('race-2'));
    // A draft recorded while git lags behind it.
    const lagging = vi.spyOn(ontologyStore, 'sync').mockImplementationOnce(async () => undefined);
    let h1: string;
    try {
      h1 = await ontologyStore.commitWorking(project, first, 'first', { name: 'Racer' });
    } finally {
      lagging.mockRestore();
    }
    const behind = rawGit('rev-parse', 'refs/concord/draft');
    expect(behind).not.toBe(h1);
    // A cleanup in another process reads the draft ref (still behind), then pauses before moving it to h1...
    const cleanup = await writerProcess(['prune'], { at: 'draft-read', then: 'pause' });
    try {
      await cleanup.paused();
      // ...while a newer draft is committed and git brought fully in line.
      const h2 = await ontologyStore.commitWorking(project, second, 'second', { name: 'Racer' });
      expect(rawGit('rev-parse', 'refs/concord/draft')).toBe(h2);
      await cleanup.resume();
      expect(cleanup.output()).toMatch(/^refused/);
      expect(rawGit('rev-parse', 'refs/concord/draft')).toBe(h2);
    } finally {
      cleanup.stop();
    }
  });

  gitOnly('refuses a write when another server takes over just before the hold is renewed', async () => {
    const { ontologyStore, project, raw, claimGitStore, STORE_VERSION } = { ...(await import('../src/services/ontologyStore.js')), ...(await repo()) };
    const { get, put, remove } = await import('../src/db.js');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const lost = vi.fn();
    const store = await claimGitStore({ waitMs: 0, onLost: lost });
    // The next check finds the hold due for renewal, and a successor takes over at that very moment.
    const realNow = Date.now.bind(Date);
    let tookOver = false;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => {
      if (!tookOver) {
        tookOver = true;
        putKvElsewhere({ id: 'git-store', owner: 'successor', version: STORE_VERSION, until: realNow() + 60_000 });
      }
      return realNow() + 10_000;
    });
    try {
      const fresh = { ...project, slug: `renew-race-${realNow()}`, title: 'Never created' };
      await expect(ontologyStore.init(fresh as never, '', '')).rejects.toMatchObject({ status: 503 });
      expect(tookOver).toBe(true);
      expect(fs.existsSync(path.join(path.dirname(raw), fresh.slug))).toBe(false);
      expect(lost).toHaveBeenCalledTimes(1);
      expect((await get<{ owner: string }>('kv', 'git-store'))?.owner).toBe('successor');
    } finally {
      now.mockRestore();
      await store.release();
      await remove('kv', 'git-store');
    }
  });

  gitOnly('puts back the repositories a crash left moved aside mid-reset, and never deletes or guesses otherwise', async () => {
    const { ontologyStore, project, raw } = await repo();
    const { list, put, remove } = await import('../src/db.js');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { config } = await import('../src/config.js');
    const repos = path.dirname(raw);
    const text = await ontologyStore.readWorkingText(project);
    const aside = (name: string) => path.join(config.dataDir, `.ontologies-deleted-${name}`);
    // The crash came after the move but before the transaction committed: the rows are back, the repositories aren't.
    fs.renameSync(repos, aside('crashed'));
    await ontologyStore.recoverWipe();
    expect(fs.existsSync(aside('crashed'))).toBe(false);
    expect(await ontologyStore.readWorkingText(project)).toBe(text);

    // The reset committed (no ontologies left in the database): nothing is moved back, and nothing deleted.
    const rows = (await list<{ id: string }>('ontologies'));
    fs.renameSync(repos, aside('committed'));
    for (const r of rows) (await remove('ontologies', r.id));
    try {
      await ontologyStore.recoverWipe();
      expect(fs.existsSync(repos)).toBe(false);
      expect(fs.existsSync(aside('committed'))).toBe(true);
    } finally {
      for (const r of rows) (await put('ontologies', r));
    }
    // Several left aside: which one is the draft's is a guess, so none is moved back or deleted.
    fs.mkdirSync(path.join(aside('older'), 'old'), { recursive: true });
    await ontologyStore.recoverWipe();
    expect(fs.existsSync(repos)).toBe(false);
    expect(fs.existsSync(aside('committed'))).toBe(true);
    expect(fs.existsSync(aside('older'))).toBe(true);
    // A leftover beside the repositories is left alone too.
    fs.renameSync(aside('committed'), repos);
    await ontologyStore.recoverWipe();
    expect(fs.existsSync(aside('older'))).toBe(true);
    expect(await ontologyStore.readWorkingText(project)).toBe(text);
    fs.rmSync(aside('older'), { recursive: true, force: true });
  });

  gitOnly('keeps the server’s hold on the repositories through a demo reset', async () => {
    const { claimGitStore } = await import('../src/services/ontologyStore.js');
    const simulation = await import('../src/services/simulation.js');
    const { get, remove } = await import('../src/db.js');
    const lost = vi.fn();
    const store = await claimGitStore({ waitMs: 0, onLost: lost });
    try {
      const owner = (await get<{ owner: string }>('kv', 'git-store'))?.owner;
      const demo = await simulation.resetAll();
      // The reset wiped everything else, but not the hold, so reseeding (and everything after) still works.
      expect(lost).not.toHaveBeenCalled();
      expect((await get<{ owner: string }>('kv', 'git-store'))?.owner).toBe(owner);
      expect(demo).toBeDefined();
      demoId = demo!.id;
      const { ontologyStore, project } = await repo();
      const head = await ontologyStore.head(project);
      await ontologyStore.commitWorking(project, await ontologyStore.working(project), 'after the reset', { name: 'After' });
      expect(await ontologyStore.head(project)).toBe(head);
      expect((await (await login('member', 'Reader After Reset')).get(`/api/ontologies/${demoId}/source?format=turtle`)).status).toBe(200);
      expect(lost).not.toHaveBeenCalled();
    } finally {
      await store.release();
      await remove('kv', 'git-store');
    }
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
    // in the transaction that publishes; a change made after it must not reach the record.
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
    const working = ontologyStore.working.bind(ontologyStore);
    const between = vi.spyOn(ontologyStore, 'working').mockImplementationOnce(async (p) => {
      const changed = await getProject(demoId);
      changed.governance.releases.patch.minApprovals = before.requiredApprovals + 2;
      changed.governance.releases.patch.reviewPeriodDays = 33;
      await updateProject(changed);
      return working(p);
    });
    const write = ontologyStore.writeRelease.bind(ontologyStore);
    const spy = vi.spyOn(ontologyStore, 'writeRelease').mockImplementationOnce(async (...args: Parameters<typeof write>) => {
      const commit = await write(...args);
      // Right after the publishing transaction (and its check) committed.
      const changed = await getProject(demoId);
      changed.governance.releases.patch.minApprovals = before.requiredApprovals + 5;
      changed.governance.releases.patch.reviewPeriodDays = 77;
      await updateProject(changed);
      return commit;
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
