import { describe, expect, it } from 'vitest';
import { datatypeName } from './format';
import { makeLabeler } from './ontology';

const XSD = 'http://www.w3.org/2001/XMLSchema#';

describe('datatypeName', () => {
  it('gives well-known XSD types plain names, without the xsd: prefix', () => {
    expect(datatypeName(`${XSD}boolean`)).toBe('Boolean');
    expect(datatypeName(`${XSD}string`)).toBe('String');
    expect(datatypeName(`${XSD}nonNegativeInteger`)).toBe('Non-negative integer');
    expect(datatypeName(`${XSD}dateTime`)).toBe('Date and time');
    expect(datatypeName('http://www.w3.org/2000/01/rdf-schema#Literal')).toBe('Any value');
  });

  it('spells out other XSD types from their local name', () => {
    expect(datatypeName(`${XSD}unsignedByte`)).toBe('Unsigned byte');
    expect(datatypeName(`${XSD}NCName`)).toBe('NCName');
  });

  it('leaves anything that is not a datatype alone', () => {
    expect(datatypeName('https://w3id.org/odi/volunteering#Volunteer')).toBeUndefined();
    expect(datatypeName('http://www.w3.org/1999/02/22-rdf-syntax-ns#type')).toBeUndefined();
  });

  it('is what the labeler shows for a datatype', () => {
    expect(makeLabeler()(`${XSD}boolean`)).toBe('Boolean');
    expect(makeLabeler()('http://www.w3.org/2002/07/owl#Thing')).toBe('owl:Thing');
  });
});
