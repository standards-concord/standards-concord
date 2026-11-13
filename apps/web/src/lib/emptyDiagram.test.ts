import { expect, it } from 'vitest';
import { OntologyGraph } from '@concord/core';
import { layoutDiagram, DEFAULT_DIAGRAM_OPTIONS } from '../components/ontology-viz/ClassDiagram';
import { buildModel } from './ontologyModel';

it('an empty diagram has zero bounds so it is never fitted or exported', () => {
  // Dagre used to return infinite bounds for an empty graph, causing an invalid SVG transform.
  const view = OntologyGraph.empty({ iri: 'https://example.org/empty', namespace: 'https://example.org/empty#', prefix: 'ex', title: 'Empty' }).view();
  const layout = layoutDiagram(buildModel(view), new Set(), DEFAULT_DIAGRAM_OPTIONS, (iri) => iri);
  expect(layout.nodes).toEqual([]);
  expect(layout.width).toBe(0);
  expect(layout.height).toBe(0);
});
