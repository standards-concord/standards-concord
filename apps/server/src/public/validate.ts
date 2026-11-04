import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { DATA_FORMATS, DATA_MEDIA_TYPES, DataError, dataFormatForMediaType, sniffDataFormat, type DataFormat } from '@concord/core';
import { config } from '../config.js';
import { clientIp } from '../oauth.js';
import { findProject } from '../services/ontologies.js';
import { ontologyStore } from '../services/ontologyStore.js';
import { VALIDATION_LIMITS, validateDataAgainst } from '../services/dataValidation.js';
import { latestVersion } from './routes.js';
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
 * 413 that it is too large, and 429 that the caller is sending too many.
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

const limiter = rateLimit({
  windowMs: 60 * 1000,
  limit: Number(process.env.VALIDATE_RATE_LIMIT ?? 30),
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

/** Reads the body as text, answering for itself when it can't. */
const readBody = (req: Request, res: Response, next: NextFunction) =>
  express.text({ type: () => true, limit: VALIDATION_LIMITS.bytes })(req, res, (err?: unknown) => {
    if (!err) return next();
    cors(res);
    const e = err as { type?: string; status?: number; message?: string };
    if (e.type === 'entity.too.large') return void res.status(413).json({ error: `The data is larger than ${VALIDATION_LIMITS.bytes / 1024 / 1024} MB.` });
    res.status(e.status && e.status < 500 ? e.status : 400).json({ error: `Could not read the request body: ${e.message ?? 'unknown error'}` });
  });

function formatOf(req: Request, text: string): DataFormat | undefined {
  const asked = typeof req.query.format === 'string' ? req.query.format : undefined;
  if (asked) return asked in DATA_FORMATS ? (asked as DataFormat) : undefined;
  const type = (req.get('Content-Type') ?? '').split(';')[0].trim().toLowerCase();
  if (UNLABELLED.has(type)) return sniffDataFormat(text);
  return dataFormatForMediaType(type);
}

/** The site's own address, as in routes.ts. */
const origin = (req: Request) => (process.env.PUBLIC_URL ? config.publicUrl : `${req.protocol}://${req.host}`);

async function validate(req: Request, res: Response) {
  cors(res);
  res.set('Cache-Control', 'no-store');
  res.vary('Accept');
  const project = findProject(String(req.params.slug));
  if (!project) return void res.status(404).json({ error: `There is no ontology called “${String(req.params.slug)}”.` });
  const requested = req.params.version === undefined ? 'latest' : String(req.params.version);
  const latest = latestVersion(project);
  const version =
    requested === 'latest' ? (latest ?? 'draft') : requested === 'draft' || requested === 'working' ? 'draft' : ontologyStore.versions(project).includes(requested) ? requested : undefined;
  if (!version) return void res.status(404).json({ error: `${project.title} has no version “${requested}”.` });

  const wants = req.accepts(['application/json', 'text/turtle']);
  if (!wants) return void res.status(406).json({ error: 'Reports are available as application/json or text/turtle.' });

  const text = typeof req.body === 'string' ? req.body : '';
  if (!text.trim()) return void res.status(400).set('Accept-Post', ACCEPT_POST).json({ error: `Send the data to validate in the request body, as one of: ${ACCEPT_POST}.` });
  const format = formatOf(req, text);
  if (!format) {
    return void res
      .status(415)
      .set('Accept-Post', ACCEPT_POST)
      .json({ error: `Unsupported data format. Send one of: ${ACCEPT_POST}, or add ?format=turtle (or jsonld, ntriples, nquads, trig, rdfxml).` });
  }
  const base = typeof req.query.base === 'string' && /^https?:\/\//.test(req.query.base) ? req.query.base : undefined;
  const self = `${origin(req)}${PUBLIC_BASE}/${encodeURIComponent(project.slug)}/${version}`;
  const { body, turtle } = await validateDataAgainst(project, version, text, { format, baseIRI: base, shapesUrl: `${self}.shacl.ttl` });
  res.set('Link', `<${self}.shacl.ttl>; rel="describedby"; type="text/turtle"; profile="http://www.w3.org/ns/shacl#"`);
  if (wants === 'text/turtle') return void res.type('text/turtle; charset=utf-8').send(turtle());
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
  r.post(path, limiter, readBody, async (req, res, next) => {
    try {
      await validate(req, res);
    } catch (err) {
      if (err instanceof DataError) return void res.status(err.status).json({ error: err.message });
      next(err);
    }
  });
  return r;
}
