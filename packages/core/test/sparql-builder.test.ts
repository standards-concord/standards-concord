import { describe, expect, it } from 'vitest';
import * as ox from 'oxigraph';
import { activeFilter, buildSparql, isRequired, newStep, pathLabels, updateStep, type BuilderModel } from '../src/sparql-builder.js';
import { fixtureText } from './helpers.js';

/** An in-memory Oxigraph store with the same small API the tests used with sparq in the browser. */
const Store = ((ox as any).Store ?? (ox as any).default?.Store) as new () => { load(text: string, opts: { format: string }): void; query(q: string): unknown };
async function storeFrom(turtle: string) {
  const store = new Store();
  store.load(turtle, { format: 'text/turtle' });
  return {
    queryJson(q: string) {
      const solutions = store.query(q) as Map<string, { value: string }>[];
      const bindings = solutions.map((m) => Object.fromEntries([...m.entries()].map(([k, v]) => [k, { value: v.value }])));
      return JSON.stringify({ results: { bindings } });
    },
    free() {},
  };
}

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

const VOL = 'https://w3id.org/odi/volunteering#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const prefixes = { vol: VOL, rdfs: RDFS, owl: 'http://www.w3.org/2002/07/owl#' };
const fixture = fixtureText;

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

  it('compares by the property’s value type, not by what the value looks like', () => {
    const age = { ...newStep(`${VOL}minimumAge`, 'number'), filter: { op: 'gt' as const, value: '15' } };
    const org = { ...newStep(`${VOL}offeredBy`, 'resource'), filter: { op: 'equals' as const, value: 'https://example.org/volunteering-data/greenSpacesTrust' } };
    const kind = { ...newStep(RDF_TYPE, 'resource'), filter: { op: 'equals' as const, value: 'vol:VolunteeringOpportunity' } };
    // Text that looks like a number or a URL is still text.
    const code = { ...newStep(`${VOL}charityNumber`, 'text'), filter: { op: 'equals' as const, value: '00123' } };
    const site = { ...newStep(`${VOL}website`, 'text'), filter: { op: 'equals' as const, value: 'https://example.org/' } };
    const { query } = buildSparql(model({ steps: [age, org, kind, code, site] }), { prefixes });
    expect(query).toContain('FILTER(?minimumAge > 15)');
    expect(query).toContain('FILTER(?offeredBy = <https://example.org/volunteering-data/greenSpacesTrust>)');
    expect(query).toContain('FILTER(?type = vol:VolunteeringOpportunity)');
    expect(query).toContain('FILTER(STR(?charityNumber) = "00123")');
    expect(query).toContain('FILTER(STR(?website) = "https://example.org/")');
  });

  it('a filter deep in the tree makes the whole path to it required', () => {
    const name = { ...newStep(`${RDFS}label`), filter: { op: 'contains' as const, value: 'trust' } };
    const org = { ...newStep(`${VOL}offeredBy`, 'resource'), children: [name] };
    const title = newStep(`${VOL}title`);
    expect(isRequired(org)).toBe(true);
    expect(isRequired(title)).toBe(false);
    const { query } = buildSparql(model({ steps: [title, org] }), { prefixes });
    expect(query).toContain('  ?volunteeringOpportunity vol:offeredBy ?offeredBy .\n  ?offeredBy rdfs:label ?offeredBy_label .\n  FILTER(CONTAINS(LCASE(STR(?offeredBy_label)), "trust"))');
    expect(query).toContain('OPTIONAL {\n    ?volunteeringOpportunity vol:title ?title .');
  });

  it('a nested property records must have makes its whole path required', () => {
    const name = { ...newStep(`${RDFS}label`), optional: false };
    const org = { ...newStep(`${VOL}offeredBy`, 'resource'), children: [name] };
    expect(isRequired(org)).toBe(true);
    // The step's own flag is not counted, so its control stays editable.
    expect(isRequired(name)).toBe(false);
    const { query } = buildSparql(model({ steps: [org] }), { prefixes });
    expect(query).not.toContain('OPTIONAL');
  });

  it('a value its control can’t show is not applied, so the screen and the query agree', () => {
    const age = { ...newStep(`${VOL}minimumAge`, 'number'), filter: { op: 'gt' as const, value: 'sixteen' } };
    const active = { ...newStep(`${VOL}active`, 'boolean'), filter: { op: 'equals' as const, value: '1' } };
    expect(activeFilter(age)).toBeUndefined();
    expect(activeFilter(active)).toBeUndefined();
    // Values a number field or true/false choice would show differently (or as empty) don't apply either.
    for (const v of ['+5', '5.', ' 5', '5 ', '1e309', '1e999', '9'.repeat(400)]) expect(activeFilter({ ...age, filter: { op: 'gt', value: v } }), v).toBeUndefined();
    expect(activeFilter({ ...active, filter: { op: 'equals', value: ' false ' } })).toBeUndefined();
    for (const v of ['-0.5', '1e3', '1E+3', '1e-3', '.5', '1.e2', '-2.E-1']) expect(activeFilter({ ...age, filter: { op: 'gt', value: v } }), v).toEqual({ op: 'gt', value: v });
    expect(isRequired(age)).toBe(false);
    const { query } = buildSparql(model({ steps: [age, active] }), { prefixes });
    expect(query).not.toContain('FILTER');
    // Text operators still accept any text on a number property.
    expect(activeFilter({ ...age, filter: { op: 'contains', value: 'sixteen' } })).toEqual({ op: 'contains', value: 'sixteen' });
    expect(activeFilter({ ...active, filter: { op: 'equals', value: 'true' } })).toEqual({ op: 'equals', value: 'true' });
  });

  it('labels each column by its path', () => {
    const name = newStep(`${RDFS}label`);
    const org = { ...newStep(`${VOL}offeredBy`), children: [name] };
    const site = { ...newStep(`${VOL}location`), children: [{ ...name, id: 'x' }] };
    const labels = pathLabels([org, site], (iri) => iri.replace(/.*[#/]/, ''));
    expect(labels[name.id]).toBe('offeredBy › label');
    expect(labels.x).toBe('location › label');
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

describe('generated queries run', () => {
  it('returns the example data the builder asked for', async () => {
    const store = await storeFrom(`${fixture('volunteering.ttl')}\n${fixture('volunteering-example-data.ttl')}`);
    const title = newStep(`${VOL}title`);
    const org = { ...newStep(`${VOL}offeredBy`), show: false, optional: false };
    const orgLabel = newStep(`${RDFS}label`);
    org.children = [orgLabel];
    const age = { ...newStep(`${VOL}minimumAge`, 'number'), filter: { op: 'gt' as const, value: '15' } };
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
  it('nested filters only return matching records (the P1 from review)', async () => {
    const store = await storeFrom(`${fixture('volunteering.ttl')}\n${fixture('volunteering-example-data.ttl')}`);
    const title = newStep(`${VOL}title`);
    const orgLabel = { ...newStep(`${RDFS}label`), filter: { op: 'contains' as const, value: 'green spaces' } };
    const org = { ...newStep(`${VOL}offeredBy`, 'resource'), children: [orgLabel] };
    const { query, variables } = buildSparql(model({ steps: [title, org] }), { prefixes });
    const rows = (JSON.parse(store.queryJson(query)) as { results: { bindings: Record<string, { value: string }>[] } }).results.bindings;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r[variables[orgLabel.id]]?.value).toBe('Green Spaces Trust');
    // Text codes match as text.
    const charity = { ...newStep(`${VOL}charityNumber`, 'text'), filter: { op: 'equals' as const, value: '1234567' } };
    const orgs = buildSparql({ ...model(), rootClass: `${VOL}Organisation`, steps: [charity] }, { prefixes });
    expect(JSON.parse(store.queryJson(orgs.query)).results.bindings).toHaveLength(1);
    store.free();
  });

  // Deeper and sibling cases from the second review, run on a small graph:
  // r1 has the full path, r2's organisation has no address, r3 has no organisation.
  const graph = `@prefix ex: <https://example.org/> .
ex:r1 a ex:Record ; ex:title "One" ; ex:org ex:o1 ; ex:topic ex:t1 ; ex:size 250 .
ex:o1 ex:label "Green Trust" ; ex:address ex:a1 .
ex:a1 ex:city "Leeds" .
ex:t1 ex:label "Parks" .
ex:r2 a ex:Record ; ex:title "Two" ; ex:org ex:o2 ; ex:topic ex:t2 ; ex:size 5 .
ex:o2 ex:label "Blue Trust" .
ex:t2 ex:label "Food" .
ex:r3 a ex:Record ; ex:title "Three" .
`;
  const EX = 'https://example.org/';
  const titles = async (steps: BuilderModel['steps']) => {
    const store = await storeFrom(graph);
    const built = buildSparql({ rootClass: `${EX}Record`, includeSubclasses: false, steps, distinct: true, countOnly: false, descending: false }, { prefixes: { ex: EX } });
    const rows = (JSON.parse(store.queryJson(built.query)) as { results: { bindings: Record<string, { value: string }>[] } }).results.bindings;
    store.free();
    return { titles: rows.map((r) => r[built.variables[steps[0].id]]?.value).sort(), query: built.query };
  };
  const title = () => newStep(`${EX}title`);

  it('every number form the field accepts runs as a filter on sparq', async () => {
    for (const [v, expected] of [['1.e2', ['One']], ['.5e3', []], ['-1E1', ['One', 'Two']]] as const) {
      const size = { ...newStep(`${EX}size`, 'number'), filter: { op: 'gt' as const, value: v }, optional: false };
      expect((await titles([title(), size])).titles, v).toEqual(expected);
    }
  });

  it('"at least" and "at most" include the boundary; "more than" and "less than" exclude it', async () => {
    const store = await storeFrom(`@prefix ex: <https://example.org/> .
ex:a a ex:Record ; ex:title "Fourteen" ; ex:size 14 .
ex:b a ex:Record ; ex:title "Fifteen" ; ex:size 15 .
ex:c a ex:Record ; ex:title "Sixteen" ; ex:size 16 .
`);
    const run = (op: 'gt' | 'gte' | 'lt' | 'lte') => {
      const steps = [title(), { ...newStep(`${EX}size`, 'number'), filter: { op, value: '15' } }];
      const built = buildSparql({ rootClass: `${EX}Record`, includeSubclasses: false, steps, distinct: true, countOnly: false, descending: false }, { prefixes: { ex: EX } });
      const rows = (JSON.parse(store.queryJson(built.query)) as { results: { bindings: Record<string, { value: string }>[] } }).results.bindings;
      return rows.map((r) => r[built.variables[steps[0].id]]?.value).sort();
    };
    expect(run('gte')).toEqual(['Fifteen', 'Sixteen']);
    expect(run('gt')).toEqual(['Sixteen']);
    expect(run('lte')).toEqual(['Fifteen', 'Fourteen']);
    expect(run('lt')).toEqual(['Fourteen']);
  });

  it('a filter three relationships deep excludes non-matching and missing paths', async () => {
    const city = { ...newStep(`${EX}city`), filter: { op: 'equals' as const, value: 'Leeds' } };
    const steps = [title(), { ...newStep(`${EX}org`, 'resource'), children: [{ ...newStep(`${EX}address`, 'resource'), children: [city] }] }];
    expect((await titles(steps)).titles).toEqual(['One']);
  });

  it('filters on sibling branches must both match; an unfiltered sibling stays optional', async () => {
    const org = { ...newStep(`${EX}org`, 'resource'), children: [{ ...newStep(`${EX}label`), filter: { op: 'contains' as const, value: 'trust' } }] };
    const topic = { ...newStep(`${EX}topic`, 'resource'), children: [{ ...newStep(`${EX}label`), filter: { op: 'equals' as const, value: 'Food' } }] };
    expect((await titles([title(), org, topic])).titles).toEqual(['Two']);
    const loose = { ...newStep(`${EX}topic`, 'resource'), children: [newStep(`${EX}label`)] };
    const r = await titles([title(), loose]);
    expect(r.titles).toEqual(['One', 'Three', 'Two']);
    expect(r.query).toMatch(/OPTIONAL \{\n\s+\?record ex:topic \?topic \.\n\s+OPTIONAL \{/);
  });

  it('turning off "Keep records without it" on a nested property excludes records without it', async () => {
    const address = { ...newStep(`${EX}address`, 'resource'), optional: false };
    const steps = [title(), { ...newStep(`${EX}org`, 'resource'), children: [address] }];
    expect((await titles(steps)).titles).toEqual(['One']);
  });
});
