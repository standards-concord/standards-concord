import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { list, openDb } from '../src/db.js';
import { seedDemo } from '../src/services/simulation.js';
import { reportMemory, reportToken, resetReportLimits, sweepReportMemory } from '../src/public/report.js';
import { renderOntologyPage } from '../src/public/render.js';
import { pageInput } from '../src/public/routes.js';
import { findProject } from '../src/services/ontologies.js';
import { OntologyGraph } from '@concord/core';
import type { ChangeRequest, PublicReport } from '@concord/shared';

const app = createApp();
const NS = 'https://w3id.org/odi/volunteering#';
const TERM = `${NS}VolunteeringOpportunity`;
const OTHER = `${NS}Volunteer`;
const URL = '/def/volunteering/-/report';
const PROXY = 'proxy-secret-for-report-tests';

/** A visitor: a browser with its own report session, optionally at a given address (as the site's proxy reports it). */
async function visitor(ip?: string) {
  const agent = request.agent(app);
  const at = <T extends request.Test>(t: T) => (ip ? t.set('x-concord-proxy-secret', PROXY).set('x-concord-client-ip', ip) : t);
  const res = await at(agent.get(`${URL}/token?term=${encodeURIComponent(TERM)}&version=1.0.0`));
  const session = /concord_report=([^;]+)/.exec([res.headers['set-cookie'] ?? []].flat().join(';'))![1];
  let n = 0;
  // A form handed out a minute ago (people take more than a few seconds to write a report).
  const token = (o: { term?: string; version?: string; slug?: string; at?: number } = {}) =>
    reportToken({ slug: o.slug ?? 'volunteering', term: o.term ?? TERM, version: o.version ?? '1.0.0', session }, o.at ?? Date.now() - 60_000);
  const send = (body: Record<string, unknown> = {}) =>
    at(agent.post(URL).set('Accept', 'application/json')).send({
      term: TERM,
      version: '1.0.0',
      token: token({ term: typeof body.term === 'string' ? body.term : TERM }),
      title: '',
      description: `The definition doesn't say whether internships count (${ip ?? 'local'} ${++n}).`,
      website: '',
      ...body,
    });
  return { agent, session, token, send, at };
}

const queued = () => list<PublicReport>('publicReports');
const publicCRs = () => list<ChangeRequest>('changeRequests').filter((c) => c.origin.type === 'public-report');

beforeAll(async () => {
  openDb();
  await seedDemo();
  process.env.CONCORD_PROXY_SECRET = PROXY;
});
afterAll(() => {
  delete process.env.CONCORD_PROXY_SECRET;
});
beforeEach(() => resetReportLimits());

