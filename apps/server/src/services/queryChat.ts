import { buildSparql, compactIRI, newStep, NS, pathLabels, type BuilderModel, type FilterOp, type OntologyGraph, type OntologyView, type PathStep, type ValueType } from '@concord/core';
import type { ClassView, PropertyView } from '@concord/core/types';
import type { QueryChatRequest, QueryChatResponse, QueryTarget } from '@concord/shared';
import { ontologyDigest } from '../llm/context.js';
import { QUERY_ASSISTANT } from '../llm/prompts.js';
import { config } from '../config.js';
import { HttpError } from '../db.js';
import { llm } from '../llm/provider.js';
import { QueryChatSchema } from '../llm/schemas.js';
import { MAX_QUERY_LENGTH, queryProblem } from './queryPolicy.js';

/**
 * The query assistant: people describe what they want to find, and it writes
 * (or revises) the SPARQL in the editor. Claude does the writing for members
 * of the ontology; every answer, from Claude or not, is checked against the
 * query policy (parsed and planned by sparq, never run) before it goes back,
 * with one repair round for Claude. Otherwise an offline helper matches the
 * conversation's words to the ontology's terms and builds the query with the
 * structured builder, refining its own previous query message by message.
 */

type Draft = Omit<QueryChatResponse, 'simulated' | 'offlineReason'>;

/** Strips our own delimiters from user-controlled text so it can't close a data block early. */
const fence = (text: string) => text.replace(/<\/?(ontology|current_query|conversation|sample_counts)>/gi, '');

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
  return { ...d, columns: d.columns.filter((c) => c.variable && new RegExp(`[?$]${c.variable.replace(/^[?$]/, '').replace(/[^\w]/g, '')}\\b`).test(d.query)).map((c) => ({ ...c, variable: c.variable.replace(/^[?$]/, '') })) };
}

/** Replies are shown as plain text; drop anything that looks like a link or image anyway. */
function tidyReply(reply: string) {
  return reply
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\bhttps?:\/\/\S+/gi, (url) => (url.length > 80 ? `${url.slice(0, 77)}…` : url))
    .slice(0, 1200)
    .trim();
}

/** Leave the editor as it is and say why. */
function unchanged(req: QueryChatRequest, reply: string): Draft {
  return { reply, query: req.query, target: req.target, columns: [], unchanged: true };
}

/** Every answer passes the same check before it reaches the browser. */
function checked(req: QueryChatRequest, d: Draft): Draft {
  if (d.unchanged) return d;
  const problem = queryProblem(d.query);
  return problem ? unchanged(req, `I couldn’t write a query for that. ${problem}`) : tidyColumns({ ...d, reply: tidyReply(d.reply) });
}

/* ------------------------------------------------------------------------ */
/* Who may use it, and how often                                              */
/* ------------------------------------------------------------------------ */

export const QUERY_CHAT_LIMITS = { perUser: 30, windowMs: 10 * 60_000, messages: 12, messageChars: 1000, conversationChars: 8000, summaryEntries: 100, classIriChars: 300 };
const recent = new Map<string, number[]>();
const busy = new Set<string>();
const today = { day: '', claude: 0 };

/**
 * Admits one question from this person: at most one at a time and
 * QUERY_CHAT_LIMITS.perUser per ten minutes (429 otherwise). Claude answers
 * for members of the ontology while the deployment's daily budget lasts;
 * everyone else gets the offline helper. Call `done()` when the answer is sent.
 */
export function admitQueryChat(userId: string, isMember: boolean): { useClaude: boolean; offlineReason?: QueryChatResponse['offlineReason']; done: () => void } {
  if (busy.has(userId)) throw new HttpError(429, 'Still answering your previous question');
  const now = Date.now();
  const mine = (recent.get(userId) ?? []).filter((t) => now - t < QUERY_CHAT_LIMITS.windowMs);
  if (mine.length >= QUERY_CHAT_LIMITS.perUser) throw new HttpError(429, 'That’s a lot of questions in a short time. Try again in a few minutes, or edit the query directly.');
  recent.set(userId, [...mine, now]);
  busy.add(userId);
  const done = () => busy.delete(userId);

  const day = new Date(now).toISOString().slice(0, 10);
  if (today.day !== day) (today.day = day), (today.claude = 0);
  if (config.llm.provider !== 'anthropic') return { useClaude: false, offlineReason: 'unavailable', done };
  if (!isMember) return { useClaude: false, offlineReason: 'not-member', done };
  if (today.claude >= config.llm.queryAssistantDailyLimit) return { useClaude: false, offlineReason: 'limit', done };
  today.claude += 1;
  return { useClaude: true, done };
}

