/**
 * The visual query builder's model and its translation to SPARQL. The model
 * is a tree: a root class ("find every Volunteering opportunity") with
 * property steps hanging off it, and object-property steps can have their own
 * children ("…offered by an organisation, show its title"). Pure functions,
 * so they're unit-tested without a browser.
 */

export type IRI = string;

export type FilterOp = 'contains' | 'equals' | 'notEquals' | 'gt' | 'lt' | 'startsWith' | 'regex';

export const FILTER_LABELS: Record<FilterOp, string> = {
  contains: 'contains',
  startsWith: 'starts with',
  equals: 'is',
  notEquals: 'has a value other than',
  gt: 'is more than',
  lt: 'is less than',
  regex: 'matches regex',
};

/**
 * What a property's values are, from its declared range, so filters compare
 * like with like instead of guessing from what the user typed ("00123" is a
 * text code, not the number 123; a URL stored as text is not a resource).
 */
export type ValueType = 'text' | 'number' | 'boolean' | 'resource';

export interface PathStep {
  id: string;
  property: IRI;
  /** Defaults to 'text' for steps saved before value types existed. */
  valueType?: ValueType;
  /** Keep rows that have no value for this property. Ignored when the step or anything below it filters. */
  optional: boolean;
  /** Show the value as a column. */
  show: boolean;
  filter?: { op: FilterOp; value: string };
  /** For object properties: steps from the linked thing. */
  children: PathStep[];
}

export interface BuilderModel {
  rootClass: IRI;
  /** Also match instances of subclasses (rdf:type/rdfs:subClassOf*). */
  includeSubclasses: boolean;
  steps: PathStep[];
  distinct: boolean;
  /** Return one number instead of rows. */
  countOnly: boolean;
  /** 'root' or a step id. */
  orderBy?: string;
  descending: boolean;
  limit?: number;
}

export interface BuilderContext {
  prefixes: Record<string, string>;
}

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';

export function localName(iri: IRI): string {
  const m = /[#/:]([^#/:]+)$/.exec(iri);
  return m ? m[1] : iri;
}

/** A SPARQL-safe variable name from a term's local name: VolunteeringOpportunity -> volunteeringOpportunity. */
export function varNameFor(iri: IRI): string {
  const base = localName(iri).replace(/[^A-Za-z0-9_]/g, '_') || 'x';
  const v = base.charAt(0).toLowerCase() + base.slice(1);
  return /^[0-9]/.test(v) ? `v${v}` : v;
}

function compactor(prefixes: Record<string, string>) {
  const used = new Map<string, string>();
  const entries = Object.entries(prefixes).sort((a, b) => b[1].length - a[1].length);
  const compact = (iri: IRI): string => {
    for (const [p, ns] of entries) {
      if (iri.startsWith(ns)) {
        const local = iri.slice(ns.length);
        if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(local)) {
          used.set(p, ns);
          return `${p}:${local}`;
        }
      }
    }
    return `<${iri}>`;
  };
  return { compact, used };
}

function literal(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

function isNumber(v: string): boolean {
  return /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(v.trim());
}

function iriFor(value: string, compact: (iri: IRI) => string, prefixes: Record<string, string>): string | null {
  if (/^<[^<>\s]+>$/.test(value)) return compact(value.slice(1, -1));
  if (/^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(value) || /^urn:\S+$/i.test(value)) return compact(value);
  const m = /^([A-Za-z][\w-]*)?:([\w-]+)$/.exec(value);
  if (m && prefixes[m[1] ?? ''] !== undefined) return compact(`${prefixes[m[1] ?? '']}${m[2]}`);
  return null;
}

function filterExpr(v: string, f: { op: FilterOp; value: string }, type: ValueType, compact: (iri: IRI) => string, prefixes: Record<string, string>): string | null {
  const value = f.value.trim();
  if (!value) return null;
  // Text matching always works on the lexical form, whatever the type.
  switch (f.op) {
    case 'contains':
      return `CONTAINS(LCASE(STR(${v})), ${literal(value.toLowerCase())})`;
    case 'startsWith':
      return `STRSTARTS(LCASE(STR(${v})), ${literal(value.toLowerCase())})`;
    case 'regex':
      return `REGEX(STR(${v}), ${literal(value)}, "i")`;
  }
  const cmp = { equals: '=', notEquals: '!=', gt: '>', lt: '<' }[f.op];
  if (type === 'resource') {
    const iri = iriFor(value, compact, prefixes);
    if (iri && (f.op === 'equals' || f.op === 'notEquals')) return `${v} ${cmp} ${iri}`;
    return `STR(${v}) ${cmp} ${literal(iri ? value.replace(/^<|>$/g, '') : value)}`;
  }
  if (type === 'number' && isNumber(value)) return `${v} ${cmp} ${value}`;
  if (type === 'boolean' && /^(true|false)$/i.test(value)) return `${v} ${cmp} ${value.toLowerCase()}`;
  return `STR(${v}) ${cmp} ${literal(value)}`;
}

/** Number properties compare numerically, through a number field. */
export function usesNumberInput(type: ValueType, op: FilterOp): boolean {
  return type === 'number' && (op === 'equals' || op === 'notEquals' || op === 'gt' || op === 'lt');
}

/** Yes/no properties pick true or false. */
export function usesBooleanChoice(type: ValueType, op: FilterOp): boolean {
  return type === 'boolean' && (op === 'equals' || op === 'notEquals');
}

/** Whether a filter value fits the control its operator shows, so what's on screen is what runs. */
export function fitsControl(type: ValueType, op: FilterOp, value: string): boolean {
  const v = value.trim();
  if (usesNumberInput(type, op)) return isNumber(v);
  if (usesBooleanChoice(type, op)) return v === 'true' || v === 'false';
  return true;
}

/**
 * The filter that actually applies: none when the value is empty or doesn't
 * fit the control (e.g. "sixteen" left over in a restored draft after
 * switching to "is more than", which the number field shows as empty).
 */
export function activeFilter(step: PathStep): { op: FilterOp; value: string } | undefined {
  const f = step.filter;
  const value = f?.value.trim();
  if (!f || !value || !fitsControl(step.valueType ?? 'text', f.op, value)) return undefined;
  return { op: f.op, value };
}

/**
 * True when this step must match because of something on it or below it: a
 * filter here or further down, or a step further down that records must have
 * ("Keep records without it" turned off). Then the whole path to it is
 * required, not optional. The step's own optional flag isn't counted, so its
 * control stays editable.
 */
export function isRequired(step: PathStep): boolean {
  return !!activeFilter(step) || step.children.some((c) => !c.optional || isRequired(c));
}

/** Readable names for every step's column: "offered by › label". */
export function pathLabels(steps: PathStep[], name: (iri: IRI) => string, path: string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of steps) {
    const here = [...path, name(s.property)];
    out[s.id] = here.join(' › ');
    Object.assign(out, pathLabels(s.children, name, here));
  }
  return out;
}