describe('reporting a problem from the public page', () => {
  it('offers both ways to report on every term, with a dialog on the page', async () => {
    const html = (await request(app).get('/def/volunteering')).text;
    expect(html).toContain(`${URL}?term=${encodeURIComponent(TERM)}&amp;version=1.0.0"`);
    expect(html).toContain('Report a problem with this term');
    expect(html).toContain('class="report-dialog"');
    // Members sign in and land on the term in Browse with the report form open.
    expect(html).toContain(`/login?next=${encodeURIComponent(`/o/volunteering/browse?term=${encodeURIComponent(TERM)}&report=1`)}`.replace(/&/g, '&amp;'));
  });

  it('serves a report page that works without JavaScript, with a token for that term and browser', async () => {
    const res = await request(app).get(`${URL}?term=${encodeURIComponent(TERM)}&version=1.0.0`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const cookie = [res.headers['set-cookie']].flat().join(';');
    expect(cookie).toMatch(/concord_report=[\w-]{22}/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(res.text).toContain('Report a problem with “volunteering opportunity”');
    expect(res.text).toMatch(/name="token" value="\d+\.[\w-]{22}\.[\w-]{43}"/);
    expect(res.text).toContain('name="website"');
    expect(res.text).toContain('<meta name="robots" content="noindex">');
    expect(res.text).toContain(encodeURIComponent('/o/volunteering/browse?term='));
    expect((await request(app).get(`${URL}?term=${encodeURIComponent(`${NS}NoSuchTerm`)}`)).status).toBe(404);
    expect((await request(app).get('/def/nope/-/report?term=x')).status).toBe(404);
  });

  it('holds reports for review: no change request, activity or triage until a moderator opens one', async () => {
    const v = await visitor();
    const crsBefore = publicCRs().length;
    const activityBefore = list('activity').length;
    const res = await v.send({ title: 'Internships', description: 'The definition does not say whether unpaid internships count as volunteering. ![x](https://attacker.example/p)' });
    expect(res.status).toBe(201);
    expect(Object.keys(res.body)).toEqual(['reference']);
    expect(publicCRs().length).toBe(crsBefore);
    expect(list('activity').length).toBe(activityBefore);
    const held = queued().find((r) => r.id === res.body.reference)!;
    expect(held).toMatchObject({ termIri: TERM, version: '1.0.0', title: 'Internships', termName: 'volunteering opportunity' });

    // Only editors, stewards and owners see the queue.
    expect((await request(app).get('/api/ontologies/volunteering/public-reports')).status).toBe(401);
    const contributor = request.agent(app);
    await contributor.post('/api/auth/demo').send({ name: 'Just a contributor', role: 'contributor' });
    expect((await contributor.get(`/api/ontologies/${findProject('volunteering')!.id}/public-reports`)).status).toBe(403);
    const steward = request.agent(app);
    await steward.post('/api/auth/demo').send({ name: 'A steward', role: 'steward' });
    const id = findProject('volunteering')!.id;
    const listed = (await steward.get(`/api/ontologies/${id}/public-reports`)).body as PublicReport[];
    expect(listed.map((r) => r.id)).toContain(held.id);

    // Opening it makes a bug report authored by the public, with no drafted edits.
    const opened = await steward.post(`/api/ontologies/${id}/public-reports/${held.id}/accept`);
    expect(opened.status).toBe(201);
    const cr = publicCRs().find((c) => c.id === opened.body.id)!;
    expect(cr).toMatchObject({ kind: 'bug', title: 'Internships', ops: [], origin: { type: 'public-report', termIri: TERM, version: '1.0.0' } });
    expect(cr.description).toContain('unpaid internships');
    expect(cr.description).toContain('opened for discussion by A steward');
    expect(queued().some((r) => r.id === held.id)).toBe(false);
    expect((await steward.post(`/api/ontologies/${id}/public-reports/${held.id}/accept`)).status).toBe(404);

    // Dismissing one removes it.
    const other = await v.send({ description: 'Another problem that turns out not to be one.' });
    expect((await steward.post(`/api/ontologies/${id}/public-reports/${other.body.reference}/dismiss`)).status).toBe(200);
    expect(queued().some((r) => r.id === other.body.reference)).toBe(false);
  });

  it('accepts a plain form post from the report page and thanks the reporter', async () => {
    const agent = request.agent(app);
    const page = await agent.get(`${URL}?term=${encodeURIComponent(TERM)}&version=1.0.0`);
    const token = /name="token" value="([^"]+)"/.exec(page.text)![1];
    const send = (t: string) =>
      agent.post(URL).set('Sec-Fetch-Site', 'same-origin').type('form').send({ term: TERM, version: '1.0.0', token: t, title: '', description: 'Plain form: the label should be singular.', website: '' });
    // Straight away is too quick; the reply is the form again, with a fresh token and the error tied to it.
    const quick = await send(token);
    expect(quick.status).toBe(400);
    expect(quick.text).toContain('That was quick');
    const [, ts, nonce, sig] = /name="token" value="(\d+)\.([\w-]+)\.([\w-]+)"/.exec(quick.text)!;
    expect(`${ts}.${nonce}.${sig}`).not.toBe(token);
    const session = /concord_report=([^;]+)/.exec([page.headers['set-cookie']].flat().join(';'))![1];
    const res = await send(reportToken({ slug: 'volunteering', term: TERM, version: '1.0.0', session }, Date.now() - 60_000));
    expect(res.status).toBe(201);
    expect(res.type).toMatch(/html/);
    expect(res.text).toContain('Thanks for your report');
    expect(queued().some((r) => r.description.startsWith('Plain form'))).toBe(true);
  });

  it('ties field errors to the field', async () => {
    const agent = request.agent(app);
    const page = await agent.get(`${URL}?term=${encodeURIComponent(TERM)}&version=1.0.0`);
    const session = /concord_report=([^;]+)/.exec([page.headers['set-cookie']].flat().join(';'))![1];
    const res = await agent
      .post(URL)
      .type('form')
      .send({ term: TERM, version: '1.0.0', token: reportToken({ slug: 'volunteering', term: TERM, version: '1.0.0', session }, Date.now() - 60_000), description: 'bad' });
    expect(res.status).toBe(400);
    expect(res.text).toContain('aria-invalid="true" aria-describedby="report-error"');
    expect(res.text).toContain('id="report-error"');
  });

  it('turns away bots, replays, forged and malformed tokens, other terms and other sites', async () => {
    const v = await visitor();
    const before = queued().length;
    // The honeypot looks like success but holds nothing.
    const bot = await v.send({ website: 'http://spam.example' });
    expect(bot.status).toBe(201);
    expect(queued().length).toBe(before);
    // No token, forged, used straight away, from yesterday, for another ontology, term, version or browser.
    expect((await v.send({ token: '' })).status).toBe(400);
    expect((await v.send({ token: `${Date.now() - 60_000}.${'a'.repeat(22)}.${'b'.repeat(43)}` })).status).toBe(400);
    expect((await v.send({ token: v.token({ at: Date.now() }) })).body.error).toMatch(/quick/);
    expect((await v.send({ token: v.token({ at: Date.now() - 25 * 60 * 60 * 1000 }) })).body.error).toMatch(/expired/);
    expect((await v.send({ token: v.token({ slug: 'another-ontology' }) })).status).toBe(400);
    expect((await v.send({ token: v.token({ term: OTHER }) })).status).toBe(400);
    expect((await v.send({ token: v.token({ version: 'draft' }) })).status).toBe(400);
    const stranger = await visitor();
    expect((await stranger.send({ token: v.token() })).status).toBe(400);
    // Malformed signatures are refused, not a server error.
    for (const bad of [`${Date.now() - 60_000}.${'a'.repeat(22)}.${'é'.repeat(43)}`, 'x.y.z', `${'9'.repeat(40)}.a.b`, 42]) expect((await v.send({ token: bad })).status, String(bad)).toBe(400);
    // A token works once.
    const once = v.token();
    expect((await v.send({ token: once })).status).toBe(201);
    expect((await v.send({ token: once })).status).toBe(400);
    // Too short, too many links, a term that isn't there: each says why, and hands over the next token.
    const short = await v.send({ description: 'bad' });
    expect(short.status).toBe(400);
    expect(short.body.field).toBe('description');
    expect(short.body.token).toMatch(/^\d+\.[\w-]{22}\.[\w-]{43}$/);
    expect((await v.send({ description: 'see https://a.example https://b.example https://c.example https://d.example' })).body.error).toMatch(/at most 3 links/);
    expect((await v.send({ term: `${NS}NoSuchTerm` })).status).toBe(400);
    // Posts from other sites.
    expect((await v.send().set('Sec-Fetch-Site', 'cross-site')).status).toBe(403);
    expect((await v.send().set('Origin', 'https://attacker.example')).status).toBe(403);
    expect((await request(app).post(URL).type('form').set('Origin', 'https://attacker.example').send({ term: TERM, token: v.token(), description: 'Cross-site form post.' })).status).toBe(403);
    // Without the browser's session cookie, a token is no good.
    expect((await request(app).post(URL).set('Accept', 'application/json').send({ term: TERM, version: '1.0.0', token: v.token(), description: 'No cookie, no report.' })).status).toBe(400);
    expect(queued().length).toBe(before + 1);
  });

  it('limits each visitor, counting an IPv6 network as one, then each ontology and the site per day', async () => {
    const a = await visitor('2001:db8:1:2::1');
    for (let i = 0; i < 5; i++) expect((await a.send()).status).toBe(201);
    const flood = await a.send();
    expect(flood.status).toBe(429);
    expect(flood.body.error).toMatch(/sign in as a member/);
    // Another address in the same network is the same visitor.
    const b = await visitor('2001:db8:1:2:ffff::9');
    expect((await b.send()).status).toBe(429);
    // A different network isn't.
    const c = await visitor('2001:db8:9:9::1');
    expect((await c.send()).status).toBe(201);
    // The daily allowance per ontology is stored, so a restart (cleared memory) doesn't reset it.
    for (let i = 0; i < 24; i++) expect((await (await visitor(`198.51.100.${i + 1}`)).send()).status).toBe(201);
    expect((await (await visitor('203.0.113.1')).send()).status).toBe(429);
    sweepReportMemory(Date.now() + 2 * 24 * 60 * 60 * 1000);
    expect((await (await visitor('203.0.113.2')).send()).status).toBe(429);
  });

  it('answers the same report twice as the first time, and never says what anyone else reported', async () => {
    const a = await visitor('192.0.2.10');
    const words = 'Exactly the same words twice over.';
    const first = await a.send({ description: words });
    expect(first.status).toBe(201);
    const again = await a.send({ description: 'Exactly   the same WORDS twice over.' });
    expect(again.status).toBe(201);
    expect(again.body.reference).toBe(first.body.reference);
    expect(queued().filter((r) => r.description.startsWith('Exactly')).length).toBe(1);
    // Someone else sending the same words, even about another term, is a report of their own.
    const b = await visitor('192.0.2.11');
    const theirs = await b.send({ description: words, term: OTHER });
    expect(theirs.status).toBe(201);
    expect(theirs.body.reference).not.toBe(first.body.reference);
  });

  it('forgets visitors and used tokens after a day', async () => {
    const v = await visitor('192.0.2.50');
    expect((await v.send()).status).toBe(201);
    expect(reportMemory().visitors).toBeGreaterThan(0);
    expect(reportMemory().tokens).toBeGreaterThan(0);
    sweepReportMemory(Date.now() + 25 * 60 * 60 * 1000);
    expect(reportMemory()).toEqual({ visitors: 0, tokens: 0, sent: 0 });
  });

  it('hands the dialog a fresh token for the term it opens on', async () => {
    const res = await request(app).get(`${URL}/token?term=${encodeURIComponent(TERM)}&version=1.0.0`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.token).toMatch(/^\d+\.[\w-]{22}\.[\w-]{43}$/);
    expect((await request(app).get(`${URL}/token`)).status).toBe(404);
  });

  it('turns public reporting off on a deployed site without a real secret', async () => {
    const saved = { url: process.env.NODE_ENV, report: process.env.REPORT_SECRET };
    const { config } = await import('../src/config.js');
    const secret = config.sessionSecret;
    try {
      process.env.NODE_ENV = 'production';
      delete process.env.REPORT_SECRET;
      (config as { sessionSecret: string }).sessionSecret = 'dev-only-secret-change-me';
      expect((await request(app).get(`${URL}/token?term=${encodeURIComponent(TERM)}`)).status).toBe(503);
      expect((await request(app).post(URL).send({ term: TERM })).status).toBe(503);
      process.env.REPORT_SECRET = 'a-long-random-secret-for-reports-only';
      expect((await request(app).get(`${URL}/token?term=${encodeURIComponent(TERM)}`)).status).toBe(200);
    } finally {
      process.env.NODE_ENV = saved.url;
      if (saved.report === undefined) delete process.env.REPORT_SECRET;
      else process.env.REPORT_SECRET = saved.report;
      (config as { sessionSecret: string }).sessionSecret = secret;
    }
  });
});

