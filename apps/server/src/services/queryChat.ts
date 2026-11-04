import { buildSparql, compactIRI, newStep, NS, pathLabels, sparqlSyntaxError, type BuilderModel, type OntologyGraph, type OntologyView, type PathStep, type ValueType } from '@concord/core';
import type { ClassView, PropertyView } from '@concord/core/types';
import type { QueryChatRequest, QueryChatResponse, QueryTarget } from '@concord/shared';
import { ontologyDigest } from '../llm/context.js';
import { QUERY_ASSISTANT } from '../llm/prompts.js';
import { llm } from '../llm/provider.js';
import { QueryChatSchema } from '../llm/schemas.js';

/**
 * The query assistant: people describe what they want to find, and it writes
 * (or revises) the SPARQL in the editor. Claude does the writing; every query
 * is parsed before it goes back, with one repair round if it doesn't parse.
 * Without an API key, an offline helper matches the conversation's words to
 * the ontology's terms and builds the query with the structured builder.
 */

type Draft = Omit<QueryChatResponse, 'simulated'>;

function conversation(req: QueryChatRequest) {
  return req.messages.map((m) => `${m.role === 'user' ? 'Person' : 'Assistant'}: ${m.content}`).join('\n');
}

function dataLine(req: QueryChatRequest, prefixes: Record<string, string>) {
  const counts = (req.dataSummary ?? []).filter((d) => d.count > 0);
  if (!counts.length) return 'The sample data has no records yet.';
  return `Sample records by class: ${counts.map((d) => `${compactIRI(d.classIri, prefixes)} × ${d.count}`).join(', ')}.`;
}

/** Keep only headings for variables the query actually projects. */
function tidyColumns(d: Draft): Draft {
  return { ...d, columns: d.columns.filter((c) => c.variable && new RegExp(`[?$]${c.variable.replace(/^[?$]/, '')}\\b`).test(d.query)).map((c) => ({ ...c, variable: c.variable.replace(/^[?$]/, '') })) };
}

export async function queryChat(graph: OntologyGraph, req: QueryChatRequest): Promise<QueryChatResponse> {
  const view = graph.view();
  const fallback = () => offlineQuery(view, req);
  const context = `Ontology:\n${ontologyDigest(graph)}\n\n${dataLine(req, view.prefixes)}\n\nCurrent query (runs against ${req.target === 'data' ? 'the ontology plus sample data' : 'the ontology only'}):\n${req.query.trim() || '(empty)'}\n\nConversation:\n${conversation(req)}`;
  const first = await llm.json({
    task: 'query-chat',
    system: QUERY_ASSISTANT,
    schema: QueryChatSchema,
    effort: 'medium',
    maxTokens: 6000,
    messages: [{ role: 'user', content: `${context}\n\nWrite the next turn.` }],
    fallback,
  });
  if (first.simulated) return { ...tidyColumns(first.value), simulated: true };

  let draft = first.value;
  const err = await sparqlSyntaxError(draft.query);
  if (err) {
    // One repair round with the parser's message; if that fails too, the offline helper answers.
    const repair = await llm.json({
      task: 'query-chat-repair',
      system: QUERY_ASSISTANT,
      schema: QueryChatSchema,
      effort: 'medium',
      maxTokens: 6000,
      messages: [
        { role: 'user', content: `${context}\n\nWrite the next turn.` },
        { role: 'assistant', content: JSON.stringify(draft) },
        { role: 'user', content: `That query does not parse: ${err}\nFix it and return the whole turn again.` },
      ],
      fallback,
    });
    if (repair.simulated || (await sparqlSyntaxError(repair.value.query))) return { ...tidyColumns(fallback()), simulated: true };
    draft = repair.value;
  }
  return { ...tidyColumns(draft), simulated: false };
}

/* ------------------------------------------------------------------------ */
/* Offline helper                                                             */
/* ------------------------------------------------------------------------ */

const NUMERIC = new Set(['integer', 'int', 'long', 'short', 'byte', 'decimal', 'double', 'float', 'nonNegativeInteger', 'positiveInteger', 'negativeInteger', 'nonPositiveInteger', 'unsignedInt', 'unsignedLong'].map((t) => NS.xsd + t));
const RDFS_LABEL = NS.rdfs + 'label';

function normalise(s: string) {
  return ` ${s
    .toLowerCase()
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()} `;
}

const STOP = new Set(['a', 'an', 'the', 'of', 'by', 'to', 'in', 'on', 'for', 'with', 'is', 'has', 'have', 'it', 'its', 'and', 'or', 'who', 'what', 'which']);

