import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { ChevronLeft, ChevronRight, Code2, Cpu, Database, Download, Keyboard, Loader2, Play, RotateCcw, Sparkles, Square, Table2 } from 'lucide-react';
import type { SparqStore } from '@sparq-org/sparq';
import type { ChatMessage, QueryChatResponse, QueryTarget } from '@concord/shared';
import { api } from '../../api';
import { useAsync, useLocalStorage } from '../../lib/hooks';
import { makeLabeler } from '../../lib/ontology';
import { hasSampleRecords, useSampleData } from '../../lib/sampleData';
import { termCompletions } from '../../lib/termCompletions';
import { toCsv } from '../../lib/csv';
import { queryForm, sparqlExamples } from '../../lib/sparql-examples';
import { QueryRunner, QueryStopped, type RunResult } from '../../lib/queryRunner';
import { limitOf, withoutLimit } from '../../lib/sparqlLimit';
import { Button, Card, CardHeader, ErrorCard, InlineError, Loading, cx } from '../../components/ui';
import { Popover } from '../../components/Disclosure';
import { CodeEditor } from '../../components/code/CodeEditor';
import { CodeView } from '../../components/code/CodeView';
import { ChatView } from '../../components/ChatView';
import { accountToken, stillCurrent, useSession } from '../../lib/session';
import { useOntology } from './Layout';

/**
 * Query the ontology and its sample data in the browser, using the sparq
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

/** The Query page's keyboard shortcuts, in the Keyboard shortcuts pop-up rather than under each box. */
const KEYS: [string, string][] = [
  ['Ctrl/⌘-Space', 'Suggest terms in the query'],
  ['Ctrl/⌘-Enter', 'Run the query'],
  ['Ctrl/⌘-] and Ctrl/⌘-[', 'Indent and outdent'],
  ['Tab', 'Move to the next control'],
  ['Enter', 'Send your message to the assistant'],
  ['Shift+Enter', 'Start a new line in your message'],
];
type Columns = { variable: string; label: string }[];

function short(v: string, prefixes: Record<string, string>) {
  for (const [p, ns] of Object.entries(prefixes)) if (v.startsWith(ns)) return `${p}:${v.slice(ns.length)}`;
  return v;
}


const ROWS_PER_PAGE = 50;

const OFFLINE_NOTE: Record<NonNullable<QueryChatResponse['offlineReason']>, string> = {
  unavailable: 'Offline helper: Claude isn’t connected right now, so this matches your words to the ontology’s terms and refines its own queries step by step.',
  'not-member': 'Offline helper: Claude writes queries for members of this ontology. This helper matches your words to the ontology’s terms instead.',
  limit: 'Offline helper: the assistant has reached today’s usage limit, so this matches your words to the ontology’s terms instead.',
};


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
    /* Unparseable data counts as no records; Validate data reports the error. */
  }
  return { byClass: counts, total };
}