export interface BuiltQuery {
  query: string;
  /** Variable name for the root and every step id. */
  variables: Record<string, string>;
}

export function buildSparql(model: BuilderModel, ctx: BuilderContext): BuiltQuery {
  const { compact, used } = compactor(ctx.prefixes);
  const taken = new Set<string>();
  const unique = (name: string) => {
    let n = name;
    for (let i = 2; taken.has(n); i++) n = `${name}${i}`;
    taken.add(n);
    return n;
  };
  const variables: Record<string, string> = {};
  const rootVar = unique(varNameFor(model.rootClass));
  variables.root = rootVar;
  const shown: string[] = [rootVar];

  const typePath = model.includeSubclasses ? `a/${compact(`${RDFS}subClassOf`)}*` : 'a';
  const lines: string[] = [`  ?${rootVar} ${typePath} ${compact(model.rootClass)} .`];

  const walk = (subject: string, steps: PathStep[], indent: string, prefix: string): string[] => {
    const out: string[] = [];
    for (const step of steps) {
      const name = unique(prefix ? `${prefix}_${varNameFor(step.property)}` : varNameFor(step.property));
      variables[step.id] = name;
      if (step.show) shown.push(name);
      const pred = step.property === RDF_TYPE ? 'a' : compact(step.property);
      // A filtered path is required end to end: "offered by an organisation whose name
      // contains X" must not keep opportunities with another organisation, or none.
      const active = activeFilter(step);
      const wrap = step.optional && !isRequired(step);
      const ind = wrap ? `${indent}  ` : indent;
      const inner = [`${ind}?${subject} ${pred} ?${name} .`, ...walk(name, step.children, ind, name)];
      const f = active ? filterExpr(`?${name}`, active, step.valueType ?? 'text', compact, ctx.prefixes) : null;
      if (f) inner.push(`${ind}FILTER(${f})`);
      out.push(...(wrap ? [`${indent}OPTIONAL {`, ...inner, `${indent}}`] : inner));
    }
    return out;
  };
  lines.push(...walk(rootVar, model.steps, '  ', ''));

  let head: string;
  if (model.countOnly) head = `SELECT (COUNT(DISTINCT ?${rootVar}) AS ?count)`;
  else head = `SELECT ${model.distinct ? 'DISTINCT ' : ''}${shown.map((v) => `?${v}`).join(' ')}`;

  const tail: string[] = [];
  if (!model.countOnly && model.orderBy) {
    const v = variables[model.orderBy];
    if (v) tail.push(`ORDER BY ${model.descending ? `DESC(?${v})` : `?${v}`}`);
  }
  if (!model.countOnly && model.limit && model.limit > 0) tail.push(`LIMIT ${Math.floor(model.limit)}`);

  const prefixLines = [...used.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([p, ns]) => `PREFIX ${p}: <${ns}>`);
  const query = [...prefixLines, ...(prefixLines.length ? [''] : []), head, 'WHERE {', ...lines, '}', ...tail].join('\n');
  return { query, variables };
}

let counter = 0;
export function newStep(property: IRI, valueType: ValueType = 'text'): PathStep {
  counter += 1;
  return { id: `s${Date.now().toString(36)}${counter}`, property, valueType, optional: true, show: true, children: [] };
}

/** Immutable update of one step anywhere in the tree. */
export function updateStep(steps: PathStep[], id: string, fn: (s: PathStep) => PathStep | null): PathStep[] {
  const out: PathStep[] = [];
  for (const s of steps) {
    if (s.id === id) {
      const next = fn(s);
      if (next) out.push(next);
    } else out.push({ ...s, children: updateStep(s.children, id, fn) });
  }
  return out;
}

export function findStep(steps: PathStep[], id: string): PathStep | undefined {
  for (const s of steps) {
    if (s.id === id) return s;
    const c = findStep(s.children, id);
    if (c) return c;
  }
  return undefined;
}

export function allSteps(steps: PathStep[]): PathStep[] {
  return steps.flatMap((s) => [s, ...allSteps(s.children)]);
}
