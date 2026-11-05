/**
 * RDF data formats the validator reads, with no dependencies, so the web app
 * can use them without bundling the parsers (import '@concord/core/data-formats').
 */

export type DataFormat = 'turtle' | 'ntriples' | 'nquads' | 'trig' | 'jsonld' | 'rdfxml';

export const DATA_FORMATS: Record<DataFormat, { label: string; mediaType: string; extensions: string[] }> = {
  turtle: { label: 'Turtle', mediaType: 'text/turtle', extensions: ['ttl'] },
  jsonld: { label: 'JSON-LD', mediaType: 'application/ld+json', extensions: ['jsonld', 'json'] },
  ntriples: { label: 'N-Triples', mediaType: 'application/n-triples', extensions: ['nt'] },
  nquads: { label: 'N-Quads', mediaType: 'application/n-quads', extensions: ['nq'] },
  trig: { label: 'TriG', mediaType: 'application/trig', extensions: ['trig'] },
  rdfxml: { label: 'RDF/XML', mediaType: 'application/rdf+xml', extensions: ['rdf', 'owl', 'xml'] },
};

/** Every media type data can be sent as, e.g. for an Accept-Post header. */
export const DATA_MEDIA_TYPES = (Object.keys(DATA_FORMATS) as DataFormat[]).map((f) => DATA_FORMATS[f].mediaType);

/** The data format for a media type (parameters ignored), e.g. "text/turtle; charset=utf-8". */
export function dataFormatForMediaType(mediaType: string | undefined): DataFormat | undefined {
  const type = mediaType?.split(';')[0].trim().toLowerCase();
  if (!type) return undefined;
  if (type === 'application/json') return 'jsonld';
  if (type === 'application/xml' || type === 'text/xml') return 'rdfxml';
  return (Object.keys(DATA_FORMATS) as DataFormat[]).find((f) => DATA_FORMATS[f].mediaType === type);
}

/** The data format for a file name, by extension. */
export function dataFormatForFile(name: string): DataFormat | undefined {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  return (Object.keys(DATA_FORMATS) as DataFormat[]).find((f) => DATA_FORMATS[f].extensions.includes(ext));
}

/** A best guess at the format of pasted text. */
export function sniffDataFormat(text: string): DataFormat {
  const head = text.trimStart();
  if (head.startsWith('{') || head.startsWith('[')) return 'jsonld';
  if (head.startsWith('<?xml') || /^<rdf:RDF\b/.test(head)) return 'rdfxml';
  // A graph block ({ … } after a graph name) only appears in TriG.
  if (/^\s*(GRAPH\s+)?(<[^>]*>|[\w-]*:[\w-]*)\s*\{/im.test(text)) return 'trig';
  return 'turtle';
}
