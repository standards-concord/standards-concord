import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { publicSummary } from '@concord/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { get, list, openDb, remove } from '../src/db.js';
import { issueBody, MAX_ATTEMPTS, processOutstanding, processPublication, publicationFor, retryPublication, setNow, type Publication } from '../src/services/feedbackIssues.js';

/**
 * A stand-in for GitHub's issues API. `next` queues one-off behaviours for the
 * next POST: an error status (with headers), or "create the issue but drop the
 * connection" (an answer lost in transit).
 */
interface StubIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  state: string;
  auth?: string;
}
type Behaviour = { status: number; headers?: Record<string, string> } | 'drop-after-create';
const issues: StubIssue[] = [];
const next: Behaviour[] = [];
let posts = 0;
const stub = http.createServer((req, res) => {
  let data = '';
  req.on('data', (c) => (data += c));
  req.on('end', () => {
    const url = new URL(req.url ?? '/', 'http://stub');
    if (req.method === 'GET' && url.pathname === '/repos/jeswr/standards-concord/issues') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(issues.map((i) => ({ number: i.number, html_url: `https://github.com/x/${i.number}`, body: i.body }))));
      return;
    }
    const patch = url.pathname.match(/^\/repos\/jeswr\/standards-concord\/issues\/(\d+)$/);
    if (req.method === 'PATCH' && patch) {
      Object.assign(issues[Number(patch[1]) - 1], JSON.parse(data));
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      return;
    }
    if (req.method !== 'POST' || url.pathname !== '/repos/jeswr/standards-concord/issues') return void res.writeHead(404).end('{}');
    posts++;
    const b = next.shift();
    if (b && b !== 'drop-after-create') return void res.writeHead(b.status, b.headers).end('{}');
    const body = JSON.parse(data);
    const number = issues.length + 1;
    issues.push({ number, state: 'open', auth: req.headers.authorization, ...body });
    if (b === 'drop-after-create') return void req.socket.destroy();
    res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({ number, html_url: `https://github.com/jeswr/standards-concord/issues/${number}` }));
  });
});

const app = createApp();
const original = { ...config.feedbackIssues };
let t = Date.parse('2026-11-04T21:00:00Z');
const HOUR = 60 * 60_000;

beforeAll(async () => {
  openDb();
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
  config.feedbackIssues.apiUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
});
afterAll(() => {
  Object.assign(config.feedbackIssues, original);
  setNow();
  stub.close();
});
beforeEach(() => {
  issues.length = 0;
  next.length = 0;
  posts = 0;
  config.feedbackIssues.token = 'test-token-not-real';
  config.feedbackIssues.repo = 'jeswr/standards-concord';
  config.feedbackIssues.perHour = 30;
  // Each test starts in a fresh hour, with the queue empty.
  t += 10 * HOUR;
  setNow(() => t);
  for (const p of list<Publication>('feedbackPublications')) remove('feedbackPublications', p.id);
});

let seq = 0;
const submit = (summary?: string, extra: Record<string, unknown> = {}) =>
  request(app)
    .post('/api/feedback')
    .send({ pathway: 'general', answers: { general: `Private answer ${++seq}: I am Morgan Lee at Northmere Hospice` }, name: 'Morgan Lee', email: 'morgan@example.org', role: 'member', ...(summary === undefined ? {} : { publish: { summary } }), ...extra });

describe('the public summary text', () => {
  it('removes links in every form, email addresses and handles, after normalising Unicode', () => {
    const out = publicSummary(
      'Mail morgan@example.org, morgan＠example.org or morgan [at] example. See https://x.y/a, //evil.example/b, www.foo.com, pods.example.org/alice/private.ttl and /people/u_7a9f/private/interview.txt. cc @priyas',
    );
    expect(out).not.toMatch(/morgan|example|evil|foo\.com|alice|u_7a9f|priyas/);
    expect(out).toContain('[email removed]');
    expect(out).toContain('[link removed]');
    expect(out).toContain('[handle removed]');
  });

  it('keeps ordinary text, page names and version numbers, and caps the length', () => {
    expect(publicSummary('Search on the Browse page is slow in 1.2.3')).toBe('Search on the Browse page is slow in 1.2.3');
    expect(publicSummary('x'.repeat(2000)).length).toBe(500);
  });

  it('escapes Markdown in the issue so the summary cannot add links, mentions or headings', () => {
    const body = issueBody({ id: 'pub_x', summary: '# Heading [click](javascript:alert) <img> **bold**' });
    expect(body).toContain('\\# Heading \\[click\\]\\(javascript:alert\\) \\<img\\> \\*\\*bold\\*\\*');
  });
});

