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
describe('converted Solid ecosystem samples', () => {
  for (const sample of SAMPLE_VOCABULARIES) it(`${sample.slug} is reproducible and passes seeded/release OWL checks`, async () => {
    const source = fs.readFileSync(new URL(`upstream/${sample.upstreamCopy}`, root), 'utf8');
    const turtle = fs.readFileSync(new URL(`${sample.slug}.ttl`, root), 'utf8');
    expect(convertSample(source, sample)).toBe(turtle);
    expect(convertSample(source, sample)).toBe(turtle);
    const graph = await OntologyGraph.fromTurtle(turtle);
    expect(graph.namespace).toBe(sample.namespace);
    const upstream = parseSampleSource(source, sample);
    const convertedIris = new Set([...graph.store].flatMap((q) => [q.subject, q.predicate, q.object]).filter((t) => t.termType === 'NamedNode').map((t) => t.value));
    for (const q of upstream) {
      for (const term of [q.subject, q.predicate, q.object]) if (term.termType === 'NamedNode' && term.value.startsWith(sample.namespace)) expect(convertedIris.has(term.value), term.value).toBe(true);
      if (q.subject.termType === 'NamedNode' && q.subject.value.startsWith(sample.namespace) && q.subject.value !== sample.namespace && [NS.rdfs + 'label', NS.rdfs + 'comment'].includes(q.predicate.value)) expect(graph.store.countQuads(q.subject, q.predicate, q.object, null)).toBeGreaterThan(0);
    }
    const header = DataFactory.namedNode(sample.source);
    for (const [predicate, iri] of [[NS.dcterms + 'source', sample.source], [NS.prov + 'wasDerivedFrom', sample.source], [NS.dcterms + 'license', sample.licence.url]]) expect(graph.store.countQuads(header, DataFactory.namedNode(predicate), DataFactory.namedNode(iri), null)).toBe(1);
    expect(graph.store.getObjects(header, DataFactory.namedNode(NS.dcterms + 'rights'), null).some((t) => t.value.includes(sample.publisher))).toBe(true);
    expect(graph.store.getObjects(header, DataFactory.namedNode(NS.rdfs + 'comment'), null).some((t) => t.value.includes(sample.changes))).toBe(true);
    const strict = await checkOwlDl(turtle);
    expect(strict, JSON.stringify(strict)).toMatchObject({ consistent: true, classification: 'complete', profile: { dl: true, violations: [], unchecked: [] } });
    const result = await owlReasoner(graph);
    expect(result, JSON.stringify(result)).toMatchObject({ available: true, checked: 'complete', consistent: true, unsatisfiable: [] });
    expect(result.profile ?? []).toEqual([]);
    expect(lint(graph).filter((i) => ['undeclared-term', 'datatype-range-is-class', 'object-range-is-datatype', 'property-kind-conflict'].includes(i.code))).toEqual([]);
    expect(graph.view().metadata.license).toBe(sample.licence.url);
  }, 60_000);
});
