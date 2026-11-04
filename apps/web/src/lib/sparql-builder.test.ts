import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SparqStore } from '@sparq-org/sparq';
import { buildSparql, newStep, updateStep, type BuilderModel } from './sparql-builder';

const VOL = 'https://w3id.org/odi/volunteering#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const prefixes = { vol: VOL, rdfs: RDFS, owl: 'http://www.w3.org/2002/07/owl#' };
const fixture = (f: string) => readFileSync(new URL(`../../../../packages/core/fixtures/${f}`, import.meta.url), 'utf8');

function model(partial: Partial<BuilderModel> = {}): BuilderModel {
  return { rootClass: `${VOL}VolunteeringOpportunity`, includeSubclasses: true, steps: [], distinct: true, countOnly: false, descending: false, ...partial };
}

describe('buildSparql', () => {
  it('finds instances of a class, including subclasses, with only the prefixes it uses', () => {
    const { query } = buildSparql(model(), { prefixes });
    expect(query).toBe(
      [
        'PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>',
        'PREFIX vol: <https://w3id.org/odi/volunteering#>',
        '',
        'SELECT DISTINCT ?volunteeringOpportunity',
        'WHERE {',
        '  ?volunteeringOpportunity a/rdfs:subClassOf* vol:VolunteeringOpportunity .',
        '}',
      ].join('\n'),
    );
  });

  it('nests object-property steps, wraps optional ones and orders and limits', () => {
    const title = { ...newStep(`${VOL}title`) };
    const org = { ...newStep(`${VOL}offeredBy`), optional: false, show: false };
    const orgLabel = newStep(`${RDFS}label`);
    org.children = [orgLabel];
    const { query, variables } = buildSparql(model({ includeSubclasses: false, steps: [title, org], orderBy: title.id, limit: 10 }), { prefixes });
    expect(variables[orgLabel.id]).toBe('offeredBy_label');
    expect(query).toContain('SELECT DISTINCT ?volunteeringOpportunity ?title ?offeredBy_label');
    expect(query).toContain('  OPTIONAL {\n    ?volunteeringOpportunity vol:title ?title .\n  }');
    expect(query).toContain('  ?volunteeringOpportunity vol:offeredBy ?offeredBy .\n  OPTIONAL {\n    ?offeredBy rdfs:label ?offeredBy_label .\n  }');
    expect(query).toMatch(/ORDER BY \?title\nLIMIT 10$/);
  });

  it('makes filtered steps required and escapes the filter value', () => {
    const title = { ...newStep(`${VOL}title`), filter: { op: 'contains' as const, value: 'Park "Clean"' } };
    const { query } = buildSparql(model({ steps: [title] }), { prefixes });
    expect(query).not.toContain('OPTIONAL');
    expect(query).toContain('FILTER(CONTAINS(LCASE(STR(?title)), "park \\"clean\\""))');
  });

  it('compares numbers numerically and IRIs as IRIs', () => {
    const age = { ...newStep(`${VOL}minimumAge`), filter: { op: 'gt' as const, value: '15' } };
    const org = { ...newStep(`${VOL}offeredBy`), filter: { op: 'equals' as const, value: 'https://example.org/volunteering-data/greenSpacesTrust' } };
    const { query } = buildSparql(model({ steps: [age, org] }), { prefixes });
    expect(query).toContain('FILTER(?minimumAge > 15)');
    expect(query).toContain('FILTER(?offeredBy = <https://example.org/volunteering-data/greenSpacesTrust>)');
  });

  it('counts instead of listing', () => {
    const { query } = buildSparql(model({ countOnly: true, limit: 5, steps: [newStep(`${VOL}title`)] }), { prefixes });
    expect(query).toContain('SELECT (COUNT(DISTINCT ?volunteeringOpportunity) AS ?count)');
    expect(query).not.toContain('LIMIT');
  });

  it('keeps variable names unique', () => {
    const a = newStep(`${VOL}title`);
    const b = newStep(`https://example.org/other#title`);
    const { variables } = buildSparql(model({ steps: [a, b] }), { prefixes });
    expect(new Set([variables[a.id], variables[b.id]]).size).toBe(2);
  });

  it('updates and removes steps anywhere in the tree', () => {
    const child = newStep(`${RDFS}label`);
    const parent = { ...newStep(`${VOL}offeredBy`), children: [child] };
    const renamed = updateStep([parent], child.id, (s) => ({ ...s, show: false }));
    expect(renamed[0].children[0].show).toBe(false);
    expect(updateStep([parent], child.id, () => null)[0].children).toHaveLength(0);
  });
});

describe('generated queries run on sparq', () => {
  it('returns the example data the builder asked for', async () => {
    const store = await SparqStore.fromString(`${fixture('volunteering.ttl')}\n${fixture('volunteering-example-data.ttl')}`, 'turtle');
    const title = newStep(`${VOL}title`);
    const org = { ...newStep(`${VOL}offeredBy`), show: false, optional: false };
    const orgLabel = newStep(`${RDFS}label`);
    org.children = [orgLabel];
    const age = { ...newStep(`${VOL}minimumAge`), filter: { op: 'gt' as const, value: '15' } };
    const { query, variables } = buildSparql(model({ steps: [title, org, age], orderBy: title.id }), { prefixes });
    const json = JSON.parse(store.queryJson(query)) as { results: { bindings: Record<string, { value: string }>[] } };
    const rows = json.results.bindings;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((r) => r[variables[title.id]].value)).toContain('Saturday park clean-up');
    expect(rows.find((r) => r[variables[title.id]].value === 'Saturday park clean-up')?.[variables[orgLabel.id]].value).toBe('Green Spaces Trust');
    const { query: count } = buildSparql(model({ countOnly: true }), { prefixes });
    const n = JSON.parse(store.queryJson(count)).results.bindings[0].count.value;
    expect(Number(n)).toBeGreaterThanOrEqual(rows.length);
    store.free();
  });
});
