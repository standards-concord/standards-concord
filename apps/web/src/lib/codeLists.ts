import type { OntologyView } from '@concord/shared';

export function codeListNamespace(v: OntologyView) {
  const m = v.metadata;
  if (m.preferredNamespace) return m.preferredNamespace;
  if (!m.iri || /[#/]$/.test(m.iri)) return m.iri;
  for (const sep of ['#', '/']) if (Object.values(v.prefixes).includes(m.iri + sep)) return m.iri + sep;
  return m.iri + '#';
}
export function derivedCodeName(label: string, scheme = false) {
  const words = label.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return scheme ? words.map((w) => w[0].toUpperCase() + w.slice(1)).join('') : words.join('-');
}

