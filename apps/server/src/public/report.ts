import crypto from 'node:crypto';
import express, { Router, type Request, type Response } from 'express';
import type { TermView } from '@concord/core/types';
import type { OntologyProject } from '@concord/shared';
import { config } from '../config.js';
import { clientIp } from '../oauth.js';
import { findProject } from '../services/ontologies.js';
import { ontologyStore } from '../services/ontologyStore.js';
import { createChangeRequest } from '../services/changeRequests.js';
import { publicReporter } from '../services/users.js';
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
 * Public reports become bug-kind change requests for the working group, with
 * no drafted edits (an editor decides what to change, so nothing written by
 * an anonymous visitor can reach the ontology on autopilot). Anti-abuse:
 * a signed, time-limited form token (no instant or replayed bot posts), a
 * honeypot field, rate limits per visitor, per ontology and overall, a cap
 * on links, and duplicate detection. Nothing private is returned: the reply
 * is a thank-you with an opaque reference, never the request's number or any
 * other data. The visitor's address is only held in memory, hashed, for the
 * rate limits.
 */

const TOKEN_MIN_AGE_MS = 3_000;
const TOKEN_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const WINDOWS = {
  visitorShort: { ms: 10 * 60 * 1000, max: 5 },
  visitorDay: { ms: 24 * 60 * 60 * 1000, max: 10 },
  ontologyDay: { ms: 24 * 60 * 60 * 1000, max: 30 },
  allDay: { ms: 24 * 60 * 60 * 1000, max: 300 },
};

const sign = (value: string) => crypto.createHmac('sha256', config.sessionSecret).update(`public-report:${value}`).digest('base64url');

/** A form token: when the form was handed out, signed for this ontology. */
export function reportToken(slug: string, now = Date.now()): string {
  return `${now}.${sign(`${slug}.${now}`)}`;
}

function tokenProblem(slug: string, token: unknown, now = Date.now()): string | undefined {
  const [ts, sig] = typeof token === 'string' ? token.split('.') : [];
  const issued = Number(ts);
  if (!ts || !sig || !Number.isFinite(issued)) return 'This form has expired. Reload the page and try again.';
  const expected = sign(`${slug}.${ts}`);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return 'This form has expired. Reload the page and try again.';
  if (now - issued < TOKEN_MIN_AGE_MS) return 'That was quick. Please check your report and send it again.';
  if (now - issued > TOKEN_MAX_AGE_MS) return 'This form has expired. Reload the page and try again.';
  return undefined;
}

/* ------------------------------ rate limits ------------------------------ */

const hits = new Map<string, number[]>();
const recent = new Map<string, number>();
export function resetReportLimits() {
  hits.clear();
  recent.clear();
}
function limited(keys: [string, { ms: number; max: number }][], now = Date.now()): boolean {
  const over = keys.some(([key, w]) => (hits.get(key) ?? []).filter((t) => now - t < w.ms).length >= w.max);
  if (over) return true;
  for (const [key, w] of keys) hits.set(key, [...(hits.get(key) ?? []).filter((t) => now - t < w.ms), now]);
  return false;
}
const visitor = (req: Request) => crypto.createHash('sha256').update(`${config.sessionSecret}:${clientIp(req)}`).digest('base64url').slice(0, 22);

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

