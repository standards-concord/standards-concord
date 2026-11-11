import { DATA_CHECK_LIMITS } from '@concord/core/data-check';
import type { DataValidation } from '../api';
import { parseTurtle, RDF_TYPE, type RdfTerm } from './turtleDoc';

const OWL = 'http://www.w3.org/2002/07/owl#';

/** Only absolute, unambiguous IRIREFs enter our fixed query templates. */
export function iriRef(iri: string): string {
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(iri) || /[\s\u0000-\u0020\u007f-\u009f<>"{}|^`\\]/u.test(iri) || /[\uD800-\uDFFF]/u.test(iri)) throw new Error('Use an absolute IRI without spaces, control characters or < > " { } | ^ ` \\.');
  return `<${iri}>`;
}

function samplePattern(classIri: string, limit: number, graph: string): string {
  if (![20, 50, 200].includes(limit)) throw new Error('Choose 20, 50 or 200 resources per class.');
  const pattern = (body: string) => graph ? `GRAPH ${iriRef(graph)} { ${body} }` : body;
  return `{ SELECT DISTINCT ?s WHERE { ${pattern(`?s a ${iriRef(classIri)}`)} } LIMIT ${limit} } ${pattern('?s ?p ?o')}`;
}

export function sampleQuery(classIri: string, limit: number, graph = ''): string {
  return `CONSTRUCT { ?s ?p ?o } WHERE { ${samplePattern(classIri, limit, graph)} }`;
}

export function endpointUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Enter a complete endpoint URL, such as https://example.org/sparql.'); }
  if (url.username || url.password) throw new Error('Use an endpoint URL without a username or password; this check sends no credentials.');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Use HTTPS for the endpoint so your browser can read it securely; HTTP is allowed only on localhost.');
  if (url.hash) throw new Error('Use an endpoint URL without a fragment (#).');
  return url;
}

/** Read the selected version, rather than the working draft's term view. */
export function endpointClasses(turtle: string, namespace: string): string[] {
  const doc = parseTurtle(turtle);
  if (doc.error) throw new Error(`Could not read this version's classes: ${doc.error.message}`);
  const deprecated = new Set(doc.triples.filter((t) => t.p.term.value === `${OWL}deprecated` && ['true', '1'].includes(t.o.term.value)).map((t) => t.s.term.value));
  return [...new Set(doc.triples.filter((t) => t.s.term.kind === 'iri' && t.s.term.value.startsWith(namespace) && t.p.term.value === RDF_TYPE && t.o.term.value === `${OWL}Class` && !deprecated.has(t.s.term.value)).map((t) => t.s.term.value))].sort();
}

export class EndpointNetworkError extends Error {}
export type EndpointSample = {
  text: string;
  host: string;
  triples: number;
  /** Triples retained for each class query; zero also covers classes the budget left out. */
  counts: Record<string, number>;
  classesSampled: number;
  seconds: number;
  cutShort?: 'triples' | 'bytes';
};

/** Parse RDF, then serialize terms: blank labels inside literals and IRIs are never touched. */
export function responseTriples(text: string, queryIndex: number, base: string, partial = false): string[] {
  const doc = parseTurtle(text, { base });
  if (doc.error && !partial) throw new Error(`The endpoint returned RDF that could not be read: ${doc.error.message}`);
  const blanks = new Map<string, string>();
  const term = (t: RdfTerm): string => {
    if (t.kind === 'blank') {
      if (!blanks.has(t.value)) blanks.set(t.value, `_:q${queryIndex}_${t.value.startsWith('generated ') ? `generated_${blanks.size}` : `b_${t.value}`}`);
      return blanks.get(t.value)!;
    }
    if (t.kind === 'iri') return `<${t.value.replace(/[\u0000-\u0020<>"{}|^`\\]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}>`;
    const literal = JSON.stringify(t.value);
    return t.lang ? `${literal}@${t.lang}` : t.datatype ? `${literal}^^${term({ kind: 'iri', value: t.datatype })}` : literal;
  };
  return doc.triples.map((t) => `${term(t.s.term)} ${term(t.p.term)} ${term(t.o.term)} .\n`);
}

export function responseFormat(contentType: string | null, host: string): 'ntriples' | 'turtle' {
  const type = contentType?.split(';')[0].trim().toLowerCase();
  if (type === 'application/n-triples') return 'ntriples';
  if (type === 'text/turtle' || type === 'application/turtle' || type === 'application/x-turtle') return 'turtle';
  throw new Error(`${host} returned ${type || 'no Content-Type'}, rather than N-Triples or Turtle.`);
}

export async function fetchEndpointSample({ endpoint, graph = '', limit, classes, title, controller = new AbortController(), onProgress, budgets = DATA_CHECK_LIMITS, timeoutMs = 30_000 }: {
  endpoint: string; graph?: string; limit: number; classes: string[]; title: string; controller?: AbortController;
  onProgress?: (completed: number, total: number) => void; budgets?: { bytes: number; triples: number }; timeoutMs?: number;
}): Promise<EndpointSample> {
  const url = endpointUrl(endpoint);
  if (!classes.length) throw new Error('This version has no classes to sample.');
  // Validate every template before sending anything.
  const queries = classes.map((c) => sampleQuery(c, limit, graph));
  const started = performance.now();
  const lines = new Set<string>();
  // The same run controller also stops in-flight requests when the sample is full.
  // This reason means success with a bounded sample, rather than Cancel or a failure.
  const budgetReached = new DOMException('Sample budget reached', 'QuotaExceededError');
  const counts: Record<string, number> = Object.fromEntries(classes.map((c) => [c, 0]));
  const encoder = new TextEncoder();
  let received = 0, written = 0, next = 0, completed = 0;
  let cutShort: EndpointSample['cutShort'];
  const add = (triples: string[], index: number) => {
    for (const line of triples) {
      if (lines.has(line)) { counts[classes[index]]++; continue; }
      const size = encoder.encode(line).length;
      if (lines.size >= budgets.triples) { cutShort = 'triples'; break; }
      if (written + size > budgets.bytes) { cutShort ??= 'bytes'; break; }
      lines.add(line);
      counts[classes[index]]++;
      written += size;
      if (lines.size >= budgets.triples) cutShort = 'triples';
    }
  };
  const query = async (index: number) => {
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await fetch(url.href, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/n-triples, text/turtle;q=0.9' },
        body: new URLSearchParams({ query: queries[index] }), credentials: 'omit', mode: 'cors', redirect: 'follow', signal,
      });
      reader = response.body?.getReader();
      if (!response.ok) {
        const decoder = new TextDecoder();
        let detail = '', bytes = 0;
        while (reader && detail.length < 300 && bytes < 1200) {
          const chunk = await reader.read();
          if (chunk.done) break;
          const part = chunk.value.subarray(0, 1200 - bytes);
          bytes += part.length;
          detail += decoder.decode(part, { stream: true });
        }
        detail = (detail + decoder.decode()).slice(0, 300).trim();
        throw new Error(`${url.host} returned HTTP ${response.status}${detail ? `: ${detail}` : '.'}`);
      }
      const format = responseFormat(response.headers.get('Content-Type'), url.host);
      const decoder = new TextDecoder();
      let pending = '';
      counts[classes[index]] = 0;
      while (reader && !cutShort) {
        const { done, value } = await reader.read();
        if (done) break;
        signal.throwIfAborted();
        const available = Math.max(0, budgets.bytes - received);
        const accepted = value.subarray(0, available);
        received += accepted.length;
        const byteStop = received >= budgets.bytes;
        pending += decoder.decode(accepted, { stream: true });
        if (format === 'ntriples') {
          const end = pending.lastIndexOf('\n');
          if (end >= 0) {
            add(responseTriples(pending.slice(0, end + 1), index, url.href), index);
            pending = pending.slice(end + 1);
          }
        }
        if (byteStop) cutShort ??= 'bytes';
      }
      pending += decoder.decode();
      if (!cutShort || format === 'turtle') add(responseTriples(pending, index, url.href, !!cutShort), index);
      else if (pending.trim()) {
        // A byte boundary may coincide with a complete final line without a newline.
        // Never salvage an incomplete N-Triples line (including a truncated literal).
        const tail = parseTurtle(pending, { base: url.href });
        if (!tail.error) add(responseTriples(pending, index, url.href), index);
      }
      if (cutShort) controller.abort(budgetReached);
      completed++;
      onProgress?.(completed, classes.length);
    } catch (e) {
      if (controller.signal.reason === budgetReached) return;
      if (controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      if (signal.reason?.name === 'TimeoutError') throw new Error(`${url.host} took longer than ${timeoutMs / 1000} s to answer. Try fewer resources per class.`);
      if (e instanceof TypeError) throw new EndpointNetworkError(`Your browser couldn't read ${url.host}. The endpoint has to accept requests from web pages on other sites (CORS), and be reachable from this device.`);
      const message = (e as Error).message ?? 'The sample could not be read.';
      throw new Error(message.includes(url.host) ? message : `${url.host}: ${message}`);
    } finally {
      await reader?.cancel().catch(() => {});
    }
  };
  try {
    onProgress?.(0, classes.length);
    await Promise.all(Array.from({ length: Math.min(3, classes.length) }, async () => {
      while (next < classes.length && !cutShort) {
        controller.signal.throwIfAborted();
        await query(next++);
      }
    }));
    if (controller.signal.reason !== budgetReached) controller.signal.throwIfAborted();
    if (!lines.size && cutShort) throw new Error(`${url.host} reached the sample limit before a complete triple could be read. Try fewer resources per class.`);
    if (!lines.size) throw new Error(`${url.host} has no instances of ${title}'s classes${graph ? ' in that graph' : ''}.`);
    return { text: [...lines].join(''), host: url.host, triples: lines.size, counts, classesSampled: completed, seconds: (performance.now() - started) / 1000, cutShort };
  } catch (e) {
    controller.abort();
    throw e;
  }
}

export function endpointDrift(terms: DataValidation['terms'], namespace: string, counts: Record<string, number>) {
  const seen = new Set<string>();
  const undefinedTerms: DataValidation['terms'] = [];
  for (const term of terms) {
    if (term.severity !== 'error' || !term.term?.startsWith(namespace) || seen.has(term.term)) continue;
    seen.add(term.term);
    undefinedTerms.push(term);
  }
  return {
    undefinedTerms,
    emptyClasses: Object.keys(counts).filter((c) => counts[c] === 0),
  };
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'"'"'`)}'`;
/** All classes in one bounded CONSTRUCT; no query file or shell interpolation needed. */
export function endpointFallback(endpoint: string, iri: string, classes: string[], limit: number, graph = ''): string {
  const body = classes.map((c) => `{ ${samplePattern(c, limit, graph)} }`).join(' UNION ');
  const query = `CONSTRUCT { ?s ?p ?o } WHERE { ${body} }`;
  return `curl -sS -H 'Accept: application/n-triples' --data-urlencode ${shellQuote(`query=${query}`)} ${shellQuote(endpointUrl(endpoint).href)} | curl -sS -X POST -H 'Content-Type: application/n-triples' --data-binary @- ${shellQuote(iri)}`;
}
