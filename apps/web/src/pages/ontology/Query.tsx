import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { ChevronLeft, ChevronRight, Code2, Cpu, Database, Download, Loader2, Play, RotateCcw, Search, ShieldCheck, Sparkles, Square, Table2 } from 'lucide-react';
import type { SparqStore } from '@sparq-org/sparq';
import type { Completion } from '@codemirror/autocomplete';
import type { ChatMessage, QueryChatResponse, QueryTarget } from '@concord/shared';
import { api } from '../../api';
import { useAsync, useLocalStorage } from '../../lib/hooks';
import { allTerms, makeLabeler } from '../../lib/ontology';
import { insertTerm } from '../../lib/prefixes';
import { toCsv } from '../../lib/csv';
import { queryForm, sparqlExamples } from '../../lib/sparql-examples';
import { QueryRunner, QueryStopped, type RunResult } from '../../lib/queryRunner';
import { limitOf, withoutLimit } from '../../lib/sparqlLimit';
import { Badge, Button, Card, CardHeader, ErrorCard, InlineError, Loading, Select, cx } from '../../components/ui';
import { CodeEditor } from '../../components/code/CodeEditor';
import { CodeView } from '../../components/code/CodeView';
import { ChatView } from '../../components/ChatView';
import { accountToken, stillCurrent, useSession } from '../../lib/session';
import { useOntology } from './Layout';

/**
 * Query the ontology and check instance data in the browser, using the sparq
 * SPARQL engine compiled to WebAssembly. Queries are written by describing
 * them to the query assistant in a chat beside the editor (each message
 * refines the query), or directly in the highlighted SPARQL editor, with
 * autocomplete for the ontology's terms. Sample data never leaves the page:
 * the assistant gets the conversation, the query, and record counts.
 */

const sparqModule = () => import('@sparq-org/sparq');

/** A result as shown: rows get the assistant's readable headings, by column position. */
type Result = (RunResult & { kind: 'ask' | 'graph' }) | (Extract<RunResult, { kind: 'rows' }> & { headings?: (string | undefined)[] });

type Target = QueryTarget;
type Columns = { variable: string; label: string }[];

/** Sample data for the demo (volunteering) ontology. Other ontologies start from an empty skeleton. */
const DEMO_DATA = (ns: string, prefix: string) => `@prefix ${prefix}: <${ns}> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix ex: <https://example.org/data/> .

# Example records. The Saturday shift's minimum age is deliberately written as
# text ("sixteen") so that "Check" has a problem to find.

ex:foodbank a ${prefix}:VolunteerInvolvingOrganisation ;
  rdfs:label "Northvale Food Bank" .

ex:saturday-shift a ${prefix}:VolunteeringOpportunity ;
  ${prefix}:title "Saturday food bank shift" ;
  ${prefix}:offeredBy ex:foodbank ;
  ${prefix}:minimumAge "sixteen" .

ex:park-clean-up a ${prefix}:VolunteeringOpportunity ;
  ${prefix}:title "Park clean-up" ;
  ${prefix}:offeredBy ex:foodbank ;
  ${prefix}:minimumAge "14"^^xsd:nonNegativeInteger .
`;

const EMPTY_DATA = (ns: string, prefix: string) => `@prefix ${prefix}: <${ns}> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix ex: <https://example.org/data/> .

# Add example records that use this ontology, for example:
# ex:thing1 a ${prefix}:SomeClass ; rdfs:label "Thing one" .
`;

function short(v: string, prefixes: Record<string, string>) {
  for (const [p, ns] of Object.entries(prefixes)) if (v.startsWith(ns)) return `${p}:${v.slice(ns.length)}`;
  return v;
}


function Segmented<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { id: T; label: string; icon: typeof Code2 }[]; label: string }) {
  return (
    <div className="inline-flex gap-1 rounded-lg border border-line-strong p-0.5" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          aria-pressed={o.id === value}
          onClick={() => onChange(o.id)}
          className={cx('inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-sm', o.id === value ? 'bg-accent text-accent-fg' : 'text-muted hover:text-fg')}
        >
          <o.icon className="size-3.5" />
          {o.label}
        </button>
      ))}
    </div>
  );
}

const ROWS_PER_PAGE = 50;