describe('opting in', () => {
  it('posts nothing without the tester’s opt-in', async () => {
    const res = await submit();
    expect(res.status).toBe(201);
    expect(res.body.publication).toBeUndefined();
    await processOutstanding();
    expect(posts).toBe(0);
  });

  it('refuses to post when the option is switched off, before storing anything', async () => {
    config.feedbackIssues.token = undefined;
    expect((await request(app).get('/api/feedback/publishing')).body.enabled).toBe(false);
    const before = list('feedback').length;
    const res = await submit('The diff view needs colours');
    expect(res.status).toBe(409);
    expect(list('feedback').length).toBe(before);
  });

  it('refuses a summary that is not exactly what the preview showed', async () => {
    const res = await submit('Email me at morgan@example.org');
    expect(res.status).toBe(400);
    expect(posts).toBe(0);
  });

  it('posts only the summary, with a random publication id and none of the answers or metadata', async () => {
    expect((await request(app).get('/api/feedback/publishing')).body.enabled).toBe(true);
    const res = await submit('The diff view needs colours');
    expect(res.status).toBe(201);
    expect(res.body.publication).toMatchObject({ state: 'filed', issue: { number: 1 } });
    expect(res.body.publication.withdrawToken).toMatch(/^[\w-]{20,}$/);
    const [issue] = issues;
    expect(issue.auth).toBe('Bearer test-token-not-real');
    expect(issue.labels).toEqual(['feedback', 'needs-triage']);
    expect(issue.title).toBe('Feedback: The diff view needs colours');
    const published = `${issue.title}\n${issue.body}`;
    expect(published).toContain('> The diff view needs colours');
    expect(published).not.toContain(res.body.id);
    expect(published).toMatch(/concord-feedback-publication: pub_/);
    expect(published).not.toMatch(/Morgan|Northmere|example\.org|member|general|Private answer|2026/);
  });
});