describe('public Browse', () => {
  it('lists every class, even ones in a cycle with no root', async () => {
    const project = findProject('volunteering')!;
    const owl = 'http://www.w3.org/2002/07/owl#Class';
    const sub = 'http://www.w3.org/2000/01/rdf-schema#subClassOf';
    const { ontologyStore } = await import('../src/services/ontologyStore.js');
    const working = await ontologyStore.working(project);
    const g = await OntologyGraph.fromTurtle(`${await working.toTurtle()}\n<${NS}CycleA> a <${owl}> ; <${sub}> <${NS}CycleB> .\n<${NS}CycleB> a <${owl}> ; <${sub}> <${NS}CycleA> .\n`);
    const input = await pageInput(project, 'draft', 'http://localhost', { graph: g });
    const html = renderOntologyPage(input);
    const nav = html.slice(html.indexOf('class="browse-nav'), html.indexOf('class="browse-main'));
    expect(nav).toContain('href="#CycleA"');
    expect(nav).toContain('href="#CycleB"');
    expect(nav).toMatch(/data-term="[^"]*cyclea/);
  });

  it('shows search only once the page script runs, with a live status for results', async () => {
    const html = (await request(app).get('/def/volunteering')).text;
    expect(html).toContain('<label class="search" hidden>');
    expect(html).toContain('role="status" aria-live="polite" data-search-status');
  });
});
