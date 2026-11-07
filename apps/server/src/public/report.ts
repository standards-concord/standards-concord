import crypto from 'node:crypto';
import express, { Router, type Request, type Response } from 'express';
import { ipKeyGenerator } from 'express-rate-limit';
import type { TermView } from '@concord/core/types';
import type { OntologyProject, PublicReport } from '@concord/shared';
import { clock } from '../clock.js';
import { config } from '../config.js';
import { get, HttpError, insertOnce, list, put, remove, removeWhereAtMost, transaction } from '../db.js';
import { newId } from '../ids.js';
import { clientIp } from '../oauth.js';
import { findProject } from '../services/ontologies.js';
import { ontologyStore } from '../services/ontologyStore.js';
import { isHeld, readOntology } from './holds.js';
import { escapeHtml as esc } from './markdown.js';
import { PAGE_CSS } from './assets.js';
import { PUBLIC_BASE } from './w3id.js';
import { memberReportUrl, REPORT_LIMITS, reportChoices, type FormState } from './reportForm.js';

/**
 * "Report a problem with this term" from the public ontology page.
 *
 * Two ways in: a member signs in and reports from the app (Browse opens its
 * report dialog), or anyone reports as a member of the public, here.
 *
 * Public reports are held for review (PublicReport): only editors, stewards
 * and owners see them, as plain text, and nothing else happens (no change
 * request, activity or AI triage) until one of them opens a report as a bug.
 *
 * Anti-abuse:
 *   - a form token signed for this ontology, term, version and an anonymous
 *     browser session (a SameSite=Strict cookie), usable once (recorded in
 *     the database, so a restart doesn't make it usable again), from 3
 *     seconds to 2 hours after it was issued; cross-site posts are refused;
 *   - a limit on attempts per visitor, checked before anything else, so
 *     rejected posts are limited and cleaned up too;
 *   - a honeypot field, a cap on links, limits on length;
 *   - rate limits per visitor (by IPv6 /56 or IPv4 address, pseudonymised
 *     with a key of its own and kept in memory for a day at most), and per
 *     ontology and overall per day (stored, so a restart doesn't reset them);
 *   - sending the same report twice from one browser is answered as before,
 *     so nothing reveals what anyone else reported.
 * Nothing private is returned: the reply is a thank-you with an opaque
 * reference. Public reporting needs its own secret (REPORT_SECRET, at least
 * 32 characters); without one it is switched off rather than run with a key
 * anyone could know. Only the test suite runs with a built-in key.
 */

const TOKEN_MIN_AGE_MS = 3_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const TOKEN_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const VISITOR = {
  short: { ms: 10 * 60 * 1000, max: 5 },
  day: { ms: DAY_MS, max: 10 },
};
/** Posts of any kind, accepted or not: enough to fix a few mistakes, not to flood. */
const ATTEMPTS = { ms: 10 * 60 * 1000, max: 30 };
const DAILY = { ontology: 30, all: 300 };
const SESSION_COOKIE = 'concord_report';
const TEST_SECRET = 'concord test suite: public reports';
const MIN_SECRET = 32;

/* ------------------------------- secrets ------------------------------- */

/**
 * The secret reports are keyed from: REPORT_SECRET, which must be set and
 * strong. Nothing is guessed from the site's address, and the session secret
 * is never borrowed. The test suite (NODE_ENV=test) alone has a built-in key.
 */
function baseSecret(): string | undefined {
  const secret = process.env.REPORT_SECRET;
  if (secret) return secret.length >= MIN_SECRET && secret !== config.sessionSecret ? secret : undefined;
  return process.env.NODE_ENV === 'test' ? TEST_SECRET : undefined;
}
/** A key for one purpose: signing form tokens and pseudonymising addresses never share one. */
const keyFor = (purpose: 'sign' | 'visitor' | 'duplicate') => {
  const secret = baseSecret();
  return secret ? crypto.createHmac('sha256', secret).update(`concord public reports: ${purpose}`).digest() : undefined;
};
export const publicReportsEnabled = () => !!baseSecret();

/* -------------------------------- tokens -------------------------------- */

interface TokenScope {
  slug: string;
  term: string;
  version: string;
  session: string;
}

const signature = (scope: TokenScope, ts: string, nonce: string) =>
  crypto.createHmac('sha256', keyFor('sign')!).update([scope.slug, scope.term, scope.version, scope.session, ts, nonce].join('\n')).digest();

