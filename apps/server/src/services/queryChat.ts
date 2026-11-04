import { buildSparql, compactIRI, newStep, NS, pathLabels, type BuilderModel, type FilterOp, type OntologyGraph, type OntologyView, type PathStep, type ValueType } from '@concord/core';
import type { ClassView, PropertyView } from '@concord/core/types';
import type { QueryChatRequest, QueryChatResponse, QueryTarget } from '@concord/shared';
import { ontologyDigest } from '../llm/context.js';
import { QUERY_ASSISTANT } from '../llm/prompts.js';
import { z } from 'zod';
import { config } from '../config.js';
import { HttpError, releaseCounters, reserveCounters } from '../db.js';
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

/** Escapes anything in user-written text that could read as one of our delimiters (opening or closing, any spacing), so it can't end a data block early. */
export const fenceForPrompt = (text: string) => text.replace(/<(?=\s*\/|\s*(?:ontology|current_query|conversation|sample_counts)\b)/gi, '&lt;');

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

/** Today's counters for one question: per person, per ontology and for the deployment. */
function allowanceCounters(day: string, userId: string, ontologyId: string) {
  const L = config.llm.queryAssistant;
  return [
    { id: `query-assistant:${day}:user:${userId}`, max: L.perUserPerDay },
    { id: `query-assistant:${day}:ontology:${ontologyId}`, max: L.perOntologyPerDay },
    { id: `query-assistant:${day}:all`, max: L.perDay },
  ];
}

export interface QueryChatGate {
  useClaude: boolean;
  offlineReason?: QueryChatResponse['offlineReason'];
  /** Call just before the first request to Claude: from then on the allowance is spent. */
  spend: () => void;
  /** Always call when the request ends: frees the person to ask again, and gives back an allowance that wasn't spent. */
  done: () => void;
}

/**
 * Admits one question from this person: at most one at a time and
 * QUERY_CHAT_LIMITS.perUser per ten minutes (429 otherwise). Claude answers
 * for members of the ontology while today's allowances last (per person, per
 * ontology and for the deployment), reserved together in one database
 * transaction and given back if Claude is never called; otherwise the
 * offline helper answers.
 */
export function admitQueryChat(userId: string, ontologyId: string, isMember: boolean): QueryChatGate {
  if (busy.has(userId)) throw new HttpError(429, 'Still answering your previous question');
  const now = Date.now();
  const mine = (recent.get(userId) ?? []).filter((t) => now - t < QUERY_CHAT_LIMITS.windowMs);
  if (mine.length >= QUERY_CHAT_LIMITS.perUser) throw new HttpError(429, 'That’s a lot of questions in a short time. Try again in a few minutes, or edit the query directly.');
  recent.set(userId, [...mine, now]);
  busy.add(userId);
  let reserved: string[] = [];
  let spent = false;
  const gate = (useClaude: boolean, offlineReason?: QueryChatResponse['offlineReason']): QueryChatGate => ({
    useClaude,
    offlineReason,
    spend: () => void (spent = true),
    done: () => {
      busy.delete(userId);
      if (reserved.length && !spent) releaseCounters(reserved);
      reserved = [];
    },
  });
  try {
    if (config.llm.provider !== 'anthropic') return gate(false, 'unavailable');
    if (!isMember) return gate(false, 'not-member');
    const counters = allowanceCounters(new Date(now).toISOString().slice(0, 10), userId, ontologyId);
    if (!reserveCounters(counters, `query-assistant:${new Date(now).toISOString().slice(0, 10)}`)) return gate(false, 'limit');
    reserved = counters.map((c) => c.id);
    return gate(true);
  } catch (e) {
    busy.delete(userId);
    throw e;
  }
}

/** Tests only. */
export function resetQueryChatLimits() {
  recent.clear();
  busy.clear();
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
  // The offline helper's record of its last query: checked properly later, only bounded here.
  const offlineState = b.offlineState !== undefined && JSON.stringify(b.offlineState).length <= 20_000 ? b.offlineState : undefined;
  return { messages, query, target: b.target === 'data' ? 'data' : 'ontology', dataSummary, offlineState };
}

export interface QueryChatOptions {
  /** Whether Claude may answer (membership and budget allowing); otherwise the offline helper does. */
  useClaude: boolean;
  /** Called just before the first request to Claude. */
  onClaude?: () => void;
}