const OFFLINE_NOTE: Record<NonNullable<QueryChatResponse['offlineReason']>, string> = {
  unavailable: 'Offline helper: Claude isn’t connected right now, so this matches your words to the ontology’s terms and refines its own queries step by step.',
  'not-member': 'Offline helper: Claude writes queries for members of this ontology. This helper matches your words to the ontology’s terms instead.',
  limit: 'Offline helper: the assistant has reached today’s usage limit, so this matches your words to the ontology’s terms instead.',
};

const FINDINGS_PER_PAGE = 20;

/** Previous / next paging for long results, so a big answer doesn't flood the page. */
function Pager({ page, pageSize, total, onPage, label }: { page: number; pageSize: number; total: number; onPage: (p: number) => void; label: string }) {
  const pages = Math.ceil(total / pageSize);
  if (pages <= 1) return null;
  return (
    <nav className="flex items-center justify-end gap-2 px-3 py-1.5 text-xs text-muted" aria-label={label}>
      <span>
        {page * pageSize + 1}–{Math.min(total, (page + 1) * pageSize)} of {total.toLocaleString()}
      </span>
      <Button size="sm" variant="ghost" icon={ChevronLeft} onClick={() => onPage(page - 1)} disabled={page === 0} aria-label="Previous page" />
      <span>
        Page {page + 1} of {pages}
      </span>
      <Button size="sm" variant="ghost" icon={ChevronRight} onClick={() => onPage(page + 1)} disabled={page >= pages - 1} aria-label="Next page" />
    </nav>
  );
}

type Workspace = 'query' | 'check';

/**
 * One workspace per ontology and account: switching either starts fresh rather
 * than carrying a draft or conversation across (on a shared browser, the next
 * person never sees, or sends on, the previous person's chat).
 */
export function QueryTab() {
  const { id } = useOntology();
  const { session, loading } = useSession();
  const account = session?.user?.id ?? 'guest';
  useEffect(() => {
    // Drafts from before they were kept per account belong to nobody in particular: drop them.
    try {
      for (const k of Object.keys(localStorage)) if (k.startsWith(`concord.query.${id}.`)) localStorage.removeItem(k);
    } catch {
      /* storage unavailable */
    }
  }, [id]);
  // Wait for the session so a signed-in person's drafts open straight away, not a guest's first.
  if (loading && !session) return <Loading className="py-12" />;
  return <QueryWorkspace key={`${account}:${id}`} account={account} storageKey={`concord.query.${account}.${id}`} />;
}

/**
 * Records in the sample data: typed subjects, read by parsing the Turtle. Per
 * class for choosing where to start, and in total counting each subject once
 * even when it has several types.
 */
async function countRecords(data: string): Promise<{ byClass: Map<string, number>; total: number }> {
  const { SparqStore } = await sparqModule();
  const counts = new Map<string, number>();
  let total = 0;
  try {
    const s = await SparqStore.fromString(data, 'turtle');
    try {
      const json = JSON.parse(s.queryJson('SELECT ?c (COUNT(DISTINCT ?s) AS ?n) WHERE { ?s a ?c } GROUP BY ?c')) as { results: { bindings: { c: { value: string }; n: { value: string } }[] } };
      for (const b of json.results.bindings) counts.set(b.c.value, Number(b.n.value));
      const all = JSON.parse(s.queryJson('SELECT (COUNT(DISTINCT ?s) AS ?n) WHERE { ?s a ?c }')) as { results: { bindings: { n: { value: string } }[] } };
      total = Number(all.results.bindings[0]?.n.value ?? 0);
    } finally {
      s.free();
    }
  } catch {
    /* Unparseable data counts as no records; Check data reports the error. */
  }
  return { byClass: counts, total };
}