/** Tests only. */
export function resetQueryChatLimits() {
  recent.clear();
  busy.clear();
  today.day = '';
}

/** The request, cut to the sizes the assistant accepts (400 when the query itself is too long to send). */
export function boundedQueryChatRequest(body: unknown): QueryChatRequest {
  const b = (body ?? {}) as Record<string, unknown>;
  const L = QUERY_CHAT_LIMITS;
  const all = (Array.isArray(b.messages) ? b.messages : [])
    .filter((m): m is { role: 'user' | 'assistant'; content: string } => !!m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map((m) => ({ role: m.role, content: m.content.slice(0, L.messageChars) }));
  if (all.at(-1)?.role !== 'user' || !all.at(-1)!.content.trim()) throw new HttpError(400, 'Say what you want the query to find');
  // The latest messages that fit, newest first.
  const messages: QueryChatRequest['messages'] = [];
  let chars = 0;
  for (const m of all.slice(-L.messages).reverse()) {
    if (chars + m.content.length > L.conversationChars) break;
    chars += m.content.length;
    messages.unshift(m);
  }
  const query = typeof b.query === 'string' ? b.query : '';
  if (query.length > MAX_QUERY_LENGTH) throw new HttpError(400, `The query is too long for the assistant (over ${MAX_QUERY_LENGTH.toLocaleString('en-GB')} characters). Shorten it or start over.`);
  const dataSummary = (Array.isArray(b.dataSummary) ? b.dataSummary : [])
    .filter((d): d is { classIri: string; count: number } => !!d && typeof d.classIri === 'string' && d.classIri.length <= L.classIriChars && Number.isInteger(d.count) && d.count >= 0)
    .slice(0, L.summaryEntries)
    .map((d) => ({ classIri: d.classIri, count: d.count }));
  return { messages, query, target: b.target === 'data' ? 'data' : 'ontology', dataSummary };
}

export interface QueryChatOptions {
  /** Whether Claude may answer (membership and budget allowing); otherwise the offline helper does. */
  useClaude: boolean;
}

export async function queryChat(graph: OntologyGraph, req: QueryChatRequest, opts: QueryChatOptions): Promise<Omit<QueryChatResponse, 'offlineReason'>> {
  const view = graph.view();
  const offline = () => ({ ...checked(req, offlineQuery(view, req)), simulated: true });
  if (!opts.useClaude) return offline();

  // Everything from the ontology and the conversation is data written by people, not instructions.
  const context = [
    `<ontology>\n${fence(ontologyDigest(graph)).slice(0, 40_000)}\n</ontology>`,
    `<sample_counts>\n${fence(dataLine(req, view.prefixes))}\n</sample_counts>`,
    `<current_query target="${req.target}">\n${fence(req.query.trim()) || '(empty)'}\n</current_query>`,
    `<conversation>\n${fence(conversation(req))}\n</conversation>`,
  ].join('\n\n');
  const call = (messages: { role: 'user' | 'assistant'; content: string }[], task: string) =>
    llm.json({ task, system: QUERY_ASSISTANT, schema: QueryChatSchema, effort: 'medium', maxTokens: 2500, messages, fallback: () => offlineQuery(view, req) });

  const ask = [{ role: 'user' as const, content: `${context}\n\nWrite the next turn for the person's latest message.` }];
  const first = await call(ask, 'query-chat');
  if (first.simulated) return offline();
  let draft: Draft = first.value;
  const problem = queryProblem(draft.query);
  if (problem) {
    // One repair round with the parser's message; if that fails too, the offline helper answers.
    const repair = await call([...ask, { role: 'assistant', content: JSON.stringify(draft) }, { role: 'user', content: `That query can't be used: ${problem}\nFix it and return the whole turn again.` }], 'query-chat-repair');
    if (repair.simulated || queryProblem(repair.value.query)) return offline();
    draft = repair.value;
  }
  return { ...checked(req, draft), simulated: false };
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

/** What the offline helper has built so far: a list of records, or a fixed question about the model. */
type OfflineState = { kind: 'records'; cls: ClassView; model: BuilderModel } | { kind: 'ontology'; draft: Draft };

/** "also…", "only…", "remove…": the message changes the previous query rather than asking a new question. */
const REFINE = /^\s*(also|and|only|just|now|but|then|plus|add|include|remove|drop|hide|without|exclude|except|sort|order|filter|limit|show only|make it|instead)\b|\b(as well|too|instead|those|them|these)\b/i;
const REMOVE = /\b(remove|drop|hide|without|exclude|no longer show|don['’]?t show|do not show|leave out|take out)\b/i;

const NUMBER_OPS: [RegExp, FilterOp][] = [
  [/\b(at least|no less than|minimum of|or more)\b/i, 'gte'],
  [/\b(at most|no more than|up to|maximum of|or less|or fewer)\b/i, 'lte'],
  [/\b(over|more than|above|greater than|older than|bigger than)\b/i, 'gt'],
  [/\b(under|less than|below|fewer than|younger than|smaller than)\b/i, 'lt'],
];
const OP_WORDS: Record<string, string> = { gt: 'over', gte: 'at least', lt: 'under', lte: 'at most' };

interface Ctx {
  view: OntologyView;
  classes: ClassView[];
  counts: Map<string, number>;
}

function propsFor(view: OntologyView, cls: ClassView) {
  const scope = ancestors(view, cls.iri);
  const all = [...view.datatypeProperties, ...view.objectProperties].filter((p) => !p.deprecated && (p.domain.length === 0 || p.domain.some((d) => scope.has(d))));
  const own = all.filter((p) => p.domain.some((d) => scope.has(d)));
  const nameProp = own.find((p) => p.kind === 'datatypeProperty' && /\b(title|name)\b/i.test(labelOf(p)));
  return { all, nameProp };
}

function stepFor(p: PropertyView): PathStep {
  const step = newStep(p.iri, valueTypeOf(p));
  if (p.kind === 'objectProperty') step.children = [newStep(RDFS_LABEL)];
  return step;
}

function startRecords(ctx: Ctx, cls: ClassView, text: string): OfflineState {
  const { all, nameProp } = propsFor(ctx.view, cls);
  const mentioned = all.filter((p) => mentions(text, labelOf(p)));
  const chosen = [...new Set([...(nameProp ? [nameProp] : []), ...mentioned])];
  const steps = chosen.map(stepFor);
  if (!nameProp) steps.unshift(newStep(RDFS_LABEL));
  const model: BuilderModel = { rootClass: cls.iri, includeSubclasses: true, steps, distinct: true, countOnly: false, descending: false, orderBy: steps[0]?.id, limit: 100 };
  const state: OfflineState = { kind: 'records', cls, model };
  applyFilters(ctx, state, text);
  return state;
}

/** Number and text filters, counting, sorting and the row limit, from one message. Returns whether anything changed. */
function applyFilters(ctx: Ctx, state: Extract<OfflineState, { kind: 'records' }>, text: string): boolean {
  const { model, cls } = state;
  const { all, nameProp } = propsFor(ctx.view, cls);
  const propOf = (s: PathStep) => all.find((p) => p.iri === s.property);
  let changed = false;

  // "called 'X'", "containing "X"": a text filter on the name column.
  const quoted = /["“'‘]([^"”'’]{2,})["”'’]/.exec(text)?.[1];
  const textStep = model.steps.find((s) => s.property === nameProp?.iri) ?? model.steps.find((s) => s.property === RDFS_LABEL);
  if (quoted && textStep) (textStep.filter = { op: 'contains', value: quoted }), (changed = true);

  // "with a minimum age of at least 16": a number filter, on the number property named, or the only one shown.
  const num = /(-?\d+(?:\.\d+)?)/.exec(text.replace(/\b(first|top|limit(?: to)?)\s+\d+/gi, ''));
  const op = NUMBER_OPS.find(([re]) => re.test(text))?.[1];
  if (num && op) {
    const numberSteps = model.steps.filter((s) => s.valueType === 'number');
    let step = numberSteps.find((s) => mentions(text, labelOf(propOf(s) ?? { iri: s.property })));
    if (!step) {
      const named = all.find((p) => valueTypeOf(p) === 'number' && mentions(text, labelOf(p)));
      if (named) model.steps.push((step = stepFor(named)));
      else if (numberSteps.length === 1) step = numberSteps[0];
    }
    if (step) (step.filter = { op, value: num[1] }), (changed = true);
  }

  if (/\bhow many\b|\bcount\b|\bnumber of\b/i.test(text)) (model.countOnly = true), (changed = true);
  else if (model.countOnly && /\b(list|show|which)\b/i.test(text)) (model.countOnly = false), (changed = true);

  if (/\b(all of them|everything|every one|all results|all records|all rows|no limit|without (a |the )?limit|remove the limit)\b/i.test(text)) (model.limit = undefined), (changed = true);
  const limit = /\b(?:first|top|limit(?: to)?)\s+(\d{1,5})\b/i.exec(text);
  if (limit) (model.limit = Number(limit[1])), (changed = true);

  const sort = /\b(?:sort|order)(?:ed)? by (?:the |its )?([\w ’'-]+?)(?:\s+(descending|ascending|highest first|lowest first|newest first|oldest first))?[.?!]?$/i.exec(text.trim());
  if (sort) {
    const step = model.steps.find((s) => mentions(sort[1], s.property === RDFS_LABEL ? 'label' : labelOf(propOf(s) ?? { iri: s.property })));
    if (step) (model.orderBy = step.id), (changed = true);
    if (sort[2]) (model.descending = /descending|highest|newest/i.test(sort[2])), (changed = true);
  }
  return changed;
}

/** Applies one message to the previous state. `refined` is false when it started a new question. */
function step(ctx: Ctx, prev: OfflineState | undefined, text: string): { state?: OfflineState; refined: boolean; understood: boolean; why?: string } {
  const refining = !!prev && prev.kind === 'records' && REFINE.test(text);
  // "also…" after a question about the model: there is no list to change.
  if (prev?.kind === 'ontology' && REFINE.test(text) && !mentionedClass(ctx, text))
    return { state: prev, refined: true, understood: false, why: 'That last question was about the model itself, so there’s no list of records to change. Ask for records first, for example “List every …”.' };
  if (!refining) {
    const ontology = ontologyQuestion(ctx.view, normalise(text));
    const cls = mentionedClass(ctx, text);
    if (ontology && !cls) return { state: { kind: 'ontology', draft: ontology }, refined: false, understood: true };
    if (cls) return { state: startRecords(ctx, cls, text), refined: false, understood: true };
    if (ontology) return { state: { kind: 'ontology', draft: ontology }, refined: false, understood: true };
    if (!prev || prev.kind !== 'records') {
      const top = [...ctx.classes].sort((a, b) => (ctx.counts.get(b.iri) ?? 0) - (ctx.counts.get(a.iri) ?? 0))[0];
      return top ? { state: startRecords(ctx, top, text), refined: false, understood: true } : { refined: false, understood: false };
    }
  }
  // A refinement of the previous list.
  const state = structuredClone(prev) as Extract<OfflineState, { kind: 'records' }>;
  const { all } = propsFor(ctx.view, state.cls);
  const named = all.filter((p) => mentions(text, labelOf(p)));
  let changed = false;
  if (REMOVE.test(text)) {
    const after = text.slice(REMOVE.exec(text)!.index);
    const gone = new Set(all.filter((p) => mentions(after, labelOf(p))).map((p) => p.iri));
    if (/\b(filter|condition|restriction)s?\b/i.test(after)) for (const s of state.model.steps) if (s.filter) delete s.filter, (changed = true);
    const before = state.model.steps.length;
    state.model.steps = state.model.steps.filter((s) => !gone.has(s.property));
    changed ||= state.model.steps.length !== before;
    if (!state.model.steps.length) state.model.steps = [newStep(RDFS_LABEL)];
  } else {
    for (const p of named) if (!state.model.steps.some((s) => s.property === p.iri)) state.model.steps.push(stepFor(p)), (changed = true);
  }
  changed = applyFilters(ctx, state, text) || changed;
  return { state, refined: true, understood: changed };
}

function mentionedClass(ctx: Ctx, text: string): ClassView | undefined {
  return ctx.classes.filter((c) => mentions(text, labelOf(c))).sort((a, b) => labelOf(b).length - labelOf(a).length)[0];
}

function render(ctx: Ctx, state: OfflineState): Draft {
  if (state.kind === 'ontology') return state.draft;
  const { model, cls } = state;
  const { all } = propsFor(ctx.view, cls);
  const { query, variables } = buildSparql(model, { prefixes: { ...ctx.view.prefixes, rdfs: NS.rdfs } });
  const name = (iri: string) => (iri === RDFS_LABEL ? 'label' : labelOf(all.find((p) => p.iri === iri) ?? { iri }));
  const paths = pathLabels(model.steps, name);
  const columns = model.countOnly
    ? [{ variable: 'count', label: `Number of ${labelOf(cls)} records` }]
    : [{ variable: variables.root, label: labelOf(cls) }, ...model.steps.flatMap((s) => [s, ...s.children]).map((s) => ({ variable: variables[s.id], label: paths[s.id] }))];
  const filters = model.steps.flatMap((s) => {
    if (!s.filter) return [];
    return [s.filter.op === 'contains' ? `whose ${name(s.property)} contains “${s.filter.value}”` : `with ${name(s.property)} ${OP_WORDS[s.filter.op] ?? s.filter.op} ${s.filter.value}`];
  });
  const where = filters.length ? ` ${filters.join(' and ')}` : '';
  const shown = model.steps.map((s) => (s.children.length ? `${name(s.property)} (with its label)` : name(s.property)));
  const sortStep = model.steps.find((s) => s.id === model.orderBy);
  const sorted = sortStep && (model.descending || sortStep !== model.steps[0]) ? `, sorted by ${name(sortStep.property)}${model.descending ? ' (highest first)' : ''}` : '';
  const reply = model.countOnly
    ? `This counts the ${labelOf(cls)} records${where} in your sample data, including subclasses.`
    : `This lists ${labelOf(cls)} records${where}, showing ${shown.join(', ')}${sorted}${model.limit ? `, up to ${model.limit} rows (ask for “all of them” to remove the limit)` : ''}.`;
  return { reply, query, target: 'data', columns };
}

/**
 * Builds the query from the conversation, one message at a time: a message
 * that names a class (or asks about the model) starts a new question, and
 * "also…", "only…", "remove…" refine the previous one. A refinement only
 * applies when the editor still holds the helper's previous query; it never
 * rewrites a query that was edited by hand or written by Claude.
 */
export function offlineQuery(view: OntologyView, req: QueryChatRequest): Draft {
  const ctx: Ctx = { view, classes: view.classes.filter((c) => !c.deprecated), counts: new Map((req.dataSummary ?? []).map((d) => [d.classIri, d.count])) };
  if (!ctx.classes.length) return unchanged(req, 'This ontology has no classes yet, so there is nothing to query. Add some classes first, or write SPARQL in the editor.');
  const said = req.messages.filter((m) => m.role === 'user').map((m) => m.content);
  let state: OfflineState | undefined;
  for (const text of said.slice(0, -1)) state = step(ctx, state, text).state ?? state;
  const previous = state ? render(ctx, state) : undefined;
  const latest = step(ctx, state, said.at(-1) ?? '');
  if (!latest.state) return unchanged(req, 'I couldn’t match that to anything in this ontology. Try naming a class or a property, or write SPARQL in the editor.');
  if (latest.refined) {
    if (!previous || previous.query.trim() !== req.query.trim())
      return unchanged(req, 'The offline helper can only change queries it wrote itself, and the one in the editor has been changed since. Edit it directly, ask a new question, or start over.');
    if (!latest.understood) return unchanged(req, latest.why ?? 'I couldn’t tell what to change. Try “also show …”, “only those with … over 10”, “remove …”, or “all of them”.');
  }
  return render(ctx, latest.state);
}