export async function queryChat(graph: OntologyGraph, req: QueryChatRequest, opts: QueryChatOptions): Promise<Omit<QueryChatResponse, 'offlineReason'>> {
  const view = graph.view();
  const offline = () => ({ ...checked(req, offlineQuery(view, req)), simulated: true });
  if (!opts.useClaude) return offline();

  // Everything from the ontology and the conversation is data written by people, not instructions.
  const context = [
    `<ontology>\n${fenceForPrompt(ontologyDigest(graph)).slice(0, 40_000)}\n</ontology>`,
    `<sample_counts>\n${fenceForPrompt(dataLine(req, view.prefixes))}\n</sample_counts>`,
    `<current_query target="${req.target}">\n${fenceForPrompt(req.query.trim()) || '(empty)'}\n</current_query>`,
    `<conversation>\n${fenceForPrompt(conversation(req))}\n</conversation>`,
  ].join('\n\n');
  const call = (messages: { role: 'user' | 'assistant'; content: string }[], task: string) =>
    llm.json({ task, system: QUERY_ASSISTANT, schema: QueryChatSchema, effort: 'medium', maxTokens: 2500, messages, fallback: () => offlineQuery(view, req) });

  const ask = [{ role: 'user' as const, content: `${context}\n\nWrite the next turn for the person's latest message.` }];
  opts.onClaude?.();
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

type OntologyQuestion = 'no-definition' | 'properties' | 'classes';

function ontologyQuestion(text: string): OntologyQuestion | undefined {
  if (/\b(without|missing|no|lack\w*)\b.*\bdefinitions?\b/.test(text)) return 'no-definition';
  if (/\bpropert(y|ies)\b|\brelationships?\b/.test(text)) return 'properties';
  if (/\b(classes|class hierarchy|types of thing|kinds of thing)\b/.test(text)) return 'classes';
  return undefined;
}

function ontologyDraft(q: OntologyQuestion): Draft {
  const pfx = `PREFIX rdfs: <${NS.rdfs}>\nPREFIX owl: <${NS.owl}>\nPREFIX skos: <${NS.skos}>\n`;
  if (q === 'no-definition')
    return {
      reply: 'Here are the classes that have no definition yet.',
      target: 'ontology',
      query: `${pfx}\nSELECT ?class ?label WHERE {\n  ?class a owl:Class .\n  FILTER(isIRI(?class))\n  OPTIONAL { ?class rdfs:label ?label }\n  FILTER NOT EXISTS { ?class skos:definition ?definition }\n}\nORDER BY ?label`,
      columns: [{ variable: 'class', label: 'Class' }, { variable: 'label', label: 'Label' }],
    };
  if (q === 'properties')
    return {
      reply: 'Here are the ontology’s properties with their labels, domains and ranges.',
      target: 'ontology',
      query: `${pfx}\nSELECT ?property ?label ?domain ?range WHERE {\n  VALUES ?type { owl:ObjectProperty owl:DatatypeProperty }\n  ?property a ?type .\n  OPTIONAL { ?property rdfs:label ?label }\n  OPTIONAL { ?property rdfs:domain ?domain }\n  OPTIONAL { ?property rdfs:range ?range }\n}\nORDER BY ?label`,
      columns: [{ variable: 'property', label: 'Property' }, { variable: 'label', label: 'Label' }, { variable: 'domain', label: 'Domain' }, { variable: 'range', label: 'Range' }],
    };
  return {
    reply: 'Here are the ontology’s classes with their labels and definitions.',
    target: 'ontology',
    query: `${pfx}\nSELECT ?class ?label ?definition WHERE {\n  ?class a owl:Class .\n  FILTER(isIRI(?class))\n  OPTIONAL { ?class rdfs:label ?label }\n  OPTIONAL { ?class skos:definition ?definition }\n}\nORDER BY ?label`,
    columns: [{ variable: 'class', label: 'Class' }, { variable: 'label', label: 'Label' }, { variable: 'definition', label: 'Definition' }],
  };
}

/** What the offline helper has built so far: a list of records, or a fixed question about the model. */
type OfflineState = { kind: 'records'; cls: ClassView; model: BuilderModel } | { kind: 'ontology'; question: OntologyQuestion };
type RecordsState = Extract<OfflineState, { kind: 'records' }>;

/** The same, as sent to the browser and back: plain JSON, checked against the ontology on its return. */
const FILTER_OPS = ['contains', 'equals', 'notEquals', 'gt', 'gte', 'lt', 'lte', 'startsWith', 'regex'] as const;
const WireStep: z.ZodType<PathStep> = z.lazy(() =>
  z.object({
    id: z.string().max(40),
    property: z.string().max(500),
    valueType: z.enum(['text', 'number', 'boolean', 'resource']).optional(),
    optional: z.boolean(),
    show: z.boolean(),
    filter: z.object({ op: z.enum(FILTER_OPS), value: z.string().max(200) }).optional(),
    children: z.array(WireStep).max(5),
  }),
);
const WireState = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('records'),
    classIri: z.string().max(500),
    model: z.object({ steps: z.array(WireStep).max(30), countOnly: z.boolean(), orderBy: z.string().max(40).optional(), descending: z.boolean(), limit: z.number().int().positive().max(100_000).optional() }),
  }),
  z.object({ kind: z.literal('ontology'), question: z.enum(['no-definition', 'properties', 'classes']) }),
]);

