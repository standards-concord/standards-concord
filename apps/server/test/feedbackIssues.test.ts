import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FeedbackSubmission } from '@concord/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { get, list, openDb, put, remove } from '../src/db.js';
import { dedupeKey, fileOutstandingFeedback, issueBody, issueTitle, markSwitchOn, redact, resetFeedbackIssueState } from '../src/services/feedbackIssues.js';

/** A stand-in for the GitHub issues API that records what it was sent. */
interface Received {
  path: string;
  auth?: string;
  body: { title: string; body: string; labels: string[] };
}
const received: Received[] = [];
let failNext = 0;
const stub = http.createServer((req, res) => {
  let data = '';
  req.on('data', (c) => (data += c));
  req.on('end', () => {
    if (failNext > 0) {
      failNext--;
      res.writeHead(502).end('{}');
      return;
    }
    received.push({ path: req.url ?? '', auth: req.headers.authorization, body: JSON.parse(data) });
    const number = received.length;
    res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({ number, html_url: `https://github.com/jeswr/standards-concord/issues/${number}` }));
  });
});

const app = createApp();
const original = { ...config.feedbackIssues };

beforeAll(async () => {
  openDb();
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
  config.feedbackIssues.apiUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
});
afterAll(() => {
  Object.assign(config.feedbackIssues, original);
  stub.close();
});
beforeEach(() => {
  received.length = 0;
  failNext = 0;
  resetFeedbackIssueState();
});

const enable = () => {
  config.feedbackIssues.token = 'test-token-not-real';
  config.feedbackIssues.repo = 'jeswr/standards-concord';
};

const sample = (over: Partial<FeedbackSubmission> = {}): FeedbackSubmission => ({
  id: 'fb_sample',
  pathway: 'structured',
  answers: {},
  transcript: [],
  usedVoice: false,
  createdAt: '2026-11-04T20:00:00.000Z',
  ...over,
});

describe('anonymising feedback', () => {
  it('removes emails, phone numbers, outside links, handles and the tester’s name', () => {
    const t = redact('I am Priya Shah, mail priya.shah@example.org or call +44 7700 900123. See https://evil.example/x and @priyas on GitHub. Priya again.', ['Priya Shah']);
    expect(t).not.toMatch(/Priya|Shah|example\.org|7700|evil\.example|@priyas/);
    expect(t).toContain('[email removed]');
    expect(t).toContain('[phone removed]');
    expect(t).toContain('[link removed]');
    expect(t).toContain('[name removed]');
  });

  it('keeps links to the app’s own pages but not to people’s WebIDs or pods', () => {
    const site = new URL(config.publicUrl).origin;
    const t = redact(`The page ${site}/o/volunteering/browse broke. My WebID is ${site}/webid/u_abc#me`);
    expect(t).toContain(`${site}/o/volunteering/browse`);
    expect(t).not.toContain('u_abc');
  });

  it('keeps version numbers and short numbers', () => {
    expect(redact('Version 1.2.3 took 45 seconds, 3 times')).toBe('Version 1.2.3 took 45 seconds, 3 times');
  });

  it('leaves out the name, email, account and transcript, and labels the answers with the questions', () => {
    const sub = sample({
      name: 'Morgan Lee',
      email: 'morgan@example.org',
      userId: 'u_secret',
      role: 'developer',
      answers: { missing: 'Morgan here: the export button did nothing', overall: 4, formats: ['Turtle', 'LinkML'] },
      transcript: [{ id: 'm1', role: 'user', content: 'transcript-only text', at: '2026-11-04T20:00:00Z' }],
    });
    const body = issueBody(sub);
    expect(body).toContain('<!-- concord-feedback: fb_sample -->');
    expect(body).toContain('What is missing or got in your way?');
    expect(body).toContain('Turtle; LinkML');
    expect(body).not.toMatch(/Morgan|morgan@|u_secret|transcript-only/);
    expect(issueTitle(sub)).toBe('Feedback: [name removed] here: the export button did nothing');
  });

  it('titles feedback with no free text by its pathway, and trims long titles', () => {
    expect(issueTitle(sample({ answers: { overall: 3 } }))).toBe('Feedback from a tester (questionnaire)');
    const long = issueTitle(sample({ answers: { general: 'x'.repeat(300) } }));
    expect(long.length).toBeLessThanOrEqual('Feedback: '.length + 100);
  });

  it('treats the same answers as the same feedback', () => {
    expect(dedupeKey(sample({ id: 'a', answers: { missing: 'Search  is slow' } }))).toBe(dedupeKey(sample({ id: 'b', answers: { missing: 'search is slow' } })));
    expect(dedupeKey(sample({ answers: { missing: 'a' } }))).not.toBe(dedupeKey(sample({ answers: { missing: 'b' } })));
  });
});