function QueryWorkspace({ storageKey, account }: { storageKey: string; account: string }) {
  const { id, ontology } = useOntology();
  const { session, setSession } = useSession();
  const [params, setParams] = useSearchParams();
  const setParam = (k: string, v: string) => {
    const n = new URLSearchParams(params);
    n.set(k, v);
    setParams(n, { replace: true });
  };
  // One workspace at a time; both keep their inputs and results when you switch.
  const workspace: Workspace = params.get('view') === 'check' ? 'check' : 'query';
  const setWorkspace = (w: Workspace) => setParam('view', w);
  const [rowPage, setRowPage] = useState(0);
  const [findingPage, setFindingPage] = useState(0);

  const turtle = useAsync(() => api.source(id, 'turtle'), [id]);
  const shapes = useAsync(() => api.source(id, 'shacl'), [id]);
  const view = useAsync(() => api.view(id), [id]);
  // The ontology store on this thread loads the ontology (the "triples loaded" badge) and checks data with SHACL.
  const storeRef = useRef<SparqStore | null>(null);
  // Queries run in a worker that Cancel and the time limit can stop.
  const runnerRef = useRef<QueryRunner | null>(null);
  const runner = () => (runnerRef.current ??= new QueryRunner());
  const [running, setRunning] = useState(false);
  const [ready, setReady] = useState<{ ms: number; triples: number } | null>(null);
  const [loadError, setLoadError] = useState<unknown>();

  const examples = useMemo(() => sparqlExamples(ontology.prefix, ontology.namespace), [ontology.prefix, ontology.namespace]);
  // Drafts survive leaving the page, per ontology and per browser.
  const [query, setQuery] = useLocalStorage(`${storageKey}.sparql`, examples[0].query);
  // The dataset is part of the draft: a restored instance query must still run against the data.
  const [target, setTarget] = useLocalStorage<Target>(`${storageKey}.target`, 'ontology');
  const [result, setResultState] = useState<Result | null>(null);
  const [queryError, setQueryError] = useState<unknown>();
  const [queryMs, setQueryMs] = useState<number>();
  const [data, setData] = useLocalStorage(`${storageKey}.data`, (ontology.demo ? DEMO_DATA : EMPTY_DATA)(ontology.namespace, ontology.prefix));
  const [report, setReportState] = useState<{ conforms: boolean; results: { focusNode?: string; path?: string; severity?: string; message?: string }[] } | null>(null);
  const [checkError, setCheckError] = useState<unknown>();

  const setResult = (r: Result | null) => {
    setResultState(r);
    setRowPage(0);
  };
  const setReport = (r: typeof report) => {
    setReportState(r);
    setFindingPage(0);
  };
  const label = useMemo(() => makeLabeler(view.data), [view.data]);
  const prefixes = view.data?.prefixes ?? { [ontology.prefix]: ontology.namespace };

  // How many records of each class the sample data has, for the dataset summary and the starting class.
  const [recordCounts, setRecordCounts] = useState<{ byClass: Map<string, number>; total: number }>();
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => void countRecords(data).then((c) => !cancelled && setRecordCounts(c)), recordCounts ? 400 : 0);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- recount when the data changes
  }, [data]);
  const recordTotal = recordCounts?.total;

  // The query assistant's conversation, and the column headings it gave for the current query.
  const [chat, setChat] = useLocalStorage<(ChatMessage & { simulated?: boolean; offlineReason?: QueryChatResponse['offlineReason'] })[]>(`${storageKey}.chat`, []);
  const [columns, setColumns] = useLocalStorage<Columns>(`${storageKey}.columns`, []);
  // Where the offline helper's last query came from, so it can keep refining it however long the chat gets.
  const [offlineState, setOfflineState] = useLocalStorage<unknown>(`${storageKey}.offlineState`, null);
  const [asking, setAsking] = useState(false);
  // The message being sent, before it is saved.
  const [pending, setPending] = useState<ChatMessage>();
  const [chatError, setChatError] = useState<unknown>();

  // Autocomplete: every term as a prefixed name, findable by its label too. Accepting
  // one adds the PREFIX (or @prefix) declaration if the text doesn't have it yet.
  const completionsFor = useCallback(
    (lang: 'sparql' | 'turtle'): Completion[] => {
      if (!view.data) return [];
      const pfx = view.data.prefixes;
      return allTerms(view.data).flatMap((t) => {
        const c = short(t.iri, pfx);
        if (c === t.iri) return [];
        const p = c.slice(0, c.indexOf(':'));
        const apply: Completion['apply'] = (v, _completion, from, to) => {
          // Reuse a matching declaration, add one if the prefix is free, or use the full IRI if it's bound elsewhere.
          const { declaration, text } = insertTerm(v.state.doc.toString(), lang, p, pfx[p], t.iri, from);
          v.dispatch({
            changes: [...(declaration ? [{ from: 0, insert: declaration }] : []), { from, to, insert: text }],
            selection: { anchor: from + text.length + (declaration?.length ?? 0) },
          });
        };
        const type = t.kind === 'class' ? 'class' : t.kind === 'individual' ? 'constant' : 'property';
        const base = { detail: t.label, type, info: t.definition, apply };
        return [{ label: c, ...base }, ...(t.label ? [{ label: t.label, displayLabel: `${t.label} → ${c}`, ...base, detail: undefined, boost: -1 }] : [])];
      });
    },
    [view.data],
  );
  const sparqlCompletions = useMemo(() => completionsFor('sparql'), [completionsFor]);
  const turtleCompletions = useMemo(() => completionsFor('turtle'), [completionsFor]);

  useEffect(() => {
    if (!turtle.data) return;
    let cancelled = false;
    const t0 = performance.now();
    setLoadError(undefined);
    sparqModule()
      .then(({ SparqStore }) => SparqStore.fromString(turtle.data!, 'turtle'))
      .then((s) => {
        if (cancelled) return s.free();
        storeRef.current?.free();
        storeRef.current = s;
        setReady({ ms: Math.round(performance.now() - t0), triples: s.countQuads(null, null, null) });
      })
      .catch((e) => !cancelled && setLoadError(e));
    return () => {
      cancelled = true;
    };
  }, [turtle.data]);
  useEffect(
    () => () => {
      storeRef.current?.free();
      runnerRef.current?.dispose();
    },
    [],
  );

  // Each answer remembers the question and data it came from, so a changed question never sits above an old answer.
  const keyFor = (q: string, t: Target) => `${t}|${q}|${t === 'data' ? data : ''}`;
  const questionKey = keyFor(query, target);
  const [ranKey, setRanKey] = useState<string>();
  const [checkedData, setCheckedData] = useState<string>();
  // The query the assistant last wrote, waiting for the person to read it and press Run.
  const [wroteKey, setWroteKey] = useState<string>();
  const awaitingRun = wroteKey === questionKey && ranKey !== questionKey;
  const resultStale = !!result && ranKey !== questionKey;
  const queryLimit = useMemo(() => limitOf(query), [query]);
  const reportStale = !!report && checkedData !== data;

  /** Runs the editor's query, or the one the assistant just wrote (state hasn't caught up yet). */
  const run = async (next?: { query: string; target: Target; columns: Columns }) => {
    if (!ready || !turtle.data) return;
    const q = next?.query ?? query;
    const t = next?.target ?? target;
    const cols = next?.columns ?? columns;
    setQueryError(undefined);
    setRanKey(keyFor(q, t));
    setRunning(true);
    try {
      const { result: r, ms } = await runner().run({ source: t === 'data' ? `${turtle.data}\n${data}` : turtle.data, query: q, form: queryForm(q) });
      if (r.kind === 'rows') {
        // The assistant's readable headings, for the columns this query still has.
        const headings = r.vars.map((v) => cols.find((c) => c.variable === v)?.label);
        setResult({ ...r, headings: headings.some((h) => h !== undefined) ? headings : undefined });
      } else setResult(r);
      setQueryMs(ms);
    } catch (e) {
      // A newer run replaced this one: that run reports its own outcome.
      if (e instanceof QueryStopped && e.reason === 'cancelled' && runnerRef.current?.running) return;
      setQueryError(e);
      setResult(null);
      setQueryMs(undefined);
    } finally {
      if (!runnerRef.current?.running) setRunning(false);
    }
  };

  /** Asks the assistant. Resolves to false when the question failed before it was kept, so the box can offer it again. */
  const ask = async (text: string): Promise<boolean | undefined> => {
    const mine: ChatMessage = { id: `m${Date.now()}`, role: 'user', content: text, at: new Date().toISOString() };
    const history = [...chat, mine];
    // Whose conversation this is, as of now: nothing is saved unless it still is, now and when the answer arrives.
    const token = accountToken();
    if (!stillCurrent(token, account)) return undefined;
    // Shown at once, but saved only after the server confirms the account.
    setPending(mine);
    setAsking(true);
    setChatError(undefined);
    let kept = false;
    let otherAccount = false;
    try {
      // This conversation belongs to one account: never send it on under another one signed in from another tab.
      // The server refuses it too if the session changes after this check.
      const now = await api.session();
      if ((now.user?.id ?? 'guest') !== account || !stillCurrent(token, account)) {
        setPending(undefined);
        otherAccount = true;
        if (stillCurrent(token, account)) setSession(now);
        throw new Error('You’re signed in as someone else now (perhaps in another tab), so this conversation wasn’t sent.');
      }
      setChat(history);
      setPending(undefined);
      kept = true;
      const r = await api.queryChat(id, {
        messages: history.filter((m) => m.role !== 'system').map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
        query,
        target,
        dataSummary: recordCounts ? [...recordCounts.byClass].map(([classIri, count]) => ({ classIri, count })) : undefined,
        offlineState: offlineState ?? undefined,
        account,
      });
      // Signed out (in this tab or another), or into another account, while waiting: this answer belongs to nobody here now.
      if (!stillCurrent(token, account)) return undefined;
      setChat((c) => [...c, { id: `m${Date.now()}a`, role: 'assistant', content: r.reply, at: new Date().toISOString(), simulated: r.simulated, offlineReason: r.offlineReason }]);
      // The editor is read-only while the assistant works, so its answer never replaces newer edits.
      // It isn't run until the person has looked at it and pressed Run.
      if (!r.unchanged) {
        setOfflineState(r.offlineState ?? null);
        setQuery(r.query);
        setTarget(r.target);
        setColumns(r.columns);
        setWroteKey(keyFor(r.query, r.target));
      }
    } catch (e) {
      setPending(undefined);
      if (!stillCurrent(token, account)) return undefined;
      setChatError(e);
      // Failed before the question was kept (the session check couldn't be made): hand it back to retry, rather than
      // lose it. Never into a box that now belongs to someone else.
      if (!kept && !otherAccount) return false;
    } finally {
      setAsking(false);
    }
    return undefined;
  };

  /** The refresh button: clears the conversation and puts the starting query back. */
  const startOver = () => {
    runnerRef.current?.cancel();
    setChat([]);
    setColumns([]);
    setOfflineState(null);
    setChatError(undefined);
    setQuery(examples[0].query);
    setTarget('ontology');
    setResult(null);
    setQueryError(undefined);
  };

  // Suggestions to start from, using this ontology's own words.
  const suggestions = useMemo(() => {
    if (!view.data) return [];
    const counts = recordCounts?.byClass ?? new Map<string, number>();
    const classes = [...view.data.classes].filter((c) => !c.deprecated).sort((a, b) => (counts.get(b.iri) ?? 0) - (counts.get(a.iri) ?? 0));
    const top = classes[0];
    const titleProp = top && view.data.datatypeProperties.find((p) => p.domain.includes(top.iri) && /title|name/i.test(p.label ?? ''));
    return [
      top && `List every ${label(top.iri)}${titleProp ? ` with its ${titleProp.label}` : ''}`,
      classes[1] && `How many ${label(classes[1].iri)} records are there?`,
      'Which classes have no definition?',
    ].filter((x): x is string => !!x);
  }, [view.data, recordCounts, label]);
  const greeting: ChatMessage = {
    id: 'greeting',
    role: 'assistant',
    content: `Tell me what you’d like to find in ${ontology.title} and I’ll write the SPARQL for you to check and run. Then ask for changes (“also show…”, “only the ones…”) or edit the query yourself.`,
    at: '',
  };
  const lastReply = [...chat].reverse().find((m) => m.role === 'assistant');

  const check = () => {
    const s = storeRef.current;
    if (!s || !shapes.data) return;
    setCheckError(undefined);
    setCheckedData(data);
    try {
      // The ontology goes in the data graph too, so sh:class sees subclass relationships.
      const r = s.validate(`${turtle.data ?? ''}\n${data}`, shapes.data, 'turtle');
      setReport({
        conforms: r.conforms,
        results: r.results.map((x) => ({
          focusNode: x.focusNode as string | undefined,
          path: x.path as string | undefined,
          severity: x.severity as string | undefined,
          message: x.message as string | undefined,
        })),
      });
    } catch (e) {
      setCheckError(e);
      setReport(null);
    }
  };

  if (turtle.error) return <ErrorCard error={turtle.error} onRetry={turtle.reload} />;
  return (
    <div className="space-y-4">
      <p className="flex flex-wrap items-center gap-2 text-sm text-muted">
        <Cpu className="size-4" />
        Queries run in your browser with the sparq engine (WebAssembly), and your sample data never leaves this page. The assistant sees your messages, the query and the ontology.
        {ready && (
          <Badge tone="ok">
            <span data-testid="sparq-ready">
              {ready.triples.toLocaleString()} triples loaded in {ready.ms} ms
            </span>
          </Badge>
        )}
      </p>
      {loadError ? <InlineError error={loadError} /> : null}

      <Segmented
        label="Workspace"
        value={workspace}
        onChange={setWorkspace}
        options={[
          { id: 'query', label: 'Query ontology', icon: Search },
          { id: 'check', label: 'Check data', icon: ShieldCheck },
        ]}
      />

      {workspace === 'query' ? (
        <div className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
            <Card className="flex min-w-0 flex-col">
              <div data-testid="query-chat" className="flex min-h-0 flex-1 flex-col">
                <CardHeader
                  title="Ask for a query"
                  subtitle="Describe what you want; each message refines the query."
                  icon={Sparkles}
                  actions={
                    <Button size="sm" variant="ghost" icon={RotateCcw} onClick={startOver} disabled={asking} aria-label="Start over" title="Start over: clear the chat and put the starting query back" />
                  }
                />
                <ChatView
                  className="h-[440px] px-4 pb-4"
                  messages={[greeting, ...chat, ...(pending ? [pending] : [])]}
                  pending={asking}
                  onSend={(text) => ask(text)}
                  disabled={!ready}
                  userName={session?.user?.name}
                  placeholder="Describe what you want to find…"
                  error={chatError}
                  plainText
                  quickReplies={
                    chat.length === 0 && suggestions.length ? (
                      <div className="flex flex-wrap gap-1.5" data-testid="query-suggestions">
                        {suggestions.map((q) => (
                          <button key={q} type="button" onClick={() => void ask(q)} disabled={!ready || asking} className="rounded-full border border-line-strong bg-surface px-2.5 py-1 text-left text-xs hover:border-accent hover:text-accent disabled:opacity-50">
                            {q}
                          </button>
                        ))}
                      </div>
                    ) : null
                  }
                  footer={
                    lastReply?.simulated ? (
                      <p className="mt-1.5 text-xs text-muted" data-testid="query-chat-offline">
                        {OFFLINE_NOTE[lastReply.offlineReason ?? 'unavailable']}
                      </p>
                    ) : null
                  }
                />
              </div>
            </Card>

            <Card className="min-w-0">
              <CardHeader
                title="SPARQL"
                subtitle="The assistant writes here, and you can edit it too: Ctrl/⌘-Space suggests terms, Ctrl/⌘-Enter runs."
                icon={Code2}
                actions={
                  running ? (
                    <Button icon={Square} onClick={() => runnerRef.current?.cancel()} data-testid="query-cancel">
                      Cancel
                    </Button>
                  ) : (
                    <Button variant="primary" icon={Play} onClick={() => void run()} disabled={!ready || !query.trim() || asking}>
                      Run
                    </Button>
                  )
                }
              />
              <div className="space-y-3 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Select
                    value=""
                    onChange={(e) => {
                      const ex = examples.find((x) => x.id === e.target.value);
                      if (ex) {
                        setQuery(ex.query);
                        setColumns([]);
                        if (ex.id === 'instances') setTarget('data');
                      }
                    }}
                    aria-label="Example queries"
                    className="w-auto!"
                    disabled={asking}
                  >
                    <option value="">Examples…</option>
                    {examples.map((x) => (
                      <option key={x.id} value={x.id} title={x.description}>
                        {x.title}
                      </option>
                    ))}
                  </Select>
                  <label className="ml-auto flex items-center gap-2 text-sm">
                    <span className="text-muted">Run against</span>
                    <Select value={target} onChange={(e) => setTarget(e.target.value as Target)} aria-label="Run against" className="w-auto!" disabled={asking}>
                      <option value="ontology">The ontology</option>
                      <option value="data">The ontology + sample data</option>
                    </Select>
                  </label>
                </div>
                {asking && (
                  <p role="status" className="text-xs text-muted" data-testid="editor-locked">
                    The assistant is writing the query, so the editor is locked until it answers.
                  </p>
                )}
                <CodeEditor
                  value={query}
                  onChange={setQuery}
                  language="sparql"
                  readOnly={asking}
                  onRun={() => void run()}
                  completions={sparqlCompletions}
                  ariaLabel="SPARQL query"
                  minHeight={260}
                  maxHeight={420}
                  testId="sparql-editor"
                />
                <p className="text-xs text-muted">Tab moves to the next control. Ctrl/⌘-] and Ctrl/⌘-[ indent.</p>
              </div>
            </Card>
          </div>

          <Card>
            <CardHeader title="Results" icon={Table2} />
            <div className="space-y-3 p-4">
              {target === 'data' && recordTotal !== undefined && (
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted" data-testid="dataset-summary">
                  <Database className="size-3.5" />
                  {recordTotal > 0 ? (
                    <span>
                      Runs over the ontology plus {recordTotal.toLocaleString()} sample {recordTotal === 1 ? 'record' : 'records'}. Records of a class include its subclasses where the query says so (via rdfs:subClassOf only, not full OWL reasoning).
                    </span>
                  ) : (
                    <span>There is no sample data yet, so questions about records will find nothing.</span>
                  )}
                  <button type="button" className="text-accent underline-offset-2 hover:underline" onClick={() => setWorkspace('check')}>
                    {recordTotal > 0 ? 'Edit sample data' : 'Add sample data'}
                  </button>
                </p>
              )}
              {!ready && !loadError && <Loading label="Loading the ontology into sparq…" />}
              {running && (
                <p role="status" className="flex items-center gap-2 text-sm text-muted" data-testid="query-running">
                  <Loader2 className="size-4 animate-spin" aria-hidden /> Running the query…
                  <Button size="sm" variant="ghost" icon={Square} onClick={() => runnerRef.current?.cancel()}>
                    Cancel
                  </Button>
                </p>
              )}
              {queryError ? <InlineError error={queryError} /> : null}
              {awaitingRun && !running && !asking && (
                <p role="status" className="flex flex-wrap items-center gap-2 rounded-md bg-accent-soft px-3 py-2 text-sm" data-testid="query-run-prompt">
                  {result ? 'The assistant changed the query.' : 'The assistant wrote a query.'} Check it in the editor, then run it.
                  <Button size="sm" variant="primary" icon={Play} onClick={() => void run()}>
                    Run this query
                  </Button>
                </p>
              )}
              {resultStale && !running && !awaitingRun && (
                <p role="status" className="flex items-center gap-2 rounded-md bg-warn-soft px-3 py-2 text-sm text-warn" data-testid="result-stale">
                  The question or data changed since this ran.
                  <Button size="sm" icon={Play} onClick={() => void run()} disabled={asking}>
                    Run again
                  </Button>
                </p>
              )}
              {!result && !queryError && ready && !awaitingRun && <p className="text-sm text-muted">Ask for a query, or press Run, and the answer appears here.</p>}
              <div className={cx('space-y-3', resultStale && 'opacity-50')}>
                {result?.kind === 'ask' && (
                  <p className="text-sm" data-testid="query-answer">
                    Answer: <strong>{result.answer ? 'yes' : 'no'}</strong>
                  </p>
                )}
                {result?.kind === 'graph' && (
                  <div className="space-y-1" data-testid="query-graph">
                    <p className="text-xs text-muted">
                      {result.complete ? '' : 'More than '}
                      {result.count.toLocaleString()} triple{result.count === 1 ? '' : 's'}
                      {result.shown < result.count ? ` (showing the first ${result.shown.toLocaleString()})` : ''}
                      {result.cut ? ' · very long values are shortened' : ''}
                      {queryMs !== undefined ? ` · ${queryMs} ms` : ''}
                    </p>
                    <CodeView code={result.text} language="ntriples" ariaLabel="Query result triples" maxHeight={360} />
                  </div>
                )}
                {result?.kind === 'rows' && (
                  <div className="overflow-x-auto rounded-md border border-line" data-testid="query-results">
                    <div className="flex items-center justify-between border-b border-line px-3 py-1.5 text-xs text-muted">
                      <span>
                        {result.total > result.rows.length
                          ? `Showing the first ${result.rows.length.toLocaleString()} of ${result.complete ? '' : 'more than '}${result.total.toLocaleString()} rows`
                          : `${result.rows.length} row${result.rows.length === 1 ? '' : 's'}`}
                        {result.cut ? ' · very long values are shortened' : ''}
                        {queryMs !== undefined ? ` · ${queryMs} ms` : ''}
                      </span>
                      <a href={`data:text/csv;charset=utf-8,${encodeURIComponent(toCsv(result.vars, result.rows, result.headings))}`} download="query-results.csv" className="inline-flex items-center gap-1 hover:text-fg">
                        <Download className="size-3" /> CSV
                      </a>
                    </div>
                    <table className="w-full text-left text-xs">
                      <thead>
                        <tr>
                          {result.vars.map((v, c) => (
                            <th key={c} className={cx('px-3 py-1.5 font-medium', !result.headings?.[c] && 'font-mono text-[var(--syn-variable)]')} title={`?${v}`}>
                              {result.headings?.[c] ?? `?${v}`}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {result.rows.slice(rowPage * ROWS_PER_PAGE, (rowPage + 1) * ROWS_PER_PAGE).map((r, i) => (
                          <tr key={i} className="border-t border-line align-top">
                            {result.vars.map((_, c) => (
                              <td key={c} className="px-3 py-1.5 font-mono" title={r[c] ?? 'No value'}>
                                {r[c] != null ? (
                                  short(r[c], prefixes)
                                ) : (
                                  <span className="text-subtle" aria-label="No value">
                                    —
                                  </span>
                                )}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <Pager page={rowPage} pageSize={ROWS_PER_PAGE} total={result.rows.length} onPage={setRowPage} label="Result pages" />
                    {queryLimit === result.total && !resultStale && (
                      <p role="status" className="flex flex-wrap items-center gap-2 border-t border-line px-3 py-2 text-xs text-warn" data-testid="result-limited">
                        These are the first {result.rows.length.toLocaleString()} rows: the query stops there, so there may be more.
                        <Button
                          size="sm"
                          disabled={asking || running}
                          onClick={() => {
                            const all = withoutLimit(query);
                            setQuery(all);
                            void run({ query: all, target, columns });
                          }}
                        >
                          Show all rows
                        </Button>
                      </p>
                    )}
                  </div>
                )}
              </div>
            </div>
          </Card>
        </div>
      ) : (
        <Card>
          <CardHeader
            title="Check your data"
            subtitle="Validates Turtle instance data against SHACL shapes generated from the ontology. Questions about records run over this data too."
            icon={ShieldCheck}
            actions={
              <Button variant="primary" icon={ShieldCheck} onClick={check} disabled={!ready || !shapes.data}>
                Check
              </Button>
            }
          />
          <div className="space-y-3 p-4">
            <CodeEditor value={data} onChange={setData} language="turtle" completions={turtleCompletions} ariaLabel="Instance data (Turtle)" minHeight={220} maxHeight={420} testId="data-editor" />
            <p className="text-xs text-muted">Tab moves to the next control. Ctrl/⌘-] and Ctrl/⌘-[ indent.</p>
            {checkError ? <InlineError error={checkError} /> : null}
            {reportStale && (
              <p role="status" className="flex items-center gap-2 rounded-md bg-warn-soft px-3 py-2 text-sm text-warn" data-testid="report-stale">
                The data changed since this check.
                <Button size="sm" icon={ShieldCheck} onClick={check}>
                  Check again
                </Button>
              </p>
            )}
            {report && (
              <div className={cx('space-y-2', reportStale && 'opacity-50')} data-testid="shacl-report">
                <p className="text-sm">
                  {report.conforms ? (
                    <Badge tone="ok">Conforms</Badge>
                  ) : (
                    <Badge tone="danger">
                      {report.results.length} problem{report.results.length === 1 ? '' : 's'}
                    </Badge>
                  )}
                </p>
                <ul className="space-y-1 text-sm">
                  {report.results.slice(findingPage * FINDINGS_PER_PAGE, (findingPage + 1) * FINDINGS_PER_PAGE).map((r, i) => (
                    <li key={i} className="rounded-md border border-line px-3 py-2">
                      <span className="font-mono text-xs">{r.focusNode ? short(r.focusNode, prefixes) : ''}</span>
                      {r.path ? <span className="font-mono text-xs text-muted"> · {short(r.path, prefixes)}</span> : null}
                      <div>{r.message}</div>
                    </li>
                  ))}
                </ul>
                <Pager page={findingPage} pageSize={FINDINGS_PER_PAGE} total={report.results.length} onPage={setFindingPage} label="Finding pages" />
              </div>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}