function toWire(state: OfflineState): z.infer<typeof WireState> {
  if (state.kind === 'ontology') return state;
  const { steps, countOnly, orderBy, descending, limit } = state.model;
  return { kind: 'records', classIri: state.cls.iri, model: { steps, countOnly, orderBy, descending, limit } };
}

/** The state the browser sent back, if it is well formed and only uses this ontology's terms. */
function fromWire(ctx: Ctx, raw: unknown): OfflineState | undefined {
  const parsed = WireState.safeParse(raw);
  if (!parsed.success) return undefined;
  const w = parsed.data;
  if (w.kind === 'ontology') return w;
  const cls = ctx.classes.find((c) => c.iri === w.classIri);
  if (!cls) return undefined;
  const known = new Set([RDFS_LABEL, ...propsFor(ctx.view, cls).all.map((p) => p.iri)]);
  const ok = (steps: PathStep[], depth: number): boolean => steps.every((s) => (depth ? s.property === RDFS_LABEL : known.has(s.property)) && s.children.length <= (depth ? 0 : 1) && ok(s.children, depth + 1));
  if (!ok(w.model.steps, 0)) return undefined;
  return { kind: 'records', cls, model: { rootClass: cls.iri, includeSubclasses: true, distinct: true, ...w.model } };
}