describe('filing feedback as GitHub issues', () => {
  it('files nothing when no token is set', async () => {
    config.feedbackIssues.token = undefined;
    const res = await request(app).post('/api/feedback').send({ pathway: 'general', answers: { general: 'No token, no issue' } });
    expect(res.status).toBe(201);
    expect(res.body.githubIssue).toBeUndefined();
    expect(received).toHaveLength(0);
  });

  it('opens one labelled, anonymised issue per submission and tells the tester its number', async () => {
    enable();
    const agent = request.agent(app);
    await agent.post('/api/auth/demo').send({ name: 'Alex Rivera', role: 'member' });
    const res = await agent.post('/api/feedback').send({
      pathway: 'structured',
      name: 'Alex Rivera',
      email: 'alex@example.org',
      role: 'member',
      answers: { missing: 'Alex thinks the diff view needs colours', overall: 5 },
      transcript: [{ id: 'm', role: 'user', content: 'secret transcript', at: '2026-11-04T20:00:00Z' }],
    });
    expect(res.status).toBe(201);
    expect(res.body.githubIssue).toEqual({ number: 1, url: 'https://github.com/jeswr/standards-concord/issues/1' });
    expect(received).toHaveLength(1);
    const [r] = received;
    expect(r.path).toBe('/repos/jeswr/standards-concord/issues');
    expect(r.auth).toBe('Bearer test-token-not-real');
    expect(r.body.labels).toEqual(['feedback', 'needs-triage']);
    expect(r.body.title).toBe('Feedback: [name removed] thinks the diff view needs colours');
    expect(JSON.stringify(r.body)).not.toMatch(/Alex|Rivera|alex@|secret transcript/);
    // The stored submission remembers its issue, so it is never filed twice.
    expect(get<FeedbackSubmission>('feedback', res.body.id)?.githubIssue?.number).toBe(1);
    expect(await fileOutstandingFeedback()).toBe(0);
    expect(received).toHaveLength(1);
  });

  it('links a resubmission of the same answers to the existing issue', async () => {
    enable();
    const answers = { general: 'Double-submitted: the vote button is hidden on mobile' };
    const first = await request(app).post('/api/feedback').send({ pathway: 'general', answers });
    const second = await request(app).post('/api/feedback').send({ pathway: 'general', answers });
    expect(received).toHaveLength(1);
    expect(second.body.githubIssue).toEqual(first.body.githubIssue);
  });

  it('skips empty feedback', async () => {
    enable();
    const res = await request(app).post('/api/feedback').send({ pathway: 'structured', answers: { comments: '(skipped)' } });
    expect(res.status).toBe(201);
    expect(received).toHaveLength(0);
  });

  it('retries later when GitHub fails, without failing the tester’s submission', async () => {
    enable();
    failNext = 1;
    const res = await request(app).post('/api/feedback').send({ pathway: 'general', answers: { general: 'GitHub was down when I sent this' } });
    expect(res.status).toBe(201);
    expect(res.body.githubIssue).toBeUndefined();
    expect(await fileOutstandingFeedback()).toBe(1);
    expect(received.map((r) => r.body.title)).toEqual(['Feedback: GitHub was down when I sent this']);
  });

  it('holds back issues beyond the hourly cap and files them once the cap allows', async () => {
    enable();
    config.feedbackIssues.perHour = 1;
    try {
      await request(app).post('/api/feedback').send({ pathway: 'general', answers: { general: 'cap one' } });
      const held = await request(app).post('/api/feedback').send({ pathway: 'general', answers: { general: 'cap two' } });
      expect(held.body.githubIssue).toBeUndefined();
      expect(received).toHaveLength(1);
      resetFeedbackIssueState(); // a new hour
      expect(await fileOutstandingFeedback()).toBe(1);
      expect(received.map((r) => r.body.title)).toEqual(['Feedback: cap one', 'Feedback: cap two']);
    } finally {
      config.feedbackIssues.perHour = original.perHour;
    }
  });

  it('does not file feedback stored before the token was set, unless backfill is on', async () => {
    // Stored while issues were off, then the token is set and the server starts.
    config.feedbackIssues.token = undefined;
    put('feedback', sample({ id: 'fb_old', answers: { general: 'Given before issues existed' } }));
    remove('kv', 'feedback-issues:preexisting');
    enable();
    markSwitchOn();
    await fileOutstandingFeedback();
    expect(received.find((r) => r.body.body.includes('fb_old'))).toBeUndefined();
    // With backfill, a fresh switch-on point files it.
    remove('kv', 'feedback-issues:preexisting');
    config.feedbackIssues.backfill = true;
    try {
      await fileOutstandingFeedback();
      expect(received.filter((r) => r.body.body.includes('concord-feedback: fb_old'))).toHaveLength(1);
    } finally {
      config.feedbackIssues.backfill = original.backfill;
    }
    expect(list<FeedbackSubmission>('feedback').find((s) => s.id === 'fb_old')?.githubIssue).toBeDefined();
  });

  it('never logs the token when GitHub refuses it', async () => {
    enable();
    const warn = console.warn;
    const lines: string[] = [];
    console.warn = (...a: unknown[]) => void lines.push(a.join(' '));
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error(`bad credentials test-token-not-real`);
    }) as typeof fetch;
    try {
      await request(app).post('/api/feedback').send({ pathway: 'general', answers: { general: 'token leak check' } });
    } finally {
      globalThis.fetch = realFetch;
      console.warn = warn;
    }
    expect(lines.join('\n')).toContain('could not open a GitHub issue');
    expect(lines.join('\n')).not.toContain('test-token-not-real');
  });
});