describe('delivery', () => {
  it('files identical summaries sent at the same moment as one issue', async () => {
    const [a, b] = await Promise.all([submit('Voting is hidden on mobile'), submit('voting is hidden  on mobile'.replace('  ', ' '))]);
    expect(posts).toBe(1);
    const states = [a.body.publication.state, b.body.publication.state].sort();
    expect(states).toEqual(['duplicate', 'filed']);
    expect(a.body.publication.issue).toEqual(b.body.publication.issue);
  });

  it('holds summaries past the hourly cap and posts them as the rolling hour frees up, without a restart', async () => {
    config.feedbackIssues.perHour = 1;
    await submit('Cap one');
    t += 30 * 60_000;
    const held = await submit('Cap two');
    expect(held.body.publication.state).toBe('queued');
    expect(posts).toBe(1);
    t += 20 * 60_000; // 50 minutes after the first: still inside its hour
    await processOutstanding();
    expect(posts).toBe(1);
    t += 11 * 60_000; // the first slot has left the window
    await processOutstanding();
    expect(issues.map((i) => i.title)).toEqual(['Feedback: Cap one', 'Feedback: Cap two']);
  });

  it('keeps the cap in the database, so it holds across processes and restarts', async () => {
    config.feedbackIssues.perHour = 1;
    await submit('Cap shared one');
    const rate = get<{ value: number[] }>('kv', 'feedback-issues:rate:jeswr/standards-concord');
    expect(rate?.value).toHaveLength(1);
    await submit('Cap shared two');
    expect(posts).toBe(1);
  });

  it('honours Retry-After by pausing the whole queue', async () => {
    next.push({ status: 429, headers: { 'retry-after': '3600' } });
    const first = await submit('Rate limited one');
    expect(first.body.publication.state).toBe('queued');
    await submit('Rate limited two');
    t += 30 * 60_000;
    await processOutstanding();
    expect(posts).toBe(1); // only the 429
    t += 31 * 60_000;
    await processOutstanding();
    expect(issues.map((i) => i.title).sort()).toEqual(['Feedback: Rate limited one', 'Feedback: Rate limited two']);
  });

  it('honours the rate-limit reset time on a 403', async () => {
    next.push({ status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.ceil((t + 2 * HOUR) / 1000)) } });
    await submit('Secondary limit');
    t += HOUR;
    await processOutstanding();
    expect(posts).toBe(1);
    t += HOUR + 1000;
    await processOutstanding();
    expect(issues).toHaveLength(1);
  });

  it('finds the issue instead of posting again when GitHub’s answer was lost', async () => {
    next.push('drop-after-create');
    const res = await submit('Lost answer');
    expect(res.body.publication.state).toBe('unknown');
    expect(issues).toHaveLength(1);
    t += HOUR;
    await processOutstanding();
    expect(posts).toBe(1);
    expect(publicationFor(res.body.id).state).toBe('filed');
    expect(publicationFor(res.body.id).issue?.number).toBe(1);
  });

  it('reconciles a send that crashed mid-flight once its lease runs out', async () => {
    next.push('drop-after-create');
    const res = await submit('Crashed mid-send');
    // Simulate the crash: the job is stuck as sending.
    const pub = publicationFor(res.body.id);
    const { put } = await import('../src/db.js');
    put('feedbackPublications', { ...pub, state: 'sending', leaseUntil: t + 60_000 }, pub.feedbackId);
    await processOutstanding();
    expect(publicationFor(res.body.id).state).toBe('sending'); // lease still held
    t += HOUR;
    await processOutstanding();
    expect(publicationFor(res.body.id).state).toBe('filed');
    expect(posts).toBe(1);
  });

  it('backs off, gives up after repeated failures, and an administrator can retry', async () => {
    for (let i = 0; i < MAX_ATTEMPTS; i++) next.push({ status: 422 });
    const res = await submit('Keeps failing');
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      t += 7 * HOUR;
      await processOutstanding();
    }
    const pub = publicationFor(res.body.id);
    expect(pub.state).toBe('failed');
    expect(posts).toBe(MAX_ATTEMPTS);
    retryPublication(pub.id);
    await processPublication(pub.id);
    expect(publicationFor(res.body.id).state).toBe('filed');
  });

  it('never posts a summary whose feedback was deleted, and never recreates the feedback', async () => {
    config.feedbackIssues.perHour = 1;
    await submit('Fills the cap');
    const res = await submit('Deleted before posting');
    remove('feedback', res.body.id);
    t += 2 * HOUR;
    await processOutstanding();
    expect(issues).toHaveLength(1);
    expect(get('feedback', res.body.id)).toBeUndefined();
    expect(publicationFor(res.body.id).state).toBe('withdrawn');
  });

  it('never logs the token', async () => {
    const warn = console.warn;
    const lines: string[] = [];
    console.warn = (...a: unknown[]) => void lines.push(a.join(' '));
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error('bad credentials test-token-not-real');
    }) as typeof fetch;
    try {
      await submit('Token leak check');
    } finally {
      globalThis.fetch = realFetch;
      console.warn = warn;
    }
    expect(lines.join('\n')).toContain('could not post');
    expect(lines.join('\n')).not.toContain('test-token-not-real');
  });
});

describe('withdrawing', () => {
  it('needs the token from the submission', async () => {
    const res = await submit('Withdraw needs token');
    const bad = await request(app).post(`/api/feedback/${res.body.id}/publication/withdraw`).send({ token: 'guess' });
    expect(bad.status).toBe(403);
  });

  it('stops a queued summary from ever being posted', async () => {
    config.feedbackIssues.perHour = 1;
    await submit('Fills the cap too');
    const res = await submit('Changed my mind');
    const w = await request(app).post(`/api/feedback/${res.body.id}/publication/withdraw`).send({ token: res.body.publication.withdrawToken });
    expect(w.body.state).toBe('withdrawn');
    t += 2 * HOUR;
    await processOutstanding();
    expect(issues.map((i) => i.title)).toEqual(['Feedback: Fills the cap too']);
  });

  it('replaces a posted summary and closes its issue', async () => {
    const res = await submit('Posted then withdrawn');
    expect(res.body.publication.state).toBe('filed');
    const w = await request(app).post(`/api/feedback/${res.body.id}/publication/withdraw`).send({ token: res.body.publication.withdrawToken });
    expect(w.body.state).toBe('withdrawn');
    expect(issues[0]).toMatchObject({ title: 'Withdrawn feedback', body: 'The tester withdrew this feedback.', state: 'closed' });
  });

  it('retracts the issue when the withdrawal arrives while the outcome is unknown', async () => {
    next.push('drop-after-create');
    const res = await submit('Withdrawn while unknown');
    expect(res.body.publication.state).toBe('unknown');
    const w = await request(app).post(`/api/feedback/${res.body.id}/publication/withdraw`).send({ token: res.body.publication.withdrawToken });
    expect(w.body.state).toBe('withdrawn');
    expect(issues[0].state).toBe('closed');
    expect(posts).toBe(1);
  });
});
