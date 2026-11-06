import type { ChangeLevel, Role } from '@concord/shared';
import { ROLE_INFO } from '@concord/shared';

export function relativeTime(iso: string | undefined, now: number = Date.now()): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const diff = t - now;
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 365 * 86400e3],
    ['month', 30 * 86400e3],
    ['week', 7 * 86400e3],
    ['day', 86400e3],
    ['hour', 3600e3],
    ['minute', 60e3],
  ];
  for (const [unit, ms] of units) if (abs >= ms) return rtf.format(Math.round(diff / ms), unit);
  return diff > 0 ? 'in a moment' : 'just now';
}

export function formatDate(iso?: string, withTime = false): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-GB', withTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' });
}

/** "2 days 4 hours" style countdown. */
export function duration(ms: number): string {
  const abs = Math.abs(ms);
  const d = Math.floor(abs / 86400e3);
  const h = Math.floor((abs % 86400e3) / 3600e3);
  const m = Math.floor((abs % 3600e3) / 60e3);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function pct(x: number | undefined): string {
  if (x === undefined || Number.isNaN(x)) return '–';
  return `${Math.round(x * 100)}%`;
}

export function localName(iri: string): string {
  const m = iri.match(/[#/:]([^#/:]+)$/);
  return m ? m[1] : iri;
}

export function compactIri(iri: string, prefixes: Record<string, string> = {}): string {
  let best: [string, string] | undefined;
  for (const [p, ns] of Object.entries(prefixes)) {
    if (ns && iri.startsWith(ns) && (!best || ns.length > best[1].length)) best = [p, ns];
  }
  if (best) return `${best[0]}:${iri.slice(best[1].length)}`;
  const common: Record<string, string> = {
    'http://www.w3.org/2001/XMLSchema#': 'xsd',
    'http://www.w3.org/2002/07/owl#': 'owl',
    'http://www.w3.org/2000/01/rdf-schema#': 'rdfs',
    'http://www.w3.org/1999/02/22-rdf-syntax-ns#': 'rdf',
    'http://www.w3.org/2004/02/skos/core#': 'skos',
    'http://purl.org/dc/terms/': 'dcterms',
  };
  for (const [ns, p] of Object.entries(common)) if (iri.startsWith(ns)) return `${p}:${iri.slice(ns.length)}`;
  return iri;
}

const XSD_NS = 'http://www.w3.org/2001/XMLSchema#';
const RDF_NS = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RDFS_NS = 'http://www.w3.org/2000/01/rdf-schema#';

/** Plain names for the datatypes people meet most; anything else is spelled out from its local name. */
const DATATYPE_NAMES: Record<string, string> = {
  [`${XSD_NS}string`]: 'String',
  [`${XSD_NS}boolean`]: 'Boolean',
  [`${XSD_NS}integer`]: 'Integer',
  [`${XSD_NS}int`]: 'Integer',
  [`${XSD_NS}long`]: 'Integer',
  [`${XSD_NS}short`]: 'Integer',
  [`${XSD_NS}nonNegativeInteger`]: 'Non-negative integer',
  [`${XSD_NS}nonPositiveInteger`]: 'Non-positive integer',
  [`${XSD_NS}decimal`]: 'Decimal',
  [`${XSD_NS}double`]: 'Number',
  [`${XSD_NS}float`]: 'Number',
  [`${XSD_NS}date`]: 'Date',
  [`${XSD_NS}dateTime`]: 'Date and time',
  [`${XSD_NS}dateTimeStamp`]: 'Date and time',
  [`${XSD_NS}time`]: 'Time',
  [`${XSD_NS}duration`]: 'Duration',
  [`${XSD_NS}dayTimeDuration`]: 'Duration',
  [`${XSD_NS}yearMonthDuration`]: 'Duration',
  [`${XSD_NS}gYear`]: 'Year',
  [`${XSD_NS}gYearMonth`]: 'Year and month',
  [`${XSD_NS}gMonth`]: 'Month',
  [`${XSD_NS}gMonthDay`]: 'Month and day',
  [`${XSD_NS}gDay`]: 'Day of the month',
  [`${XSD_NS}anyURI`]: 'URL',
  [`${XSD_NS}language`]: 'Language tag',
  [`${RDF_NS}langString`]: 'Text with a language',
  [`${RDF_NS}HTML`]: 'HTML',
  [`${RDF_NS}XMLLiteral`]: 'XML',
  [`${RDF_NS}JSON`]: 'JSON',
  [`${RDF_NS}PlainLiteral`]: 'Text',
  [`${RDFS_NS}Literal`]: 'Any value',
};

/**
 * A well-known datatype's plain name ("Boolean" for xsd:boolean), or undefined for any other IRI.
 * Unlisted XSD types are spelled out from their local name ("unsignedByte" → "Unsigned byte").
 */
export function datatypeName(iri: string): string | undefined {
  const known = DATATYPE_NAMES[iri];
  if (known) return known;
  if (!iri.startsWith(XSD_NS)) return undefined;
  const local = iri.slice(XSD_NS.length).replace(/([a-z])([A-Z])/g, (_, a: string, b: string) => `${a} ${b.toLowerCase()}`);
  return local ? local[0].toUpperCase() + local.slice(1) : undefined;
}

export function roleLabel(r: Role | string): string {
  return (ROLE_INFO as Record<string, { label: string }>)[r]?.label ?? r;
}

export const LEVEL_LABEL: Record<ChangeLevel, string> = { patch: 'Patch', minor: 'Minor', major: 'Major' };

export function initials(name?: string): string {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

export function plural(n: number, word: string, pluralWord = `${word}s`) {
  return `${n} ${n === 1 ? word : pluralWord}`;
}

export function titleCase(s: string | undefined | null) {
  return (s ?? '').replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function download(filename: string, content: string, type = 'text/plain') {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The public, dereferenceable page for an ontology (latest release) or one version of it. Served by the API server, not the app. */
export function publicPageUrl(slug: string, version?: string): string {
  return `/def/${encodeURIComponent(slug)}${version ? `/${encodeURIComponent(version)}` : ''}`;
}
