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
import { isHeld } from './holds.js';
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
const consume = (nonce: string, until: number) => insertOnce('reportNonces', { id: nonce, until }, 'nonce');

const EXPIRED = 'This form has expired. Reload the page and try again.';
function tokenProblem(scope: TokenScope, token: unknown, now = Date.now()): string | undefined {
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
  if (!consume(nonce, issued + TOKEN_MAX_AGE_MS)) return EXPIRED;
  return undefined;
}

/* ------------------------------ rate limits ------------------------------ */

const hits = new Map<string, number[]>();
const sent = new Map<string, { reference: string; until: number }>();
const MAX_KEYS = 50_000;
let lastSweep = 0;

/** Forgets what no limit needs any more, and keeps memory bounded. */
function sweep(now = Date.now(), force = false) {
  if (!force && now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [k, ts] of hits) {
    const live = ts.filter((t) => now - t < DAY_MS);
    if (live.length) hits.set(k, live);
    else hits.delete(k);
  }
  removeWhereAtMost('reportNonces', 'until', now);
  for (const [k, v] of sent) if (v.until <= now) sent.delete(k);
  for (const m of [hits, sent] as Map<string, unknown>[]) for (const k of m.keys()) if (m.size > MAX_KEYS) m.delete(k);
}

/** For tests: clears every limit, and what was remembered about past reports. */
export function resetReportLimits() {
  hits.clear();
  sent.clear();
  lastSweep = 0;
  removeWhereAtMost('reportNonces', 'until', Number.MAX_SAFE_INTEGER);
  for (const d of [0, 1]) remove('kv', dailyKey(Date.now() - d * DAY_MS));
}
/** For tests: how many visitors and tokens are remembered. */
export const reportMemory = () => ({ visitors: [...hits.keys()].filter((k) => k.startsWith('v:')).length, attempts: [...hits.keys()].filter((k) => k.startsWith('a:')).length, tokens: list('reportNonces', 'nonce').length, sent: sent.size });
export const sweepReportMemory = (now: number) => sweep(now, true);

function visitorLimited(who: string, now: number): boolean {
  const key = `v:${who}`;
  const ts = (hits.get(key) ?? []).filter((t) => now - t < DAY_MS);
  if (ts.filter((t) => now - t < VISITOR.short.ms).length >= VISITOR.short.max || ts.length >= VISITOR.day.max) return true;
  hits.set(key, [...ts, now]);
  return false;
}

/** Every post counts here, before it is checked at all. */
function attemptsLimited(who: string, now: number): boolean {
  const key = `a:${who}`;
  const ts = (hits.get(key) ?? []).filter((t) => now - t < ATTEMPTS.ms);
  if (ts.length >= ATTEMPTS.max) return true;
  hits.set(key, [...ts, now]);
  return false;
}

interface DailyCounts {
  id: string;
  all: number;
  byOntology: Record<string, number>;
}
const dailyKey = (now: number) => `public-report-counts:${new Date(now).toISOString().slice(0, 10)}`;
/** Per ontology and overall, per day, stored so a restart doesn't reset them. */
function dailyLimited(ontologyId: string, now: number): boolean {
  const counts = get<DailyCounts>('kv', dailyKey(now)) ?? { id: dailyKey(now), all: 0, byOntology: {} };
  if (counts.all >= DAILY.all || (counts.byOntology[ontologyId] ?? 0) >= DAILY.ontology) return true;
  counts.all++;
  counts.byOntology[ontologyId] = (counts.byOntology[ontologyId] ?? 0) + 1;
  put('kv', counts);
  remove('kv', dailyKey(now - 2 * DAY_MS));
  return false;
}

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

async function findTerm(project: OntologyProject, version: string | undefined, iri: string): Promise<{ term: TermView; version: string } | undefined> {
  const v = version && version !== 'draft' && ontologyStore.versions(project).includes(version) ? version : 'draft';
  for (const ref of [v, 'draft']) {
    // A version waiting for a steward's approval publishes nothing, its terms included.
    if (isHeld(project.id, ref)) continue;
    try {
      const term = (await ontologyStore.at(project, ref === 'draft' ? 'working' : ref)).term(iri);
      if (term) return { term, version: ref };
    } catch {
      /* try the draft */
    }
  }
  return undefined;
}