/** A form token for one term, version and browser session. */
export function reportToken(scope: TokenScope, now = Date.now()): string {
  const nonce = crypto.randomBytes(16).toString('base64url');
  return `${now}.${nonce}.${signature(scope, String(now), nonce).toString('base64url')}`;
}

const TOKEN_FORMAT = /^(\d{10,16})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;

/** Records a token's nonce as used, in one statement: false if it was used before (by this process or any other, before or after a restart). */
const consume = async (nonce: string, until: number) => await insertOnce('reportNonces', { id: nonce, until }, 'nonce');

const EXPIRED = 'This form has expired. Reload the page and try again.';
async function tokenProblem(scope: TokenScope, token: unknown, now = Date.now()): Promise<string | undefined> {
  const m = typeof token === 'string' ? TOKEN_FORMAT.exec(token) : null;
  if (!m || !scope.session) return EXPIRED;
  const [, ts, nonce, sig] = m;
  const given = Buffer.from(sig, 'base64url');
  const expected = signature(scope, ts, nonce);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return EXPIRED;
  const issued = Number(ts);
  if (now - issued > TOKEN_MAX_AGE_MS || issued - now > 60_000) return EXPIRED;
  if (now - issued < TOKEN_MIN_AGE_MS) return 'That was quick. Please check your report and send it again.';
  // Each token is good for one try.
  if (!await consume(nonce, issued + TOKEN_MAX_AGE_MS)) return EXPIRED;
  return undefined;
}

/* ------------------------------ rate limits ------------------------------ */

/*
 * Kept in the database, not this process, so every server (or function instance) counts the same posts: each
 * visitor's recent posts (`report-hits:v:…`), each one's attempts (`report-hits:a:…`), and recent reports for
 * answering a duplicate (`report-sent:…`). Each row says when it is no longer needed, and is swept then.
 */
const LIMITS = 'report-limits';
interface Hits {
  id: string;
  ts: number[];
  reportHitsUntil: number;
}
interface Sent {
  id: string;
  reference: string;
  reportSentUntil: number;
}
const hitsId = (kind: 'v' | 'a', who: string) => `report-hits:${kind}:${crypto.createHash('sha256').update(who).digest('base64url')}`;
let lastSweep = 0;

/** Forgets what no limit needs any more. */
async function sweep(now = Date.now(), force = false) {
  if (!force && now - lastSweep < 60_000) return;
  lastSweep = now;
  await removeWhereAtMost('reportNonces', 'until', now);
  await removeWhereAtMost('kv', 'reportHitsUntil', now);
  await removeWhereAtMost('kv', 'reportSentUntil', now);
}

/** For tests: clears every limit, and what was remembered about past reports. */
export async function resetReportLimits() { return transaction(async () => {
  await removeWhereAtMost('kv', 'reportHitsUntil', Number.MAX_SAFE_INTEGER);
  await removeWhereAtMost('kv', 'reportSentUntil', Number.MAX_SAFE_INTEGER);
  lastSweep = 0;
  await removeWhereAtMost('reportNonces', 'until', Number.MAX_SAFE_INTEGER);
  for (const d of [0, 1]) await remove('kv', dailyKey(Date.now() - d * DAY_MS));
}); }
/** For tests: how many visitors and tokens are remembered. */
export const reportMemory = async () => {
  const rows = await list<{ id: string }>('kv', LIMITS);
  const count = (prefix: string) => rows.filter((r) => r.id.startsWith(prefix)).length;
  return { visitors: count('report-hits:v:'), attempts: count('report-hits:a:'), tokens: (await list('reportNonces', 'nonce')).length, sent: count('report-sent:') };
};
export const sweepReportMemory = async (now: number) => await sweep(now, true);

/** Counts a post in `who`'s window unless `full` says the window is full: in one transaction, so posts to two servers at once can't both take the last place. */
async function counted(id: string, now: number, keepMs: number, full: (ts: number[]) => boolean): Promise<boolean> {
  return await transaction(async () => {
    const ts = ((await get<Hits>('kv', id))?.ts ?? []).filter((t) => now - t < keepMs);
    if (full(ts)) return false;
    await put<Hits>('kv', { id, ts: [...ts, now], reportHitsUntil: now + keepMs }, LIMITS);
    return true;
  });
}

