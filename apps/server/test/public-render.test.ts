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

// A code the standard adds to another vocabulary's code list used to vanish from the page while the JSON-LD still named it.
it('the renderer keeps an own code whose code list belongs to another vocabulary', async () => {
  const graph = await OntologyGraph.fromTurtle(`
    @prefix ex: <https://example.org/own#> .
    @prefix other: <https://other.example/vocab#> .
    @prefix owl: <http://www.w3.org/2002/07/owl#> .
    @prefix skos: <http://www.w3.org/2004/02/skos/core#> .
    <https://example.org/own> a owl:Ontology .
    other:Scheme a skos:ConceptScheme ; skos:prefLabel "Outside list"@en .
    ex:Code a skos:Concept ; skos:inScheme other:Scheme ; skos:prefLabel "Own code"@en ; skos:notation "OC" .
  `);
  const html = renderOntologyPage(page(graph));
  expect(html).toContain('id="Code"');
  expect(html).toContain('href="#Code"');
  expect(html).not.toContain('id="Scheme"');
  expect(html).toContain('Codes in other code lists');
  expect(html).toContain('https://other.example/vocab#Scheme');
  const json = JSON.parse(html.match(/<script type="application\/ld\+json">([^]*?)<\/script>/)![1]);
  expect(json.hasDefinedTerm.map((t: { '@id': string }) => t['@id'])).toEqual(['https://example.org/own#Code']);
});

// Listing such a code on its own must not give a second entry (and a duplicate id) to one that is also a class.
it('the renderer gives one entry to an own term that is both a class and a code in an outside list', async () => {
  const graph = await OntologyGraph.fromTurtle(`
    @prefix ex: <https://example.org/own#> .
    @prefix other: <https://other.example/vocab#> .
    @prefix owl: <http://www.w3.org/2002/07/owl#> .
    @prefix skos: <http://www.w3.org/2004/02/skos/core#> .
    <https://example.org/own> a owl:Ontology .
    other:Scheme a skos:ConceptScheme .
    ex:Code a owl:Class, skos:Concept ; skos:inScheme other:Scheme .
  `);
  const html = renderOntologyPage(page(graph));
  expect(html.match(/id="Code"/g)).toHaveLength(1);
  expect(html).not.toContain('Codes in other code lists');
});
