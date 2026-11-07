import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { DATA_FORMATS, DATA_MEDIA_TYPES, DataError, dataFormatForMediaType, sniffDataFormat, type DataFormat } from '@concord/core';
import { config } from '../config.js';
import { clientIp } from '../oauth.js';
import { DbRateStore } from '../rateLimitStore.js';
import { findProject } from '../services/ontologies.js';
import { HELD_MESSAGE, isHeld } from './holds.js';
import { ontologyStore } from '../services/ontologyStore.js';
import { VALIDATION_LIMITS, validateDataAgainst } from '../services/dataValidation.js';
import { admit } from '../services/validationPool.js';
import { acceptMatch, latestVersion } from './routes.js';
import { PUBLIC_BASE } from './w3id.js';

/**
 * Validation at the ontology's own address:
 *
 *   POST /def/<slug>             validate against the latest release
 *   POST /def/<slug>/<version>   validate against that version (or "draft")
 *
 * The request body is RDF instance data (Content-Type text/turtle,
 * application/ld+json, application/n-triples, application/n-quads,
 * application/trig or application/rdf+xml; anything else is sniffed). The
 * response is a validation report: JSON by default, or a SHACL
 * sh:ValidationReport in Turtle for Accept: text/turtle. A report is 200
 * whether or not the data conforms; 400 means the data couldn't be parsed,
 * 413 that it is too large, 429 that the caller is sending too many (30 a
 * minute, or more than two at once), and 503 that the validator is busy.
 *
 * Query parameters: format=<turtle|jsonld|ntriples|nquads|trig|rdfxml> to
 * override the Content-Type, and base=<IRI> to resolve relative IRIs.
 *
 * Nothing is stored. Any site may call it (CORS), without credentials.
 */

/** Media types accepted in the body, for Accept-Post and errors. */
export const ACCEPT_POST = DATA_MEDIA_TYPES.join(', ');

/** Bodies sent without saying what they are (curl -d sends form encoding): sniffed. */
const UNLABELLED = new Set(['', 'application/x-www-form-urlencoded', 'text/plain', 'application/octet-stream']);

/** Validations one client may ask for each minute. */
export const RATE_LIMITS = { perMinute: Number(process.env.VALIDATE_RATE_LIMIT ?? 30) };

const limiter = rateLimit({
  windowMs: 60 * 1000,
  limit: () => RATE_LIMITS.perMinute,
  // Counted across every instance when several serve at once (Vercel).
  ...(config.sharedLimits ? { store: new DbRateStore('validate') } : {}),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(clientIp(req as Request)),
  validate: { trustProxy: false, xForwardedForHeader: false },
  handler: (_req, res) => {
    cors(res);
    res.status(429).json({ error: 'Too many validation requests. Try again in a minute.' });
  },
});

function cors(res: Response) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Expose-Headers', 'Link, Content-Profile, RateLimit, RateLimit-Policy, Retry-After');
}

/** How long a client has to send its data once it has a place. */
export const BODY_LIMITS = { ms: Number(process.env.VALIDATE_BODY_MS ?? 20_000) };

/**
 * Takes a place in the validator before the body is read (validationPool.ts),
 * so uploads held in memory are bounded overall and per client. Clients are
 * grouped as the rate limiter groups them (IPv6 by /56). The place is given
 * back once the response has ended and any validation it started has
 * stopped; a client that goes away cancels that validation.
 */
const admission = (req: Request, res: Response, next: NextFunction) => {
  const place = admit(`ip:${ipKeyGenerator(clientIp(req))}`, declaredFormat(req));
  if (!place.ok) {
    cors(res);
    // Don't read what they're sending; close the connection after answering.
    res.set('Connection', 'close').set('Retry-After', '5');
    return void res.status(place.status).json({ error: place.message });
  }
  const controller = new AbortController();
  res.locals.signal = controller.signal;
  res.on('close', () => {
    if (!res.writableFinished) controller.abort();
    const job = res.locals.job as Promise<unknown> | undefined;
    if (job) job.then(place.release, place.release);
    else place.release();
  });
  next();
};

/**
 * Reads the body as text, answering for itself when it can't, or when it
 * takes too long to arrive. If the client goes away first, the timer and the
 * request stream (with any decompressor) are dropped at once.
 */
const readBody = (req: Request, res: Response, next: NextFunction) => {
  const timer = setTimeout(() => {
    if (res.headersSent) return;
    cors(res);
    res.set('Connection', 'close').status(408).json({ error: `The data took longer than ${BODY_LIMITS.ms / 1000} s to arrive.` });
    res.on('finish', () => req.destroy());
  }, BODY_LIMITS.ms);
  const gone = () => {
    clearTimeout(timer);
    if (!req.complete) {
      req.unpipe();
      req.destroy();
    }
  };
  res.once('close', gone);
  express.text({ type: () => true, limit: VALIDATION_LIMITS.bytes })(req, res, (err?: unknown) => {
    clearTimeout(timer);
    res.off('close', gone);
    if (res.headersSent || res.destroyed) return;
    if (!err) return next();
    cors(res);
    const e = err as { type?: string; status?: number; message?: string };
    if (e.type === 'entity.too.large') return void res.status(413).set('Connection', 'close').json({ error: `The data is larger than ${VALIDATION_LIMITS.bytes / 1024 / 1024} MB.` });
    res.status(e.status && e.status < 500 ? e.status : 400).json({ error: `Could not read the request body: ${e.message ?? 'unknown error'}` });
  });
};

const UNSUPPORTED = `Unsupported data format. Send one of: ${ACCEPT_POST}, or add ?format=turtle (or jsonld, ntriples, nquads, trig, rdfxml).`;