async function visitorLimited(who: string, now: number): Promise<boolean> {
  return !(await counted(hitsId('v', who), now, DAY_MS, (ts) => ts.filter((t) => now - t < VISITOR.short.ms).length >= VISITOR.short.max || ts.length >= VISITOR.day.max));
}

/** Every post counts here, before it is checked at all. */
async function attemptsLimited(who: string, now: number): Promise<boolean> {
  return !(await counted(hitsId('a', who), now, ATTEMPTS.ms, (ts) => ts.length >= ATTEMPTS.max));
}

interface DailyCounts {
  id: string;
  all: number;
  byOntology: Record<string, number>;
}
const dailyKey = (now: number) => `public-report-counts:${new Date(now).toISOString().slice(0, 10)}`;
/** Per ontology and overall, per day, stored so a restart doesn't reset them. */
async function dailyLimited(ontologyId: string, now: number): Promise<boolean> { return transaction(async () => {
  const counts = await get<DailyCounts>('kv', dailyKey(now)) ?? { id: dailyKey(now), all: 0, byOntology: {} };
  if (counts.all >= DAILY.all || (counts.byOntology[ontologyId] ?? 0) >= DAILY.ontology) return true;
  counts.all++;
  counts.byOntology[ontologyId] = (counts.byOntology[ontologyId] ?? 0) + 1;
  await put('kv', counts);
  await remove('kv', dailyKey(now - 2 * DAY_MS));
  return false;
}); }

/** A visitor, by network (an IPv6 /56, as the sign-in limits do) and pseudonymised with its own key. */
const visitor = (req: Request) => crypto.createHmac('sha256', keyFor('visitor')!).update(ipKeyGenerator(clientIp(req))).digest('base64url').slice(0, 22);

/* -------------------------- the browser session -------------------------- */

/** The anonymous browser session tokens are bound to: a random id in a SameSite=Strict cookie, never linked to anything else. */
function browserSession(req: Request, res: Response): string {
  const existing = req.cookies?.[SESSION_COOKIE];
  if (typeof existing === 'string' && /^[A-Za-z0-9_-]{22}$/.test(existing)) return existing;
  const id = crypto.randomBytes(16).toString('base64url');
  res.cookie(SESSION_COOKIE, id, { httpOnly: true, sameSite: 'strict', secure: config.publicUrl.startsWith('https://'), maxAge: DAY_MS, path: PUBLIC_BASE });
  return id;
}

/** Refuses posts from other sites. */
function crossSite(req: Request): boolean {
  const site = req.get('sec-fetch-site');
  if (site) return site !== 'same-origin' && site !== 'none';
  const from = req.get('origin');
  if (!from) return false;
  const allowed = new Set([config.publicUrl, config.webUrl, `${req.protocol}://${req.host}`].map((u) => u.replace(/\/$/, '')));
  return !allowed.has(from);
}

/* ------------------------------- the form ------------------------------- */

