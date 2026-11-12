import { checkOwlDl } from '@sparq-org/sparq';
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OntologyGraph } from '../src/graph.js';
import { owlReasoner } from '../src/reasoner.js';
import { lint } from '../src/lint.js';
import { NS } from '../src/ns.js';
import { DataFactory } from 'n3';
import { convertSample, parseSampleSource } from '../src/sampleConversion.js';
import { SAMPLE_VOCABULARIES } from '../../shared/src/samples.js';

const root = new URL('../fixtures/samples/', import.meta.url);
const notice = fs.readFileSync(new URL('../../../docs/licences/W3C-20150513.md', import.meta.url), 'utf8');
describe('converted Solid ecosystem samples', () => {
  for (const sample of SAMPLE_VOCABULARIES) it(`${sample.slug} is reproducible and passes seeded/release OWL checks`, async () => {
    const source = fs.readFileSync(new URL(`upstream/${sample.upstreamCopy}`, root), 'utf8');
    const turtle = fs.readFileSync(new URL(`${sample.slug}.ttl`, root), 'utf8');
    expect(convertSample(source, sample, notice)).toBe(turtle);
    expect(convertSample(source, sample, notice)).toBe(turtle);
    const graph = await OntologyGraph.fromTurtle(turtle);
    expect(graph.namespace).toBe(sample.namespace);
    const upstream = parseSampleSource(source, sample);
    const convertedIris = new Set([...graph.store].flatMap((q) => [q.subject, q.predicate, q.object]).filter((t) => t.termType === 'NamedNode').map((t) => t.value));
    for (const q of upstream) {
      for (const term of [q.subject, q.predicate, q.object]) if (term.termType === 'NamedNode' && term.value.startsWith(sample.namespace)) expect(convertedIris.has(term.value), term.value).toBe(true);
      if (q.subject.termType === 'NamedNode' && q.subject.value.startsWith(sample.namespace) && q.subject.value !== sample.namespace && [NS.rdfs + 'label', NS.rdfs + 'comment'].includes(q.predicate.value)) expect(graph.store.countQuads(q.subject, q.predicate, q.object, null)).toBeGreaterThan(0);
      if ([NS.rdfs + 'subPropertyOf', NS.owl + 'inverseOf'].includes(q.predicate.value) && q.subject.termType === 'NamedNode' && q.object.termType === 'NamedNode') {
        const kind = (term: typeof q.object) => graph.store.getObjects(term, DataFactory.namedNode(NS.rdf + 'type'), null).map((t) => t.value).find((t) => ['ObjectProperty', 'DatatypeProperty', 'AnnotationProperty'].some((k) => t === NS.owl + k));
        const a = kind(q.subject), b = kind(q.object);
        if (a && a === b && (q.predicate.value !== NS.owl + 'inverseOf' || a === NS.owl + 'ObjectProperty')) expect(graph.store.countQuads(q.subject, q.predicate, q.object, null), `${q.subject.value} ${q.predicate.value} ${q.object.value}`).toBe(1);
      }
    }
    const header = DataFactory.namedNode(sample.source);
    for (const [predicate, iri] of [[NS.dcterms + 'source', sample.source], [NS.prov + 'wasDerivedFrom', sample.source], [NS.dcterms + 'license', sample.licence.url]]) expect(graph.store.countQuads(header, DataFactory.namedNode(predicate), DataFactory.namedNode(iri), null)).toBe(1);
    expect(graph.store.getObjects(header, DataFactory.namedNode(NS.dcterms + 'rights'), null).some((t) => t.value.includes(sample.publisher))).toBe(true);
    expect(graph.store.getObjects(header, DataFactory.namedNode(NS.rdfs + 'comment'), null).some((t) => t.value.includes(sample.changes))).toBe(true);
    if (sample.copyrightNotice) {
      expect(turtle).toContain(notice.split('\n').map((line) => line ? `# ${line}` : '#').join('\n').trimEnd());
      const rights = graph.store.getObjects(header, DataFactory.namedNode(NS.dcterms + 'rights'), null).map((t) => t.value);
      expect(rights).toContain(notice);
      expect(rights).toContain(sample.copyrightNotice);
      expect(sample.copyrightNotice).toContain('W3C® (MIT, ERCIM, Keio, Beihang).');
      if (!['ldp', 'meeting'].includes(sample.slug)) expect(sample.copyrightNotice).toContain('Copyright (c) W3C®');
    }
    if (sample.authors) for (const author of sample.authors) expect(graph.store.getObjects(header, DataFactory.namedNode(NS.dcterms + 'creator'), null).map((t) => t.value)).toContain(author);
    const has = (s: string, p: string, o: string) => graph.store.countQuads(DataFactory.namedNode(s), DataFactory.namedNode(p), DataFactory.namedNode(o), null);
    if (sample.slug === 'foaf') {
      expect(has(sample.namespace + 'made', NS.owl + 'inverseOf', sample.namespace + 'maker')).toBe(1);
      for (const term of ['made', 'maker']) expect(has(sample.namespace + term, NS.rdf + 'type', NS.owl + 'ObjectProperty')).toBe(1);
      expect(has(sample.namespace + 'maker', NS.owl + 'equivalentProperty', NS.dcterms + 'creator')).toBe(0);
    }
    if (sample.slug === 'vcard') for (const term of ['organization-name', 'organization-unit']) expect(has(sample.namespace + term, NS.rdf + 'type', NS.owl + 'DatatypeProperty')).toBe(1);
    if (sample.slug === 'workflow') expect(has(sample.namespace + 'screenShot', NS.rdfs + 'subPropertyOf', sample.namespace + 'attachment')).toBe(1);
    const strict = await checkOwlDl(turtle);
    expect(strict, JSON.stringify(strict)).toMatchObject({ consistent: true, classification: 'complete', profile: { dl: true, violations: [], unchecked: [] } });
    const result = await owlReasoner(graph);
    expect(result, JSON.stringify(result)).toMatchObject({ available: true, checked: 'complete', consistent: true, unsatisfiable: [] });
    expect(result.profile ?? []).toEqual([]);
    expect(lint(graph).filter((i) => ['undeclared-term', 'datatype-range-is-class', 'object-range-is-datatype', 'property-kind-conflict'].includes(i.code))).toEqual([]);
    expect(graph.view().metadata.license).toBe(sample.licence.url);
  }, 60_000);
});
