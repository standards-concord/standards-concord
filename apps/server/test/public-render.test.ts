import { expect, it } from 'vitest';
import { OntologyGraph } from '@concord/core';
import { renderOntologyPage, type OntologyPageInput } from '../src/public/render.js';

const project = { title: 'Own terms', slug: 'own', prefix: 'ex', description: '', namespace: 'https://example.org/own#', ontologyIRI: 'https://example.org/own' };
const page = (graph: OntologyGraph): OntologyPageInput => ({
  project, view: graph.view({ includeVocabularyDeclarations: true }), kind: 'draft', version: 'draft', releases: [], downloads: [], pageUrl: 'https://example.org/def/own/draft',
  links: { latest: '/def/own', draft: '/def/own/draft', versionBase: '/def/own' }, requirements: { useCases: [] }, generatedAt: '2026-11-13T00:00:00Z',
});

// The page used to present dcterms:title and friends as terms of the standard.
it('the renderer excludes outside declarations but includes a term explicitly defined by this ontology', async () => {
  const graph = await OntologyGraph.fromTurtle(`
    @prefix ex: <https://example.org/own#> .
    @prefix other: <https://other.example/vocab#> .
    @prefix owl: <http://www.w3.org/2002/07/owl#> .
    @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
    @prefix dcterms: <http://purl.org/dc/terms/> .
    <https://example.org/own> a owl:Ontology .
    ex:Local a owl:Class ; rdfs:subClassOf other:Outside .
    other:Adopted a owl:Class ; rdfs:isDefinedBy <https://example.org/own> .
    other:Outside a owl:Class . dcterms:title a owl:AnnotationProperty .
  `);
  const html = renderOntologyPage(page(graph));
  expect(html).not.toContain('id="Outside"');
  expect(html).not.toContain('href="#Outside"');
  expect(html).toContain('id="Adopted"');
  expect(html).toContain('id="Local"');
  expect(html).toContain('<summary>Terms from other vocabularies (2)</summary>');
  const json = JSON.parse(html.match(/<script type="application\/ld\+json">([^]*?)<\/script>/)![1]);
  expect(json.hasDefinedTerm.map((t: { '@id': string }) => t['@id']).sort()).toEqual(['https://example.org/own#Local', 'https://other.example/vocab#Adopted']);
});

it('the renderer lists no terms for an empty ontology', () => {
  const html = renderOntologyPage(page(OntologyGraph.empty({ iri: project.ontologyIRI, namespace: project.namespace, prefix: project.prefix, title: project.title, description: '' })));
  expect(html).not.toContain('<article class="term"');
  expect(html).not.toContain('class="nav-group"');
  expect(JSON.parse(html.match(/<script type="application\/ld\+json">([^]*?)<\/script>/)![1]).hasDefinedTerm).toEqual([]);
});