const KIND: Record<TermView['kind'], string> = { class: 'Class', objectProperty: 'Object property', datatypeProperty: 'Datatype property', annotationProperty: 'Annotation property', individual: 'Individual' };
const nameOf = (t: TermView) => t.label?.trim() || t.iri.replace(/^.*[#/]/, '') || t.iri;


function page(title: string, body: string) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>${PAGE_CSS}</style>
</head>
<body>
<main class="wrap report-page">${body}</main>
</body>
</html>`;
}

function reportPage(req: Request, project: OntologyProject, version: string, term: TermView, token: string, state: FormState = {}) {
  const base = siteOrigin(req);
  const root = `${base}${PUBLIC_BASE}/${encodeURIComponent(project.slug)}`;
  const back = `${root}/${version === 'draft' ? 'draft' : version}`;
  const name = nameOf(term);
  return page(
    `Report a problem with ${name}`,
    `<p class="crumbs"><a href="${esc(back)}">${esc(project.title)}</a> <span aria-hidden="true">/</span> Report a problem</p>
<h1>Report a problem with “${esc(name)}”</h1>
<div class="term report-term">
  <div class="term-head"><h2>${esc(name)}</h2><span class="kind kind-${term.kind}">${KIND[term.kind]}</span></div>
  <p class="iri"><code>${esc(term.iri)}</code></p>
  ${term.definition ? `<p class="definition">${esc(term.definition)}</p>` : '<p class="definition warn-text">No definition yet.</p>'}
</div>
${reportChoices({ action: `${root}/-/report`, iri: term.iri, version, memberUrl: memberReportUrl(base, project.slug, term.iri), token, state })}
<p><a href="${esc(back)}">Back to the specification</a></p>`,
  );
}

function thanksPage(req: Request, project: OntologyProject, version: string, reference: string) {
  const back = `${siteOrigin(req)}${PUBLIC_BASE}/${encodeURIComponent(project.slug)}/${version === 'draft' ? 'draft' : version}`;
  return page(
    'Thanks for your report',
    `<h1>Thanks for your report</h1>
<p>Someone from the ${esc(project.title)} working group will review it.</p>
<p class="muted">Reference: <code>${esc(reference)}</code></p>
<p><a href="${esc(back)}">Back to the specification</a></p>`,
  );
}

/* ------------------------------- handling ------------------------------- */

function siteOrigin(req: Request) {
  return process.env.PUBLIC_URL ? config.publicUrl : `${req.protocol}://${req.host}`;
}

/**
 * The term a report is about, in the version it was sent from, read as the
 * public reads it. A version that's named must be published (not waiting for
 * approval) and have the term: a report is never quietly moved to another
 * version. Only when no version is named is it the working draft.
 */
async function findTerm(project: OntologyProject, version: string | undefined, iri: string): Promise<{ term: TermView; version: string } | undefined> {
  const ref = version ?? 'draft';
  if (ref !== 'draft' && !(await ontologyStore.versions(project)).includes(ref)) return undefined;
  if (await isHeld(project, ref)) return undefined;
  try {
    const term = (await readOntology(project, ref, undefined)).term(iri);
    return term ? { term, version: ref } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The version a report names. Absent means the working draft; anything sent
 * that isn't a single plausible version string (too long, repeated, a list,
 * empty) is invalid rather than "no version", so it's refused, never the draft.
 */
const versionParam = (v: unknown): { version?: string } | undefined => {
  if (v === undefined) return {};
  return typeof v === 'string' && v.length > 0 && v.length <= 40 ? { version: v } : undefined;
};
/** An identifier (a term IRI, a version) exactly as sent: IRIs are compared code point for code point, so nothing is normalised. */
const exact = (v: unknown, max: number) => (typeof v === 'string' && v.length <= max ? v : '');
/** Text a person wrote, without control characters, trimmed. The description is also NFKC-normalised (see submit). */
const clean = (v: unknown, max: number, nfkc = false) =>
  typeof v === 'string'
    ? (nfkc ? v.normalize('NFKC') : v)
        // Control characters other than newlines and tabs, and bidi overrides.
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‪-‮⁦-⁩]/g, '')
        .trim()
        .slice(0, max)
    : '';

class ReportError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function submit(req: Request, res: Response, project: OntologyProject) {
  const now = Date.now();
  // Before anything else, so posts that fail a check below are cleaned up after and limited too.
  await sweep(now);
  const who = visitor(req);
  if (await attemptsLimited(who, now)) throw new ReportError(429, 'Too many tries for now. Please try again later, or sign in as a member.');
  const b = (req.body ?? {}) as Record<string, unknown>;
  const iri = exact(b.term, 2000);
  const v = versionParam(b.version);
  const found = iri && v ? await findTerm(project, v.version, iri) : undefined;
  if (!found) throw new ReportError(400, 'That term isn’t in this version of the ontology, or that version isn’t published.');
  const session = browserSession(req, res);
  const scope = { slug: project.slug, term: found.term.iri, version: found.version, session };
  const fields = { title: clean(b.title, REPORT_LIMITS.title), description: clean(b.description, REPORT_LIMITS.description + 1, true) };
  const fail = (status: number, error: string, field?: 'description') => ({ found, fields, status, error, field, token: reportToken(scope) });
  const tokenError = await tokenProblem(scope, b.token);
  if (tokenError) return fail(400, tokenError);
  // Bots fill every field; people never see this one.
  if (typeof b.website === 'string' && b.website.trim()) return { found, fields, status: 201, reference: `r-${crypto.randomBytes(6).toString('base64url')}` };
  if (fields.description.length < REPORT_LIMITS.minDescription) return fail(400, 'Please describe the problem in a sentence or two.', 'description');
  if (fields.description.length > REPORT_LIMITS.description) return fail(400, `Please keep the description under ${REPORT_LIMITS.description} characters.`, 'description');
  if ((`${fields.title} ${fields.description}`.match(/https?:\/\/|www\./gi) ?? []).length > REPORT_LIMITS.links) return fail(400, `Please include at most ${REPORT_LIMITS.links} links.`, 'description');
  if (await visitorLimited(who, now)) return fail(429, 'Too many reports for now. Please try again later, or sign in as a member.');
  // The same report twice from this browser: answered as the first time, and only ever about this browser's own reports.
  const fingerprint = crypto.createHmac('sha256', keyFor('duplicate')!).update([session, project.id, found.version, found.term.iri, fields.description.toLowerCase().replace(/\s+/g, ' ')].join('\n')).digest('base64url');
  const before = await get<Sent>('kv', `report-sent:${fingerprint}`);
  if (before && before.reportSentUntil > now) return { found, fields, status: 201, reference: before.reference };
  if (await dailyLimited(project.id, now)) return fail(429, 'Too many reports for now. Please try again later, or sign in as a member.');

