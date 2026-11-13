import type { OntologyGraph } from './graph.js';
import { NS } from './ns.js';
import { nn } from './rdf.js';

/** Notices belong to the ontology, including derivatives that no longer contain its RDF header. */
export function distributionNotice(graph: OntologyGraph): string {
  if (!graph.ontologyIRI) return '';
  const predicates = [
    [NS.dcterms + 'license', 'Licence'], [NS.dc + 'license', 'Licence'],
    [NS.dcterms + 'rights', 'Rights'], [NS.dc + 'rights', 'Rights'],
    [NS.dcterms + 'source', 'Source'], [NS.dc + 'source', 'Source'],
    [NS.dcterms + 'creator', 'Creator'], [NS.dc + 'creator', 'Creator'],
    [NS.dcterms + 'contributor', 'Contributor'], [NS.dc + 'contributor', 'Contributor'],
    ['http://creativecommons.org/ns#attributionName', 'Attribution'],
    ['http://creativecommons.org/ns#attributionURL', 'Attribution URL'],
    ['https://schema.org/copyrightNotice', 'Copyright'], ['http://schema.org/copyrightNotice', 'Copyright'],
    // Conversion/modification notices are commonly recorded as ontology comments.
    [NS.rdfs + 'comment', 'Notice'],
  ];
  const notices = predicates.flatMap(([predicate, label]) => graph.store
    .getObjects(nn(graph.ontologyIRI), nn(predicate), null)
    .map((value) => {
      if (value.termType === 'Literal') return `${label}: ${value.value}`;
      const names = [NS.foaf + 'name', NS.schema + 'name', NS.rdfs + 'label']
        .flatMap((p) => graph.store.getObjects(value, nn(p), null).map((name) => name.value));
      const parts = [...new Set([...(value.termType === 'BlankNode' ? [] : [value.value]), ...names])];
      return `${label}: ${parts.join(' — ') || value.value}`;
    })
    .sort());
  return [...new Set(notices)].join('\n\n');
}

/** Keep multiline notices inside comments, including text that could otherwise close a JS comment. */
export function noticeComment(notice: string, style: 'hash' | 'block' = 'hash'): string {
  if (!notice) return '';
  const lines = notice.replace(/\r\n?/g, '\n').split('\n');
  return style === 'hash'
    ? lines.map((line) => `# ${line}\n`).join('') + '\n'
    : '/**\n' + lines.map((line) => ` * ${line.replace(/\*\//g, '* /')}\n`).join('') + ' */\n\n';
}