/** The format named by ?format or the Content-Type; "sniff" when the body has to say; undefined when unsupported. */
function declaredFormat(req: Request): DataFormat | 'sniff' | undefined {
  const asked = typeof req.query.format === 'string' ? req.query.format : undefined;
  if (asked) return asked in DATA_FORMATS ? (asked as DataFormat) : undefined;
  const type = (req.get('Content-Type') ?? '').split(';')[0].trim().toLowerCase();
  if (UNLABELLED.has(type)) return 'sniff';
  return dataFormatForMediaType(type);
}

/** The site's own address, as in routes.ts. */
const origin = (req: Request) => (process.env.PUBLIC_URL ? config.publicUrl : `${req.protocol}://${req.host}`);

/**
 * Which report to send: JSON or Turtle, both UTF-8, by the Accept header's
 * most specific matching ranges (charset counts, as for the SHACL profile).
 * The higher quality wins; on a tie, the one listed first; JSON by default.
 */
function reportType(accept: string | undefined): Target['wants'] | undefined {
  const json = acceptMatch(accept, 'application/json', { charset: 'utf-8' });
  const turtle = acceptMatch(accept, 'text/turtle', { charset: 'utf-8' });
  if (json.q <= 0 && turtle.q <= 0) return undefined;
  if (turtle.q > json.q || (turtle.q === json.q && turtle.position < json.position)) return 'text/turtle';
  return 'application/json';
}

interface Target {
  project: NonNullable<Awaited<ReturnType<typeof findProject>>>;
  version: string;
  wants: 'application/json' | 'text/turtle';
}

/** Checks the ontology, version and Accept before anything is read: a request that will fail costs nothing. */
const target = async (req: Request, res: Response, next: NextFunction) => {
  cors(res);
  res.set('Cache-Control', 'no-store');
  res.vary('Accept');
  const fail = (status: number, error: string) => void res.status(status).set('Connection', 'close').json({ error });
  const project = await findProject(String(req.params.slug));
  if (!project) return fail(404, `There is no ontology called “${String(req.params.slug)}”.`);
  const requested = req.params.version === undefined ? 'latest' : String(req.params.version);
  const latest = await latestVersion(project);
  const version =
    requested === 'latest' ? (latest ?? 'draft') : requested === 'draft' || requested === 'working' ? 'draft' : (await ontologyStore.versions(project)).includes(requested) ? requested : undefined;
  if (!version) return fail(404, `${project.title} has no version “${requested}”.`);
  // A version waiting for a steward to approve what it publishes (holds.ts): answers name its terms, so none are given.
  if (await isHeld(project, version)) return void res.status(503).set('Retry-After', '86400').set('Connection', 'close').json({ error: HELD_MESSAGE });
  const wants = reportType(req.get('Accept'));
  if (!wants) return fail(406, 'Reports are available as application/json or text/turtle (UTF-8).');
  if (!declaredFormat(req)) return void res.status(415).set('Connection', 'close').set('Accept-Post', ACCEPT_POST).json({ error: UNSUPPORTED });
  res.locals.target = { project, version, wants } satisfies Target;
  next();
};

async function validate(req: Request, res: Response) {
  const { project, version, wants } = res.locals.target as Target;
  const text = typeof req.body === 'string' ? req.body : '';
  if (!text.trim()) return void res.status(400).set('Accept-Post', ACCEPT_POST).json({ error: `Send the data to validate in the request body, as one of: ${ACCEPT_POST}.` });
  const declared = declaredFormat(req);
  const format = declared === 'sniff' ? sniffDataFormat(text) : declared;
  if (!format) return void res.status(415).set('Accept-Post', ACCEPT_POST).json({ error: UNSUPPORTED });
  const base = typeof req.query.base === 'string' && /^https?:\/\//.test(req.query.base) ? req.query.base : undefined;
  const self = `${origin(req)}${PUBLIC_BASE}/${encodeURIComponent(project.slug)}/${version}`;
  const job = validateDataAgainst(project, version, text, { format, baseIRI: base, shapesUrl: `${self}.shacl.ttl`, turtle: wants === 'text/turtle', signal: res.locals.signal as AbortSignal });
  // The client's place is held until this has stopped (see admission).
  res.locals.job = job;
  const { body, turtle } = await job;
  if (res.destroyed) return;
  res.set('Link', `<${self}.shacl.ttl>; rel="describedby"; type="text/turtle"; profile="http://www.w3.org/ns/shacl#"`);
  if (wants === 'text/turtle') return void res.type('text/turtle; charset=utf-8').send(turtle ?? '');
  res.json(body);
}

export function validationRouter(): Router {
  const r = Router();
  const path = `${PUBLIC_BASE}/:slug{/:version}`;
  // Preflight for cross-site POSTs, and for GETs that send Accept-Profile.
  r.options(path, (_req, res) => {
    cors(res);
    res.set('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Accept, Accept-Profile');
    res.set('Access-Control-Max-Age', '86400');
    res.set('Allow', 'GET, HEAD, POST, OPTIONS');
    res.set('Accept-Post', ACCEPT_POST);
    res.status(204).end();
  });
  r.post(path, limiter, target, admission, readBody, async (req, res, next) => {
    try {
      await validate(req, res);
    } catch (err) {
      // The client went away and its validation was cancelled: nobody to answer.
      if (res.destroyed || res.headersSent) return;
      if (err instanceof DataError) {
        if (err.status === 503) res.set('Retry-After', '5');
        return void res.status(err.status).json({ error: err.message });
      }
      next(err);
    }
  });
  return r;
}