  const report: PublicReport = {
    id: newId('prp'),
    ontologyId: project.id,
    termIri: found.term.iri,
    termName: nameOf(found.term),
    version: found.version,
    title: fields.title,
    description: fields.description,
    createdAt: clock.iso(),
  };
  await put('publicReports', report, project.id);
  await put<Sent>('kv', { id: `report-sent:${fingerprint}`, reference: report.id, reportSentUntil: now + DAY_MS }, LIMITS);
  return { found, fields, status: 201, reference: report.id };
}

const wantsJson = (req: Request) => !!req.is('application/json') || req.accepts(['html', 'json']) === 'json';

const UNAVAILABLE = 'Reporting from the public page isn’t available on this site yet. Members can sign in and report from the app.';

export function reportRouter(): Router {
  const r = Router();
  const base = `${PUBLIC_BASE}/:slug/-/report`;
  if (!publicReportsEnabled()) console.warn(`[public] reports from the public page are off: set REPORT_SECRET (at least ${MIN_SECRET} characters, not the session secret) to turn them on`);
  const project = async (req: Request, res: Response) => {
    const p = await findProject(String(req.params.slug));
    if (!p) res.status(404).set('Cache-Control', 'no-store').type('text/plain').send('No such ontology');
    return p;
  };
  const term = async (req: Request, p: OntologyProject) => {
    const iri = exact(req.query.term, 2000);
    const v = versionParam(req.query.version);
    return iri && v ? await findTerm(p, v.version, iri) : undefined;
  };

  r.get(`${base}/token`, async (req, res, next) => {
    try {
      const p = await project(req, res);
      if (!p) return;
      res.set('Cache-Control', 'no-store');
      if (!publicReportsEnabled()) return void res.status(503).json({ error: UNAVAILABLE });
      const found = await term(req, p);
      if (!found) return void res.status(404).json({ error: 'That term isn’t in this version of the ontology, or that version isn’t published.' });
      res.json({ token: reportToken({ slug: p.slug, term: found.term.iri, version: found.version, session: browserSession(req, res) }), version: found.version });
    } catch (err) {
      next(err);
    }
  });

  r.get(base, async (req, res, next) => {
    try {
      const p = await project(req, res);
      if (!p) return;
      res.set('Cache-Control', 'no-store');
      const found = await term(req, p);
      if (!found) return void res.status(404).type('html').send(page('Not found', `<h1>Not found</h1><p>That term isn’t in ${esc(p.title)}.</p>`));
      if (!publicReportsEnabled()) return void res.status(503).type('html').send(page('Report a problem', `<h1>Report a problem</h1><p>${esc(UNAVAILABLE)}</p>`));
      const token = reportToken({ slug: p.slug, term: found.term.iri, version: found.version, session: browserSession(req, res) });
      res.type('html').send(reportPage(req, p, found.version, found.term, token));
    } catch (err) {
      next(err);
    }
  });

  r.post(base, express.urlencoded({ extended: false, limit: '16kb' }), express.json({ limit: '16kb' }), async (req, res, next) => {
    try {
      const p = await project(req, res);
      if (!p) return;
      res.set('Cache-Control', 'no-store');
      const json = wantsJson(req);
      const refuse = (status: number, message: string) =>
        json ? res.status(status).json({ error: message }) : res.status(status).type('html').send(page('Report a problem', `<h1>Report a problem</h1><p>${esc(message)}</p>`));
      if (!publicReportsEnabled()) return void refuse(503, UNAVAILABLE);
      if (crossSite(req)) return void refuse(403, 'Reports can only be sent from this site’s own pages.');
      let out: Awaited<ReturnType<typeof submit>>;
      try {
        out = await submit(req, res, p);
      } catch (err) {
        if (!(err instanceof ReportError)) throw err;
        return void refuse(err.status, err.message);
      }
      if ('error' in out) {
        if (json) return void res.status(out.status).json({ error: out.error, field: out.field, token: out.token });
        return void res.status(out.status).type('html').send(reportPage(req, p, out.found.version, out.found.term, out.token, { ...out.fields, error: out.error, field: out.field }));
      }
      if (json) return void res.status(out.status).json({ reference: out.reference });
      res.status(out.status).type('html').send(thanksPage(req, p, out.found.version, out.reference));
    } catch (err) {
      next(err);
    }
  });
  return r;
}