function QueryWorkspace({ storageKey, account }: { storageKey: string; account: string }) {
  const { id, ontology } = useOntology();
  const { session, setSession } = useSession();
  const [rowPage, setRowPage] = useState(0);

  const turtle = useAsync(() => api.source(id, 'turtle'), [id]);
  const view = useAsync(() => api.view(id), [id]);
  // The ontology store on this thread loads the ontology (the "Ontology loaded" status).
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
  const [result, setResultState] = useState<Result | null>(null);
  const [queryError, setQueryError] = useState<unknown>();
  // The sample data is edited and checked on Validate data; queries can run over it.
  const [data] = useSampleData(id, ontology);
  // Queries run over the sample data whenever there is some, so there is no choice to make.
  const target: Target = hasSampleRecords(data) ? 'data' : 'ontology';

  const setResult = (r: Result | null) => {
    setResultState(r);
    setRowPage(0);
  };
  const label = useMemo(() => makeLabeler(view.data), [view.data]);
  const prefixes = useMemo(() => view.data?.prefixes ?? { [ontology.prefix]: ontology.namespace }, [view.data, ontology.prefix, ontology.namespace]);

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
  // The messages being sent, before they are saved.
  const [pending, setPending] = useState<ChatMessage[]>([]);
  // Messages that failed before they could be saved (the account check couldn't be made): shown, and sent with
  // the next message or by Send again. They stay in this page only, since nobody confirmed whose they are.
  const [unsent, setUnsent] = useState<ChatMessage[]>([]);
  const [chatError, setChatError] = useState<unknown>();

  // Autocomplete for the ontology's terms, findable by their labels too.
  const sparqlCompletions = useMemo(() => termCompletions(view.data, 'sparql'), [view.data]);

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
  // The query the assistant last wrote, waiting for the person to read it and press Run.
  const [wroteKey, setWroteKey] = useState<string>();
  const awaitingRun = wroteKey === questionKey && ranKey !== questionKey;
  const resultStale = !!result && ranKey !== questionKey;
  const queryLimit = useMemo(() => limitOf(query), [query]);

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
      const { result: r } = await runner().run({ source: t === 'data' ? `${turtle.data}\n${data}` : turtle.data, query: q, form: queryForm(q) });
      if (r.kind === 'rows') {
        // The assistant's readable headings, for the columns this query still has.
        const headings = r.vars.map((v) => cols.find((c) => c.variable === v)?.label);
        setResult({ ...r, headings: headings.some((h) => h !== undefined) ? headings : undefined });
      } else setResult(r);
    } catch (e) {
      // A newer run replaced this one: that run reports its own outcome.
      if (e instanceof QueryStopped && e.reason === 'cancelled' && runnerRef.current?.running) return;
      setQueryError(e);
      setResult(null);
    } finally {
      if (!runnerRef.current?.running) setRunning(false);
    }
  };

  /**
   * Asks the assistant: sends any unsent messages, then text if given. Each is its own turn, in order, building on
   * the query the one before it wrote (sent together, only the last would have been acted on).
   */
  const ask = async (text?: string) => {
    const queue = [...unsent, ...(text ? [{ id: `m${Date.now()}`, role: 'user', content: text, at: new Date().toISOString() } satisfies ChatMessage] : [])];
    if (!queue.length) return;
    // Whose conversation this is, as of now: nothing is saved unless it still is, now and when each answer arrives.
    const token = accountToken();
    if (!stillCurrent(token, account)) return;
    setUnsent([]);
    setAsking(true);
    setChatError(undefined);
    let history = chat;
    let current = { query, target, offlineState };
    // How many of the queue have been answered and saved, and whether the account changed (then nothing more is kept).
    let kept = 0;
    let otherAccount = false;
    try {
      for (const mine of queue) {
        // Shown at once, but saved only after the server confirms the account.
        setPending(queue.slice(kept));
        // This conversation belongs to one account: never send it on under another one signed in from another tab.
        // The server refuses it too if the session changes after this check.
        const now = await api.session();
        if ((now.user?.id ?? 'guest') !== account || !stillCurrent(token, account)) {
          otherAccount = true;
          if (stillCurrent(token, account)) setSession(now);
          throw new Error('You’re signed in as someone else now (perhaps in another tab), so this conversation wasn’t sent.');
        }
        const asked = [...history, mine];
        const r = await api.queryChat(id, {
          messages: asked.filter((m) => m.role !== 'system').map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
          query: current.query,
          target: current.target,
          dataSummary: recordCounts ? [...recordCounts.byClass].map(([classIri, count]) => ({ classIri, count })) : undefined,
          offlineState: current.offlineState ?? undefined,
          account,
        });
        // Signed out (in this tab or another), or into another account, while waiting: this answer belongs to nobody here now.
        if (!stillCurrent(token, account)) return;
        // Saved with its answer, so one that fails stays unsent, to send again.
        kept++;
        history = [...asked, { id: `m${Date.now()}a`, role: 'assistant', content: r.reply, at: new Date().toISOString(), simulated: r.simulated, offlineReason: r.offlineReason }];
        setChat(history);
        // The editor is read-only while the assistant works, so its answer never replaces newer edits.
        // It isn't run until the person has looked at it and pressed Run.
        if (!r.unchanged) {
          current = { query: r.query, target: current.target, offlineState: r.offlineState ?? null };
          setOfflineState(r.offlineState ?? null);
          setQuery(r.query);
          setColumns(r.columns);
          setWroteKey(keyFor(r.query, current.target));
        }
      }
    } catch (e) {
      if (!stillCurrent(token, account)) return;
      setChatError(e);
      // Messages not yet answered (the account check couldn't be made, or the assistant failed) are kept to send
      // again, rather than lost. Not when the account has changed: they belong to someone else.
      if (!otherAccount) setUnsent(queue.slice(kept));
    } finally {
      setPending([]);
      setAsking(false);
    }
  };

  /** The refresh button: clears the conversation and puts the starting query back. */
  const startOver = () => {
    runnerRef.current?.cancel();
    setChat([]);
    setUnsent([]);
    setColumns([]);
    setOfflineState(null);
    setChatError(undefined);
    setQuery(examples[0].query);
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

  if (turtle.error) return <ErrorCard error={turtle.error} onRetry={turtle.reload} />;
  return (
    <div className="space-y-4">
      <p className="flex flex-wrap items-center gap-2 text-sm text-muted">
        <Cpu className="size-4" />
        Queries run in your browser, so your sample data never leaves this page. The assistant sees your messages, the query and the ontology.
        {/* How many triples loaded, and how fast, is under-the-hood detail: it is only announced to screen readers. */}
        {ready && (
          <span role="status" className="sr-only" data-testid="sparq-ready" data-triples={ready.triples}>
            Ontology loaded
          </span>
        )}
      </p>
      {loadError ? <InlineError error={loadError} /> : null}

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
                messages={[greeting, ...chat, ...pending, ...unsent]}
                pending={asking}
                onSend={(text) => ask(text)}
                notice={
                  unsent.length && !asking ? (
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted" data-testid="query-unsent">
                      <span>{unsent.length === 1 ? 'Your last message wasn’t sent.' : `Your last ${unsent.length} messages weren’t sent.`}</span>
                      <Button size="sm" variant="secondary" onClick={() => void ask()} disabled={!ready}>
                        Send again
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setUnsent([])}>
                        Discard
                      </Button>
                    </div>
                  ) : null
                }
                disabled={!ready}
                userName={session?.user?.name}
                placeholder="Describe what you want to find…"
                error={chatError}
                plainText
                keyHint={false}
                quickReplies={
                  chat.length === 0 && !unsent.length && suggestions.length ? (
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
              subtitle="The assistant writes here, and you can edit it too."
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
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
                {/* Kept in view: people using a keyboard need to know Tab leaves the editor. */}
                <p>Tab moves to the next control.</p>
                <Popover
                  label="Keyboard shortcuts"
                  align="right"
                  className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted hover:text-fg"
                  trigger={
                    <>
                      <Keyboard className="size-3.5" aria-hidden /> Keyboard shortcuts
                    </>
                  }
                >
                  <h4 className="mb-2 text-sm font-semibold">Keyboard shortcuts</h4>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">
                    {KEYS.map(([k, what]) => (
                      <Fragment key={k}>
                        <dt>
                          <kbd className="rounded border border-line bg-surface-2 px-1 font-mono">{k}</kbd>
                        </dt>
                        <dd className="text-muted">{what}</dd>
                      </Fragment>
                    ))}
                  </dl>
                </Popover>
              </div>
            </div>
          </Card>
        </div>

        <Card>
          <CardHeader title="Results" icon={Table2} />
          <div className="space-y-3 p-4">
            {recordTotal !== undefined && (
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted" data-testid="dataset-summary">
                <Database className="size-3.5" />
                {recordTotal > 0 ? (
                  <span>
                    Runs over the ontology plus {recordTotal.toLocaleString()} sample {recordTotal === 1 ? 'record' : 'records'}. Records of a class include its subclasses where the query says so (via rdfs:subClassOf only, not full OWL reasoning).
                  </span>
                ) : (
                  <span>There is no sample data yet, so questions about records will find nothing.</span>
                )}
                <Link to="../validate" relative="path" className="text-accent underline-offset-2 hover:underline">
                  {recordTotal > 0 ? 'Edit sample data' : 'Add sample data'}
                </Link>
              </p>
            )}
            {!ready && !loadError && <Loading label="Loading the ontology…" />}
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
    </div>
  );
}