/** A rough English stem, so "offered", "offers" and "offering" all meet at "offer". */
function stem(word: string) {
  return word.replace(/(ies|ied)$/, 'y').replace(/(ing|ed|es|er|s)$/, '') || word;
}

/**
 * Does the text mention this label? Either as a phrase, allowing plurals
 * ("organisations", "opportunities"), or with every content word present in
 * some form ("who offers it" mentions "offered by").
 */
function mentions(text: string, label: string | undefined): boolean {
  if (!label) return false;
  const words = normalise(label).trim().split(' ').filter(Boolean);
  if (!words.length) return false;
  const said = normalise(text);
  const last = words.at(-1)!;
  const plural = last.endsWith('y') ? `${last.slice(0, -1)}(?:y|ies)` : `${last}(?:s|es)?`;
  if (new RegExp(` ${[...words.slice(0, -1), plural].join(' ')} `).test(said)) return true;
  const content = words.filter((w) => !STOP.has(w) && w.length > 2).map(stem);
  const stems = new Set(said.trim().split(' ').map(stem));
  return content.length > 0 && content.every((w) => stems.has(w));
}

function labelOf(t: { label?: string; iri: string }) {
  return t.label ?? normalise(t.iri.replace(/.*[#/]/, '')).trim();
}

function valueTypeOf(p: PropertyView): ValueType {
  if (p.kind === 'objectProperty') return 'resource';
  const r = p.range[0];
  if (r && NUMERIC.has(r)) return 'number';
  if (r === NS.xsd + 'boolean') return 'boolean';
  return 'text';
}

function ancestors(view: OntologyView, iri: string): Set<string> {
  const out = new Set<string>([iri]);
  const byIri = new Map(view.classes.map((c) => [c.iri, c]));
  const stack = [iri];
  while (stack.length) {
    for (const s of byIri.get(stack.pop()!)?.superClasses ?? []) if (!out.has(s)) out.add(s), stack.push(s);
  }
  return out;
}

function ontologyQuestion(view: OntologyView, text: string): Draft | undefined {
  const pfx = `PREFIX rdfs: <${NS.rdfs}>\nPREFIX owl: <${NS.owl}>\nPREFIX skos: <${NS.skos}>\n`;
  if (/\b(without|missing|no|lack\w*)\b.*\bdefinitions?\b/.test(text))
    return {
      reply: 'Here are the classes that have no definition yet.',
      target: 'ontology',
      query: `${pfx}\nSELECT ?class ?label WHERE {\n  ?class a owl:Class .\n  FILTER(isIRI(?class))\n  OPTIONAL { ?class rdfs:label ?label }\n  FILTER NOT EXISTS { ?class skos:definition ?definition }\n}\nORDER BY ?label`,
      columns: [{ variable: 'class', label: 'Class' }, { variable: 'label', label: 'Label' }],
    };
  if (/\bpropert(y|ies)\b|\brelationships?\b/.test(text))
    return {
      reply: 'Here are the ontology’s properties with their labels, domains and ranges.',
      target: 'ontology',
      query: `${pfx}\nSELECT ?property ?label ?domain ?range WHERE {\n  VALUES ?type { owl:ObjectProperty owl:DatatypeProperty }\n  ?property a ?type .\n  OPTIONAL { ?property rdfs:label ?label }\n  OPTIONAL { ?property rdfs:domain ?domain }\n  OPTIONAL { ?property rdfs:range ?range }\n}\nORDER BY ?label`,
      columns: [{ variable: 'property', label: 'Property' }, { variable: 'label', label: 'Label' }, { variable: 'domain', label: 'Domain' }, { variable: 'range', label: 'Range' }],
    };
  if (/\b(classes|class hierarchy|types of thing|kinds of thing)\b/.test(text))
    return {
      reply: 'Here are the ontology’s classes with their labels and definitions.',
      target: 'ontology',
      query: `${pfx}\nSELECT ?class ?label ?definition WHERE {\n  ?class a owl:Class .\n  FILTER(isIRI(?class))\n  OPTIONAL { ?class rdfs:label ?label }\n  OPTIONAL { ?class skos:definition ?definition }\n}\nORDER BY ?label`,
      columns: [{ variable: 'class', label: 'Class' }, { variable: 'label', label: 'Label' }, { variable: 'definition', label: 'Definition' }],
    };
  return undefined;
}

/**
 * Builds a query from the words in the conversation: the most recently
 * mentioned class, every property of it mentioned so far, a quoted phrase as a
 * text filter, "over/under N" as a number filter, and "how many" as a count.
 */
export function offlineQuery(view: OntologyView, req: QueryChatRequest): Draft {
  const said = req.messages.filter((m) => m.role === 'user').map((m) => m.content);
  const latest = said.at(-1) ?? '';
  const all = said.join('\n');
  const classes = view.classes.filter((c) => !c.deprecated);
  const mentionedClass = (text: string): ClassView | undefined =>
    classes.filter((c) => mentions(text, labelOf(c))).sort((a, b) => labelOf(b).length - labelOf(a).length)[0];

  let cls: ClassView | undefined;
  for (const text of [...said].reverse()) if ((cls = mentionedClass(text))) break;
  if (!cls) {
    const ontology = ontologyQuestion(view, normalise(latest));
    if (ontology) return ontology;
    const counts = new Map((req.dataSummary ?? []).map((d) => [d.classIri, d.count]));
    cls = [...classes].sort((a, b) => (counts.get(b.iri) ?? 0) - (counts.get(a.iri) ?? 0))[0];
  }
  if (!cls)
    return { reply: 'This ontology has no classes yet, so there is nothing to query. Add some classes first, or write SPARQL in the editor.', query: req.query, target: req.target, columns: [] };

  const scope = ancestors(view, cls.iri);
  const props = [...view.datatypeProperties, ...view.objectProperties].filter((p) => !p.deprecated && (p.domain.length === 0 || p.domain.some((d) => scope.has(d))));
  const ownProps = props.filter((p) => p.domain.some((d) => scope.has(d)));
  const nameProp = ownProps.find((p) => p.kind === 'datatypeProperty' && /\b(title|name)\b/i.test(labelOf(p)));
  const mentioned = props.filter((p) => mentions(all, labelOf(p)));
  const chosen = [...new Set([...(nameProp ? [nameProp] : []), ...mentioned])];

  const steps: PathStep[] = chosen.map((p) => {
    const step = newStep(p.iri, valueTypeOf(p));
    if (p.kind === 'objectProperty') step.children = [newStep(RDFS_LABEL)];
    return step;
  });
  if (!nameProp) steps.unshift(newStep(RDFS_LABEL));

  // "called 'X'", "containing "X"": a text filter on the name column.
  const quoted = /["“'‘]([^"”'’]{2,})["”'’]/.exec(latest)?.[1];
  const textStep = steps.find((s) => s.property === nameProp?.iri) ?? steps.find((s) => s.property === RDFS_LABEL);
  if (quoted && textStep) textStep.filter = { op: 'contains', value: quoted };

  // "over 16", "under 18": a number filter on the number property mentioned in the same message.
  const num = /\b(over|more than|above|greater than|at least|older than|under|less than|below|fewer than|younger than)\s+(-?\d+(?:\.\d+)?)\b/i.exec(latest);
  const numStep = num && steps.find((s) => s.valueType === 'number' && mentions(latest, labelOf(props.find((p) => p.iri === s.property)!)));
  if (num && numStep) numStep.filter = { op: /^(under|less|below|fewer|younger)/i.test(num[1]) ? 'lt' : 'gt', value: num[2] };

  const countOnly = /\bhow many\b|\bcount\b|\bnumber of\b/i.test(latest);
  const model: BuilderModel = { rootClass: cls.iri, includeSubclasses: true, steps, distinct: true, countOnly, descending: false, orderBy: countOnly ? undefined : steps[0]?.id, limit: 100 };
  const { query, variables } = buildSparql(model, { prefixes: { ...view.prefixes, rdfs: NS.rdfs } });

  const name = (iri: string) => (iri === RDFS_LABEL ? 'label' : labelOf(props.find((p) => p.iri === iri) ?? { iri }));
  const paths = pathLabels(steps, name);
  const columns = countOnly
    ? [{ variable: 'count', label: `Number of ${labelOf(cls)} records` }]
    : [{ variable: variables.root, label: labelOf(cls) }, ...steps.flatMap((s) => [s, ...s.children]).map((s) => ({ variable: variables[s.id], label: paths[s.id] }))];
  const shown = steps.map((s) => (s.children.length ? `${name(s.property)} (with its label)` : name(s.property)));
  const filters = [quoted && textStep ? `whose ${name(textStep.property)} contains “${quoted}”` : '', num && numStep ? `with ${name(numStep.property)} ${num[1].toLowerCase()} ${num[2]}` : ''].filter(Boolean);
  const reply = countOnly
    ? `This counts the ${labelOf(cls)} records${filters.length ? ` ${filters.join(' and ')}` : ''} in your sample data.`
    : `This lists every ${labelOf(cls)}${filters.length ? ` ${filters.join(' and ')}` : ''}, showing ${shown.join(', ')}.`;
  return { reply, query, target: 'data', columns };
}