/* ------------------------------ moderation ------------------------------ */

/* Reports waiting for review, newest first. Once reviewed, a report is gone: opened as a change request, or dismissed. */
/** A claim older than this is from a request that never finished (the server stopped, say): it can be taken over. */
const CLAIM_STALE_MS = 2 * 60 * 1000;
const claimedNow = (r: PublicReport, now: number) => !!r.claimedAt && now - r.claimedAt <= CLAIM_STALE_MS;

/** What moderators see: the report without the claim's private token. */
export const listPublicReports = async (ontologyId: string) =>
  (await list<PublicReport>('publicReports', ontologyId))
    .map(({ claimToken: _, ...r }) => r)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
export const getPublicReport = async (ontologyId: string, id: string) => {
  const r = await get<PublicReport>('publicReports', id);
  return r && r.ontologyId === ontologyId ? r : undefined;
};

/** A claim on a report: proof that this request, and no other, is opening it. */
export interface ReportClaim {
  report: PublicReport;
  token: string;
}

/**
 * Claims a report for opening as a change request, in one transaction, so two
 * moderators (or a double click) can't open it at once. A claim that went
 * stale is taken over; the request that held it can no longer finish (see
 * convertPublicReport). Undefined if the report is gone or someone else is
 * opening it right now.
 */
export async function claimPublicReport(ontologyId: string, id: string, now = Date.now()): Promise<ReportClaim | undefined> {
  return await transaction(async () => {
    const report = await getPublicReport(ontologyId, id);
    if (!report || claimedNow(report, now)) return undefined;
    const token = crypto.randomUUID();
    await put('publicReports', { ...report, claimedAt: now, claimToken: token }, report.ontologyId);
    return { report: { ...report, claimedAt: undefined, claimToken: undefined }, token };
  });
}

/**
 * The moment a claimed report becomes a change request. Called inside the
 * transaction that saves the change request: the report is removed only if
 * this claim still holds it, so a request whose claim was taken over (or a
 * report dismissed meanwhile) saves nothing. One report, one change request.
 */
export async function convertPublicReport(c: ReportClaim) { return transaction(async () => {
  const now = await get<PublicReport>('publicReports', c.report.id);
  if (!now || now.claimToken !== c.token) throw new HttpError(409, 'This report was reviewed by someone else while you were opening it');
  await remove('publicReports', c.report.id);
}); }

/** Puts a claimed report back in the queue when opening it failed, unless someone else holds it by now. */
export async function releasePublicReport(c: ReportClaim) {
  await transaction(async () => {
    const now = await get<PublicReport>('publicReports', c.report.id);
    if (now?.claimToken === c.token) await put('publicReports', { ...now, claimedAt: undefined, claimToken: undefined }, now.ontologyId);
  });
}

/**
 * Dismisses a report, unless a moderator is opening it right now: then it's
 * a conflict, and the report becomes their change request. True if it was
 * dismissed, false if it was already gone.
 */
export async function dismissPublicReport(ontologyId: string, id: string, now = Date.now()): Promise<boolean> {
  return await transaction(async () => {
    const report = await getPublicReport(ontologyId, id);
    if (!report) return false;
    if (claimedNow(report, now)) throw new HttpError(409, 'Someone is opening this report as a change request right now');
    await remove('publicReports', id);
    return true;
  });
}

/** Removes a report outright: one whose change request already exists. */
export const removePublicReport = async (id: string) => await remove('publicReports', id);