/** "also…", "only…", "remove…": the message changes the previous query rather than asking a new question. */
const REFINE = /^\s*(also|and|only|just|now|but|then|plus|add|include|remove|drop|hide|without|exclude|except|sort|order|filter|limit|show only|make it|instead)\b|\b(as well|too|instead|those|them|these)\b/i;
const REMOVE = /\b(remove|drop|hide|without|exclude|no longer show|don['’]?t show|do not show|leave out|take out)\b/i;
/** "only those offered by …", "where …": a condition, which must become filters or the message is declined. */
const CONDITION = /\b(only|just)\s+(those|the ones|ones|records|items|where|whose|with|that|which|if)\b|\b(where|whose)\b/i;
const NO_LIMIT = /\b(all of them|everything|every one|all results|all records|all rows|no limit|without (a |the )?(row )?limit|(remove|drop|lift|take off) the (row )?limit)\b/i;
const FILTER_HELP =
  'Offline, I can filter on a number (only those with a minimum age under 15) or on a quoted phrase, in the name or in a named property (only those offered by “Northvale”), joined with “and”. For anything else, edit the query directly.';

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

/**
 * A message with each quoted phrase replaced by a placeholder (`\0N\0`), so a
 * quoted value is only ever a value: "called "count"" filters on the word, it
 * doesn't count. Straight single quotes only count as quotes around words
 * (not the apostrophe in "don't").
 */
interface Said {
  plain: string;
  phrases: string[];
}
const QUOTED = /["“]([^"”]{1,200})["”]|‘([^’]{1,200})’|(?<=^|[\s(:,])'([^']{1,200})'(?=$|[\s.,;:!?)])/g;
const PLACEHOLDER = /\u0000(\d+)\u0000/;
const PLACEHOLDERS = /\u0000(\d+)\u0000/g;
function said(text: string): Said {
  const phrases: string[] = [];
  const plain = text.replace(QUOTED, (_, a?: string, b?: string, c?: string) => `\u0000${phrases.push((a ?? b ?? c ?? '').trim()) - 1}\u0000`);
  return { plain, phrases };
}
const unquote = (text: string, s: Said) => text.replace(PLACEHOLDERS, (_, i: string) => `“${s.phrases[Number(i)]}”`).trim();

/** The message split into what to show (before any condition) and the condition itself. */
function split(text: string): { show: string; condition?: string } {
  const m = CONDITION.exec(text);
  return m ? { show: text.slice(0, m.index), condition: text.slice(m.index) } : { show: text };
}

/** Words that carry no meaning of their own in a condition. */
const FILLER = new Set([...STOP, 'those', 'ones', 'one', 'that', 'are', 'was', 'were', 'be', 'their', 'than', 'whose', 'where', 'value', 'values', 'years', 'year', 'old', 'aged', 'only', 'just', 'records', 'items', 'please', 'than']);

/** Words of the text not accounted for by the given phrases, numbers or filler: if any are left, part of the request would be ignored. */
function leftover(text: string, used: string[]): string[] {
  const usedStems = new Set(used.flatMap((u) => normalise(u).trim().split(' ')).filter(Boolean).map(stem));
  return normalise(text.replace(PLACEHOLDERS, ' '))
    .trim()
    .split(' ')
    .filter((w) => w.length > 1 && !FILLER.has(w) && !usedStems.has(stem(w)) && !/^-?\d+(\.\d+)?$/.test(w));
}

const QUOTE_LEADS = ['called', 'named', 'titled', 'containing', 'contains', 'contain', 'name', 'title', 'mention', 'mentions', 'mentioning', 'include', 'includes', 'including'];

/**
 * Every clause of a condition as a filter, or why one can't be: a number
 * comparison on a number property (named, or the only one shown), or a quoted
 * phrase in a named property, in a linked thing's label, or in the name.
 * Clauses are joined with "and", one per property. Anything not understood,
 * including stray words in a clause, declines the whole message: never guessed,
 * never quietly dropped.
 */
function conditionFilters(ctx: Ctx, state: RecordsState, condition: string, s: Said): { apply: () => void } | { declined: string } {
  const { all, nameProp } = propsFor(ctx.view, state.cls);
  const model = state.model;
  const propOf = (st: PathStep) => all.find((p) => p.iri === st.property);
  if (/\bor\b|\bnot\b|\bisn['’]?t\b|\bexcept\b|\bnor\b/i.test(condition)) return { declined: `I can’t combine conditions with “or” or “not” offline. ${FILTER_HELP}` };
  const clauses = condition
    .replace(CONDITION, ' ')
    .split(/,|;|\band\b|\bbut\b|\balso\b|(?=\b(?:called|named|titled|containing|contains)\b)/i)
    .map((c) => c.trim())
    .filter((c) => c && leftover(c, []).length + (PLACEHOLDER.test(c) ? 1 : 0) + (/\d/.test(c.replace(PLACEHOLDERS, '')) ? 1 : 0) > 0);
  if (!clauses.length) return { declined: `I couldn’t find a condition in that. ${FILTER_HELP}` };
  const actions: (() => void)[] = [];
  const targets = new Map<string, string>();
  const once = (key: string, what: string): string | undefined => {
    if (targets.has(key)) return `I can apply only one condition to ${what} offline, and that asks for two. Edit the query to combine them.`;
    targets.set(key, what);
    return undefined;
  };
  for (const clause of clauses) {
    const shown = unquote(clause, s);
    const words = clause.replace(PLACEHOLDERS, ' ');
    const named = all.filter((p) => mentions(words, labelOf(p)));
    const quoted = [...clause.matchAll(PLACEHOLDERS)];
    const num = [...words.matchAll(/(-?\d+(?:\.\d+)?)/g)];
    const opHit = NUMBER_OPS.filter(([re]) => re.test(clause));
    if (quoted.length > 1 || num.length > 1 || opHit.length > 1) return { declined: `I couldn’t turn “${shown}” into one filter. Join separate conditions with “and”. ${FILTER_HELP}` };
    const op = opHit[0]?.[1];
    if (quoted.length === 1 && !op && !num.length) {
      const value = s.phrases[Number(quoted[0][1])];
      if (named.length > 1) return { declined: `I couldn’t tell which property “${value}” is about. ${FILTER_HELP}` };
      const p = named[0] ?? nameProp;
      const extra = leftover(clause, [...(named[0] ? [labelOf(named[0])] : []), ...QUOTE_LEADS]);
      if (extra.length || (!named[0] && !new RegExp(`\\b(${QUOTE_LEADS.join('|')})\\b`, 'i').test(clause)))
        return { declined: `I couldn’t tell what “${value}” should match in “${shown}”. ${FILTER_HELP}` };
      if (p && valueTypeOf(p) === 'number') return { declined: `${labelOf(p)} is a number, so compare it with “over”, “under” or “at least”. ${FILTER_HELP}` };
      const twice = once(p?.iri ?? RDFS_LABEL, p ? labelOf(p) : 'the name');
      if (twice) return { declined: twice };
      actions.push(() => {
        let st = p ? model.steps.find((x) => x.property === p.iri) : model.steps.find((x) => x.property === RDFS_LABEL);
        if (!st) model.steps.push((st = p ? stepFor(p) : newStep(RDFS_LABEL)));
        // A linked thing matches on its label.
        const target = st.children.find((c) => c.property === RDFS_LABEL) ?? st;
        target.filter = { op: 'contains', value };
      });
    } else if (num.length === 1 && op && !quoted.length) {
      const numberNamed = named.filter((p) => valueTypeOf(p) === 'number');
      if (named.length > numberNamed.length) return { declined: `“${shown}” mentions ${named.filter((p) => valueTypeOf(p) !== 'number').map(labelOf).join(' and ')}, which isn’t a number. Give each condition its own clause, joined with “and”. ${FILTER_HELP}` };
      const shownNumbers = model.steps.filter((x) => x.valueType === 'number');
      const p = numberNamed.length === 1 ? numberNamed[0] : named.length === 0 && shownNumbers.length === 1 ? propOf(shownNumbers[0]) : undefined;
      if (!p) return { declined: `I couldn’t tell which number “${shown}” is about. ${FILTER_HELP}` };
      const opWords = (NUMBER_OPS.find(([, o]) => o === op)![0].exec(clause) ?? [''])[0];
      const extra = leftover(clause, [labelOf(p), opWords]);
      if (extra.length) return { declined: `I couldn’t tell what “${extra.join(' ')}” means in “${shown}”, so I haven’t changed the query. ${FILTER_HELP}` };
      const twice = once(p.iri, labelOf(p));
      if (twice) return { declined: twice };
      actions.push(() => {
        let st = model.steps.find((x) => x.property === p.iri);
        if (!st) model.steps.push((st = stepFor(p)));
        st.filter = { op, value: num[0][1] };
      });
    } else return { declined: `I couldn’t turn “${shown}” into a filter, so I haven’t changed the query. ${FILTER_HELP}` };
  }
  return { apply: () => actions.forEach((a) => a()) };
}

/** Counting, sorting and the row limit, from one message (quoted phrases already out of the way). Returns whether anything changed. */
function applyShape(ctx: Ctx, state: RecordsState, text: string): boolean {
  const { model, cls } = state;
  const { all } = propsFor(ctx.view, cls);
  const propOf = (st: PathStep) => all.find((p) => p.iri === st.property);
  const plain = text.replace(PLACEHOLDERS, ' ');
  let changed = false;
  if (/\bhow many\b|\bcount\b|\bnumber of\b/i.test(plain)) (model.countOnly = true), (changed = true);
  else if (model.countOnly && /\b(list|show|which)\b/i.test(plain)) (model.countOnly = false), (changed = true);
  if (NO_LIMIT.test(plain)) (model.limit = undefined), (changed = true);
  const limit = /\b(?:first|top|limit(?: to)?)\s+(\d{1,5})\b/i.exec(plain);
  if (limit) (model.limit = Math.max(1, Number(limit[1]))), (changed = true);
  const sort = /\b(?:sort|order)(?:ed)? by (?:the |its )?([\w ’'-]+?)(?:\s+(descending|ascending|highest first|lowest first|newest first|oldest first))?[.?!]?$/i.exec(plain.trim());
  if (sort) {
    const st = model.steps.find((x) => mentions(sort[1], x.property === RDFS_LABEL ? 'label' : labelOf(propOf(x) ?? { iri: x.property })));
    if (st) (model.orderBy = st.id), (changed = true);
    if (sort[2]) (model.descending = /descending|highest|newest/i.test(sort[2])), (changed = true);
  }
  return changed;
}

/** A condition without "only"/"where": a quoted phrase or a comparison still reads as one ("called 'park'", "under 15"). */
const looksLikeCondition = (text: string) => PLACEHOLDER.test(text) || NUMBER_OPS.some(([re]) => re.test(text));

/** A new list of records, from a message that names the class (or none, for the class with the most records). */
function startRecords(ctx: Ctx, cls: ClassView, text: string, s: Said): RecordsState | { declined: string } {
  const { all, nameProp } = propsFor(ctx.view, cls);
  const { show, condition } = split(text);
  const showWords = show.replace(PLACEHOLDERS, ' ');
  const mentioned = all.filter((p) => mentions(showWords, labelOf(p)));
  const chosen = [...new Set([...(nameProp ? [nameProp] : []), ...mentioned])];
  const steps = chosen.map(stepFor);
  if (!nameProp) steps.unshift(newStep(RDFS_LABEL));
  const model: BuilderModel = { rootClass: cls.iri, includeSubclasses: true, steps, distinct: true, countOnly: false, descending: false, orderBy: steps[0]?.id, limit: 100 };
  const state: RecordsState = { kind: 'records', cls, model };
  const cond = condition ?? (looksLikeCondition(show) ? show.replace(new RegExp(`^.*?\\b${labelOf(cls).split(' ').at(-1)!.replace(/y$/, '')}\\w*\\b`, 'i'), ' ') : undefined);
  if (cond) {
    const f = conditionFilters(ctx, state, cond, s);
    if ('declined' in f) return f;
    f.apply();
  }
  applyShape(ctx, state, text);
  return state;
}

type Step = { state: OfflineState } | { declined: string };

const NOT_MINE = 'The offline helper can only change queries it wrote itself, and it didn’t write the one in the editor (or it has been changed since). Edit it directly, or ask a new question such as “List every …”.';

/** Applies one message to the previous state: a new question starts afresh; a refinement changes it, or is declined whole. */
function step(ctx: Ctx, prev: OfflineState | undefined, s: Said): Step {
  const text = s.plain;
  const words = text.replace(PLACEHOLDERS, ' ');
  const cls = mentionedClass(ctx, words);
  if (REFINE.test(words)) {
    if (!prev) return { declined: NOT_MINE };
    if (prev.kind === 'ontology') return { declined: 'That last question was about the model itself, so there’s no list of records to change. Ask for records first, for example “List every …”.' };
    if (cls && cls.iri !== prev.cls.iri) return { declined: `That mentions ${labelOf(cls)} records, but the query lists ${labelOf(prev.cls)} records. To start a new list, ask without “also” or “only”, for example “List every ${labelOf(cls)}”.` };
    return refine(ctx, prev, s);
  }
  const ontology = ontologyQuestion(normalise(words));
  if (ontology && !cls) return { state: { kind: 'ontology', question: ontology } };
  if (cls) {
    const r = startRecords(ctx, cls, text, s);
    return 'declined' in r ? r : { state: r };
  }
  // No class named: "how many are there?" refines the list; otherwise start from the class with the most records.
  if (prev?.kind === 'records') return refine(ctx, prev, s);
  const top = [...ctx.classes].sort((a, b) => (ctx.counts.get(b.iri) ?? 0) - (ctx.counts.get(a.iri) ?? 0))[0];
  const r = startRecords(ctx, top, text, s);
  return 'declined' in r ? r : { state: r };
}

const FILTER_WORDS = /\b(filters?|conditions?|restrictions?)\b/i;

function refine(ctx: Ctx, prev: RecordsState, s: Said): Step {
  const text = s.plain;
  const words = text.replace(PLACEHOLDERS, ' ');
  const state = structuredClone(prev) as RecordsState;
  state.cls = prev.cls;
  const { all } = propsFor(ctx.view, state.cls);
  let changed = false;
  if (REMOVE.test(words) && !NO_LIMIT.test(words)) {
    const after = words.slice(REMOVE.exec(words)!.index);
    if (CONDITION.test(after) || PLACEHOLDER.test(text.slice(REMOVE.exec(text)?.index ?? 0))) return { declined: `I can remove things or add conditions, but not both in one message. ${FILTER_HELP}` };
    const named = all.filter((p) => mentions(after, labelOf(p)));
    const verb = REMOVE.exec(after)![0];
    if (FILTER_WORDS.test(after)) {
      // Only an explicit "all" removes every filter; anything named must be a filter that is there, and nothing may be left unexplained.
      const every = /\b(all|every|each)\b/i.test(after);
      const extra = leftover(after, [verb, ...named.map(labelOf), 'filter', 'filters', 'condition', 'conditions', 'restriction', 'restrictions', 'all', 'every', 'each', 'remove', 'drop', 'clear']);
      if (extra.length) return { declined: `There’s no “${extra.join(' ')}” filter here, so I haven’t changed the query. Name a filter that’s there, for example “remove the minimum age filter”, or say “remove all the filters”.` };
      if (named.length && every) return { declined: 'Did you mean all the filters, or just the ones you named? Say “remove all the filters”, or name them without “all”.' };
      if (named.length) {
        for (const p of named) {
          const st = state.model.steps.find((x) => x.property === p.iri);
          const target = st && (st.filter ? st : st.children.find((c) => c.filter));
          if (!target) return { declined: `There’s no ${labelOf(p)} filter to remove.` };
          delete target.filter;
        }
      } else if (every) {
        for (const st of state.model.steps) for (const x of [st, ...st.children]) delete x.filter;
      } else return { declined: 'I couldn’t tell which filter to remove. Name it, for example “remove the minimum age filter”, or say “remove all the filters”.' };
      changed = true;
    } else {
      const extra = leftover(after, [verb, ...named.map(labelOf), 'column', 'columns', 'show', 'showing', 'remove', 'drop', 'hide', 'out', 'leave', 'take']);
      if (!named.length || extra.length) return { declined: `I couldn’t tell which column to remove${extra.length ? ` (“${extra.join(' ')}”)` : ''}. Name it, for example “remove the minimum age”.` };
      state.model.steps = state.model.steps.filter((x) => !named.some((p) => p.iri === x.property));
      if (!state.model.steps.length) state.model.steps = [newStep(RDFS_LABEL)];
      if (!state.model.steps.some((x) => x.id === state.model.orderBy)) state.model.orderBy = state.model.steps[0].id;
      changed = true;
    }
  } else {
    const { show, condition } = split(text);
    const showWords = show.replace(PLACEHOLDERS, ' ');
    for (const p of all.filter((p) => mentions(showWords, labelOf(p)))) if (!state.model.steps.some((x) => x.property === p.iri)) state.model.steps.push(stepFor(p)), (changed = true);
    const cond = condition ?? (looksLikeCondition(show) ? show : undefined);
    if (cond) {
      const f = conditionFilters(ctx, state, cond, s);
      if ('declined' in f) return f;
      f.apply();
      changed = true;
    }
  }
  changed = applyShape(ctx, state, text) || changed;
  if (!changed) return { declined: 'I couldn’t tell what to change. Try “also show …”, “only those with … over 10”, “remove …”, or “all of them”.' };
  return { state };
}

function mentionedClass(ctx: Ctx, text: string): ClassView | undefined {
  return ctx.classes.filter((c) => mentions(text, labelOf(c))).sort((a, b) => labelOf(b).length - labelOf(a).length)[0];
}

function render(ctx: Ctx, state: OfflineState): Draft {
  if (state.kind === 'ontology') return { ...ontologyDraft(state.question), offlineState: toWire(state) };
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
  return { reply, query, target: 'data', columns, offlineState: toWire(state) };
}

/**
 * Builds the query from the latest message and the helper's own record of its
 * previous query (sent back by the browser, so it survives however long the
 * conversation gets). A message that names a class or asks about the model
 * starts a new question; "also…", "only…", "remove…" refine the previous one,
 * but only while the editor still holds exactly that query: the helper never
 * rewrites a query edited by hand or written by Claude, and declines what it
 * can't do rather than quietly dropping part of the request.
 */
export function offlineQuery(view: OntologyView, req: QueryChatRequest): Draft {
  const ctx: Ctx = { view, classes: view.classes.filter((c) => !c.deprecated), counts: new Map((req.dataSummary ?? []).map((d) => [d.classIri, d.count])) };
  if (!ctx.classes.length) return unchanged(req, 'This ontology has no classes yet, so there is nothing to query. Add some classes first, or write SPARQL in the editor.');
  const latest = req.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
  const sent = fromWire(ctx, req.offlineState);
  // The record only counts while the editor still holds the query it describes.
  const prev = sent && render(ctx, sent).query.trim() === req.query.trim() ? sent : undefined;
  const next = step(ctx, prev, said(latest));
  if ('declined' in next) return unchanged(req, next.declined);
  return render(ctx, next.state);
}