function reportPage(req: Request, project: OntologyProject, version: string, term: TermView, state: FormState = {}) {
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
${reportChoices({ action: `${root}/-/report`, iri: term.iri, version, memberUrl: memberReportUrl(base, project.slug, term.iri), token: reportToken(project.slug), state })}
<p><a href="${esc(back)}">Back to the specification</a></p>`,
  );
}

function thanksPage(req: Request, project: OntologyProject, version: string, reference: string) {
  const back = `${siteOrigin(req)}${PUBLIC_BASE}/${encodeURIComponent(project.slug)}/${version === 'draft' ? 'draft' : version}`;
  return page(
    'Thanks for your report',
    `<h1>Thanks for your report</h1>
<p>The ${esc(project.title)} working group will look at it.</p>
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

async function submit(req: Request, project: OntologyProject) {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const iri = clean(b.term, 2000);
  const found = iri ? await findTerm(project, clean(b.version, 40) || undefined, iri) : undefined;
  if (!found) throw new ReportError(400, 'That term isn’t in this ontology.');
  const fields = { title: clean(b.title, REPORT_LIMITS.title), description: clean(b.description, REPORT_LIMITS.description + 1) };
  const fail = (status: number, error: string) => ({ found, fields, status, error });
  // Bots fill every field; people never see this one.
  if (clean(b.website, 200)) return { found, fields, status: 201, reference: `r-${crypto.randomBytes(6).toString('base64url')}` };
  const tokenError = tokenProblem(project.slug, b.token);
  if (tokenError) return fail(400, tokenError);
  if (fields.description.length < REPORT_LIMITS.minDescription) return fail(400, 'Please describe the problem in a sentence or two.');
  if (fields.description.length > REPORT_LIMITS.description) return fail(400, `Please keep the description under ${REPORT_LIMITS.description} characters.`);
  if ((`${fields.title} ${fields.description}`.match(/https?:\/\/|www\./gi) ?? []).length > REPORT_LIMITS.links) return fail(400, `Please include at most ${REPORT_LIMITS.links} links.`);
  const fingerprint = crypto.createHash('sha256').update(`${project.id}:${fields.description.toLowerCase().replace(/\s+/g, ' ')}`).digest('base64url');
  const now = Date.now();
  if (now - (recent.get(fingerprint) ?? 0) < WINDOWS.ontologyDay.ms) return fail(409, 'This problem has already been reported. Thank you.');
  const who = visitor(req);
  if (
    limited([
      [`v10:${who}`, WINDOWS.visitorShort],
      [`vday:${who}`, WINDOWS.visitorDay],
      [`o:${project.id}`, WINDOWS.ontologyDay],
      ['all', WINDOWS.allDay],
    ])
  )
    return fail(429, 'Too many reports for now. Please try again later, or sign in as a member.');
  recent.set(fingerprint, now);

  const name = nameOf(found.term);
  const title = fields.title || `Problem with ${name}`;
  const cr = await createChangeRequest(project, await publicReporter(), {
    title,
    description: `${fields.description}\n\nTerm: <${found.term.iri}>\n\n_Reported by a member of the public from the public page (${found.version === 'draft' ? 'working draft' : `version ${found.version}`}). No edits were drafted from it: an editor decides what, if anything, to change._`,
    kind: 'bug',
    origin: { type: 'public-report', termIri: found.term.iri, version: found.version },
    ops: [],
  });
  return { found, fields, status: 201, reference: cr.id };
}

const wantsJson = (req: Request) => !!req.is('application/json') || req.accepts(['html', 'json']) === 'json';

export function reportRouter(): Router {
  const r = Router();
  const base = `${PUBLIC_BASE}/:slug/-/report`;
  const project = (req: Request, res: Response) => {
    const p = findProject(String(req.params.slug));
    if (!p) res.status(404).set('Cache-Control', 'no-store').type('text/plain').send('No such ontology');
    return p;
  };

  r.get(`${base}/token`, (req, res) => {
    const p = project(req, res);
    if (!p) return;
    res.set('Cache-Control', 'no-store').json({ token: reportToken(p.slug) });
  });

  r.get(base, async (req, res, next) => {
    try {
      const p = project(req, res);
      if (!p) return;
      const iri = clean(req.query.term, 2000);
      const found = iri ? await findTerm(p, clean(req.query.version, 40) || undefined, iri) : undefined;
      res.set('Cache-Control', 'no-store');
      if (!found) return void res.status(404).type('html').send(page('Not found', `<h1>Not found</h1><p>That term isn’t in ${esc(p.title)}.</p>`));
      res.type('html').send(reportPage(req, p, found.version, found.term));
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
      let out: Awaited<ReturnType<typeof submit>>;
      try {
        out = await submit(req, p);
      } catch (err) {
        if (!(err instanceof ReportError)) throw err;
        return void (json ? res.status(err.status).json({ error: err.message }) : res.status(err.status).type('html').send(page('Report a problem', `<h1>Report a problem</h1><p>${esc(err.message)}</p>`)));
      }
      if ('error' in out) {
        if (json) return void res.status(out.status).json({ error: out.error });
        return void res.status(out.status).type('html').send(reportPage(req, p, out.found.version, out.found.term, { ...out.fields, error: out.error }));
      }
      if (json) return void res.status(out.status).json({ reference: out.reference });
      res.status(out.status).type('html').send(thanksPage(req, p, out.found.version, out.reference));
    } catch (err) {
      next(err);
    }
  });
  return r;
}
