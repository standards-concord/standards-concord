import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { OntologyGraph, applyChangeOps } from '../src/index.js';
import type { ChangeOp } from '../src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES = path.resolve(here, '../fixtures');
export const TOOLKIT = path.resolve(here, '../../../toolkit');

export const fixtureText = (name: string) => readFileSync(path.join(FIXTURES, name), 'utf8');
export const loadFixture = () => OntologyGraph.fromTurtle(fixtureText('volunteering.ttl'));

export const NSX = 'https://example.org/test#';
export const X = (local: string) => NSX + local;

/** True when toolkit/.venv has owlready2 and Java is on PATH. */
export const hasOwlToolkit = existsSync(path.join(TOOLKIT, '.venv', 'bin', 'python'));
export const linkmlBin = (tool: string) => path.join(TOOLKIT, '.venv', 'bin', tool);

/** A small base ontology: Agent > Person, Organisation (disjoint); Place; worksFor; name. */
export function baseOntology(): OntologyGraph {
  const g = OntologyGraph.empty({
    iri: 'https://example.org/test', namespace: NSX, prefix: 'ex', title: 'Test ontology',
    description: 'A small ontology used in tests.', creators: ['Test Author'],
  });
  const ops: ChangeOp[] = [
    { op: 'addClass', localName: 'Agent', label: 'agent', definition: 'An entity that can act.' },
    { op: 'addClass', localName: 'Person', label: 'person', definition: 'An agent that is a human being.', subClassOf: [X('Agent')] },
    { op: 'addClass', localName: 'Organisation', label: 'organisation', definition: 'An agent that is a group of people.', subClassOf: [X('Agent')], disjointWith: [X('Person')] },
    { op: 'addClass', localName: 'Employee', label: 'employee', definition: 'A person who is employed by an organisation.', subClassOf: [X('Person')] },
    { op: 'addClass', localName: 'Place', label: 'place', definition: 'A location in space.' },
    { op: 'addObjectProperty', localName: 'worksFor', label: 'works for', definition: 'Relates a person to an organisation that employs them.', domain: [X('Person')], range: [X('Organisation')] },
    { op: 'addObjectProperty', localName: 'knows', label: 'knows', definition: 'Relates a person to a person they know.', domain: [X('Person')], range: [X('Person')] },
    { op: 'addDatatypeProperty', localName: 'name', label: 'name', definition: 'The name of an agent.', domain: [X('Agent')], range: ['http://www.w3.org/2001/XMLSchema#string'] },
    { op: 'addDatatypeProperty', localName: 'age', label: 'age', definition: 'The age of a person in years.', domain: [X('Person')], range: ['http://www.w3.org/2001/XMLSchema#integer'] },
  ];
  return applyChangeOps(g, ops, { date: '2026-01-01', author: 'Test Author' }).graph;
}
