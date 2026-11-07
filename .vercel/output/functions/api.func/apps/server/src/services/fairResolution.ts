/**
 * Looks up an ontology IRI over HTTP for the FAIR "Accessible" checks: does it
 * return RDF when asked for RDF, and HTML when asked by a browser? Results are
 * cached for an hour, and a lookup never takes longer than a few seconds.
 */
import type { FairContext, FairResolution } from '@concord/core/types';

const TTL_MS = 60 * 60 * 1000;
const TIMEOUT_MS = 4000;
const RDF_TYPES = /text\/turtle|application\/rdf\+xml|application\/n-triples|application\/ld\+json|text\/n3|application\/trig/i;
const cache = new Map<string, { at: number; result: Promise<FairResolution> }>();

async function probe(iri: string, accept: string): Promise<{ ok: boolean; type: string; status: number }> {
  const res = await fetch(iri, { headers: { accept }, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
  await res.body?.cancel();
  return { ok: res.ok, type: res.headers.get('content-type') ?? '', status: res.status };
}

async function resolve(iri: string): Promise<FairResolution> {
  const [rdf, html] = await Promise.allSettled([
    probe(iri, 'text/turtle, application/rdf+xml;q=0.9, application/ld+json;q=0.8, application/n-triples;q=0.7'),
    probe(iri, 'text/html'),
  ]);
  const rdfOk = rdf.status === 'fulfilled' && rdf.value.ok && RDF_TYPES.test(rdf.value.type);
  const htmlOk = html.status === 'fulfilled' && html.value.ok && /text\/html/i.test(html.value.type);
  const detail =
    rdf.status === 'rejected' ? (rdf.reason as Error)?.name === 'TimeoutError' ? 'no answer within 4 seconds' : 'could not be reached'
    : !rdf.value.ok ? `HTTP ${rdf.value.status}`
    : !rdfOk ? `answered with ${rdf.value.type || 'no content type'}` : undefined;
  return { rdf: rdfOk, html: htmlOk, detail };
}

/** FAIR context for an ontology IRI. Off in tests and when FAIR_RESOLVE=0, so those checks show as not checked. */
export async function fairContext(iri: string | undefined): Promise<FairContext> {
  if (!iri || !/^https?:\/\//.test(iri) || process.env.NODE_ENV === 'test' || process.env.FAIR_RESOLVE === '0') return {};
  let hit = cache.get(iri);
  if (!hit || Date.now() - hit.at > TTL_MS) {
    hit = { at: Date.now(), result: resolve(iri) };
    cache.set(iri, hit);
  }
  return { resolution: await hit.result };
}