const clean = (v: unknown, max: number) =>
  typeof v === 'string'
    ? v
        .normalize('NFKC')
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
  sweep(now);
  const who = visitor(req);
  if (attemptsLimited(who, now)) throw new ReportError(429, 'Too many tries for now. Please try again later, or sign in as a member.');
  const b = (req.body ?? {}) as Record<string, unknown>;
  const iri = clean(b.term, 2000);
  const found = iri ? await findTerm(project, clean(b.version, 40) || undefined, iri) : undefined;
  if (!found) throw new ReportError(400, 'That term isn’t in this ontology.');
  const session = browserSession(req, res);
  const scope = { slug: project.slug, term: found.term.iri, version: found.version, session };
  const fields = { title: clean(b.title, REPORT_LIMITS.title), description: clean(b.description, REPORT_LIMITS.description + 1) };
  const fail = (status: number, error: string, field?: 'description') => ({ found, fields, status, error, field, token: reportToken(scope) });
  const tokenError = tokenProblem(scope, b.token);
  if (tokenError) return fail(400, tokenError);
  // Bots fill every field; people never see this one.
  if (clean(b.website, 200)) return { found, fields, status: 201, reference: `r-${crypto.randomBytes(6).toString('base64url')}` };
  if (fields.description.length < REPORT_LIMITS.minDescription) return fail(400, 'Please describe the problem in a sentence or two.', 'description');
  if (fields.description.length > REPORT_LIMITS.description) return fail(400, `Please keep the description under ${REPORT_LIMITS.description} characters.`, 'description');
  if ((`${fields.title} ${fields.description}`.match(/https?:\/\/|www\./gi) ?? []).length > REPORT_LIMITS.links) return fail(400, `Please include at most ${REPORT_LIMITS.links} links.`, 'description');
  if (visitorLimited(who, now)) return fail(429, 'Too many reports for now. Please try again later, or sign in as a member.');
  // The same report twice from this browser: answered as the first time, and only ever about this browser's own reports.
  const fingerprint = crypto.createHmac('sha256', keyFor('duplicate')!).update([session, project.id, found.term.iri, fields.description.toLowerCase().replace(/\s+/g, ' ')].join('\n')).digest('base64url');
  const before = sent.get(fingerprint);
  if (before) return { found, fields, status: 201, reference: before.reference };
  if (dailyLimited(project.id, now)) return fail(429, 'Too many reports for now. Please try again later, or sign in as a member.');

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
  put('publicReports', report, project.id);
  sent.set(fingerprint, { reference: report.id, until: now + DAY_MS });
  return { found, fields, status: 201, reference: report.id };
}

const wantsJson = (req: Request) => !!req.is('application/json') || req.accepts(['html', 'json']) === 'json';

const UNAVAILABLE = 'Reporting from the public page isn’t available on this site yet. Members can sign in and report from the app.';

export function reportRouter(): Router {
  const r = Router();
  const base = `${PUBLIC_BASE}/:slug/-/report`;
  if (!publicReportsEnabled()) console.warn(`[public] reports from the public page are off: set REPORT_SECRET (at least ${MIN_SECRET} characters, not the session secret) to turn them on`);
  const project = (req: Request, res: Response) => {
    const p = findProject(String(req.params.slug));
    if (!p) res.status(404).set('Cache-Control', 'no-store').type('text/plain').send('No such ontology');
    return p;
  };
  const term = async (req: Request, p: OntologyProject) => {
    const iri = clean(req.query.term, 2000);
    return iri ? await findTerm(p, clean(req.query.version, 40) || undefined, iri) : undefined;
  };

  r.get(`${base}/token`, async (req, res, next) => {
    try {
      const p = project(req, res);
      if (!p) return;
      res.set('Cache-Control', 'no-store');
      if (!publicReportsEnabled()) return void res.status(503).json({ error: UNAVAILABLE });
      const found = await term(req, p);
      if (!found) return void res.status(404).json({ error: 'That term isn’t in this ontology.' });
      res.json({ token: reportToken({ slug: p.slug, term: found.term.iri, version: found.version, session: browserSession(req, res) }), version: found.version });
    } catch (err) {
      next(err);
    }
  });

  r.get(base, async (req, res, next) => {
    try {
      const p = project(req, res);
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
      const p = project(req, res);
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
export const listPublicReports = (ontologyId: string) =>
  list<PublicReport>('publicReports', ontologyId)
    .map(({ claimToken: _, ...r }) => r)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
export const getPublicReport = (ontologyId: string, id: string) => {
  const r = get<PublicReport>('publicReports', id);
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
export function claimPublicReport(ontologyId: string, id: string, now = Date.now()): ReportClaim | undefined {
  return transaction(() => {
    const report = getPublicReport(ontologyId, id);
    if (!report || claimedNow(report, now)) return undefined;
    const token = crypto.randomUUID();
    put('publicReports', { ...report, claimedAt: now, claimToken: token }, report.ontologyId);
    return { report: { ...report, claimedAt: undefined, claimToken: undefined }, token };
  });
}

/**
 * The moment a claimed report becomes a change request. Called inside the
 * transaction that saves the change request: the report is removed only if
 * this claim still holds it, so a request whose claim was taken over (or a
 * report dismissed meanwhile) saves nothing. One report, one change request.
 */
export function convertPublicReport(c: ReportClaim) {
  const now = get<PublicReport>('publicReports', c.report.id);
  if (!now || now.claimToken !== c.token) throw new HttpError(409, 'This report was reviewed by someone else while you were opening it');
  remove('publicReports', c.report.id);
}

/** Puts a claimed report back in the queue when opening it failed, unless someone else holds it by now. */
export function releasePublicReport(c: ReportClaim) {
  transaction(() => {
    const now = get<PublicReport>('publicReports', c.report.id);
    if (now?.claimToken === c.token) put('publicReports', { ...now, claimedAt: undefined, claimToken: undefined }, now.ontologyId);
  });
}

/**
 * Dismisses a report, unless a moderator is opening it right now: then it's
 * a conflict, and the report becomes their change request. True if it was
 * dismissed, false if it was already gone.
 */
export function dismissPublicReport(ontologyId: string, id: string, now = Date.now()): boolean {
  return transaction(() => {
    const report = getPublicReport(ontologyId, id);
    if (!report) return false;
    if (claimedNow(report, now)) throw new HttpError(409, 'Someone is opening this report as a change request right now');
    remove('publicReports', id);
    return true;
  });
}

/** Removes a report outright: one whose change request already exists. */
export const removePublicReport = (id: string) => remove('publicReports', id);
