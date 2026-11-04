import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { list, openDb } from '../src/db.js';
import { seedDemo } from '../src/services/simulation.js';
import { reportToken, resetReportLimits } from '../src/public/report.js';
import type { ChangeRequest } from '@concord/shared';

const app = createApp();
const NS = 'https://w3id.org/odi/volunteering#';
const TERM = `${NS}VolunteeringOpportunity`;
const URL = '/def/volunteering/-/report';
// A form handed out a minute ago (people take more than a few seconds to write a report).
const token = () => reportToken('volunteering', Date.now() - 60_000);
let n = 0;
const report = (body: Record<string, unknown> = {}) =>
  request(app)
    .post(URL)
    .set('Accept', 'application/json')
    .send({ term: TERM, version: '1.0.0', token: token(), title: '', description: `The definition doesn't say whether internships count (${++n}).`, website: '', ...body });
const reports = () => list<ChangeRequest>('changeRequests').filter((c) => c.origin.type === 'public-report');

beforeAll(async () => {
  openDb();
  await seedDemo();
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

  it('serves a report page that works without JavaScript', async () => {
    const res = await request(app).get(`${URL}?term=${encodeURIComponent(TERM)}&version=1.0.0`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text).toContain('Report a problem with “volunteering opportunity”');
    expect(res.text).toContain('name="token" value="');
    expect(res.text).toContain('name="website"');
    expect(res.text).toContain('<meta name="robots" content="noindex">');
    expect(res.text).toContain(encodeURIComponent('/o/volunteering/browse?term='));
    expect((await request(app).get(`${URL}?term=${encodeURIComponent(`${NS}NoSuchTerm`)}`)).status).toBe(404);
    expect((await request(app).get('/def/nope/-/report?term=x')).status).toBe(404);
  });

  it('opens a bug report for the working group, with no drafted edits and nothing private in the reply', async () => {
    const res = await report({ title: 'Internships', description: 'The definition does not say whether unpaid internships count as volunteering.' });
    expect(res.status).toBe(201);
    expect(Object.keys(res.body)).toEqual(['reference']);
    const cr = reports().find((c) => c.id === res.body.reference)!;
    expect(cr.kind).toBe('bug');
    expect(cr.title).toBe('Internships');
    expect(cr.ops).toEqual([]);
    expect(cr.origin).toEqual({ type: 'public-report', termIri: TERM, version: '1.0.0' });
    expect(cr.description).toContain('unpaid internships');
    expect(cr.description).toContain(`<${TERM}>`);
    // The change request itself stays behind sign-in.
    expect((await request(app).get(`/api/change-requests/${cr.id}`)).status).toBe(401);
    const reader = request.agent(app);
    await reader.post('/api/auth/demo').send({ name: 'Group member', role: 'contributor' });
    const seen = (await reader.get(`/api/change-requests/${cr.id}`)).body;
    expect(seen.author?.name ?? seen.authorName ?? JSON.stringify(seen)).toContain('Member of the public');
  });

  it('accepts a plain form post and thanks the reporter', async () => {
    const res = await request(app)
      .post(URL)
      .type('form')
      .send({ term: TERM, version: '1.0.0', token: token(), title: '', description: 'Plain form: the label should be singular.', website: '' });
    expect(res.status).toBe(201);
    expect(res.type).toMatch(/html/);
    expect(res.text).toContain('Thanks for your report');
    expect(reports().some((c) => c.title === 'Problem with volunteering opportunity' && c.description.startsWith('Plain form'))).toBe(true);
  });

  it('turns away bots, replays, floods and junk', async () => {
    const before = reports().length;
    // The honeypot looks like success but creates nothing.
    const bot = await report({ website: 'http://spam.example' });
    expect(bot.status).toBe(201);
    expect(reports().length).toBe(before);
    // No token, a forged one, one used straight away, one from yesterday.
    expect((await report({ token: '' })).status).toBe(400);
    expect((await report({ token: `${Date.now() - 60_000}.forged` })).status).toBe(400);
    expect((await report({ token: reportToken('volunteering') })).body.error).toMatch(/quick/);
    expect((await report({ token: reportToken('volunteering', Date.now() - 25 * 60 * 60 * 1000) })).body.error).toMatch(/expired/);
    expect((await report({ token: reportToken('another-ontology', Date.now() - 60_000) })).status).toBe(400);
    // Too short, too many links, a term that isn't there.
    expect((await report({ description: 'bad' })).status).toBe(400);
    expect((await report({ description: 'see https://a.example https://b.example https://c.example https://d.example' })).body.error).toMatch(/at most 3 links/);
    expect((await report({ term: `${NS}NoSuchTerm` })).status).toBe(400);
    expect(reports().length).toBe(before);
    // The same report twice.
    expect((await report({ description: 'Exactly the same words twice over.' })).status).toBe(201);
    expect((await report({ description: 'Exactly   the same words twice over.' })).status).toBe(409);
    // Five from one visitor in ten minutes, then a pause.
    for (let i = 0; i < 4; i++) expect((await report()).status).toBe(201);
    const flood = await report();
    expect(flood.status).toBe(429);
    expect(flood.body.error).toMatch(/sign in as a member/);
  });

  it('hands the dialog a fresh token', async () => {
    const res = await request(app).get(`${URL}/token`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.token).toMatch(/^\d+\.[\w-]+$/);
  });
});
