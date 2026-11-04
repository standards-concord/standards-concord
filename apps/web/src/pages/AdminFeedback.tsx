import { Fragment, useMemo, useState } from 'react';
import type { FeedbackQuestion, FeedbackSubmission } from '@concord/shared';
import { Download, Mic, ListChecks } from 'lucide-react';
import { api } from '../api';
import { useAction, useAsync } from '../lib/hooks';
import { download, formatDate } from '../lib/format';
import { Page } from '../components/Shell';
import { Markdown } from '../components/Markdown';
import { Badge, Button, Card, CardHeader, EmptyState, ErrorCard, InlineError, Loading, PageHeader, cx } from '../components/ui';

function answerText(v: FeedbackSubmission['answers'][string] | undefined) {
  if (v === undefined) return '';
  return Array.isArray(v) ? v.join('; ') : String(v);
}

/** Single-series horizontal bars: one hue, counts as direct labels, hover title per bar. */
function Distribution({ q, subs }: { q: FeedbackQuestion; subs: FeedbackSubmission[] }) {
  const buckets = useMemo(() => {
    const keys: string[] =
      q.type === 'scale' ? Array.from({ length: (q.max ?? 5) - (q.min ?? 1) + 1 }, (_, i) => String((q.min ?? 1) + i)) : [...(q.options ?? [])];
    const counts = new Map(keys.map((k) => [k, 0]));
    let n = 0;
    let sum = 0;
    for (const s of subs) {
      const v = s.answers[q.id];
      if (v === undefined || v === '') continue;
      const vals = Array.isArray(v) ? v : [String(v)];
      n++;
      if (q.type === 'scale' && !Number.isNaN(Number(v))) sum += Number(v);
      for (const x of vals) counts.set(x, (counts.get(x) ?? 0) + 1);
    }
    return { rows: [...counts.entries()], n, mean: q.type === 'scale' && n ? sum / n : undefined };
  }, [q, subs]);
  const max = Math.max(1, ...buckets.rows.map(([, c]) => c));
  return (
    <div className="rounded-lg border border-line p-4">
      <div className="text-sm font-medium">{q.text}</div>
      <div className="mt-0.5 mb-3 text-xs text-muted">
        {q.section} · {buckets.n} response{buckets.n === 1 ? '' : 's'}
        {buckets.mean !== undefined && ` · mean ${buckets.mean.toFixed(1)}`}
      </div>
      <div className="space-y-1.5">
        {buckets.rows.map(([k, c]) => (
          <div key={k} className="group grid grid-cols-[minmax(0,9rem)_1fr_2rem] items-center gap-2 text-xs" title={`${k}: ${c} of ${buckets.n}`}>
            <span className="truncate text-muted">
              {k}
              {q.type === 'scale' && k === String(q.min ?? 1) && q.minLabel ? ` (${q.minLabel})` : ''}
              {q.type === 'scale' && k === String(q.max ?? 5) && q.maxLabel ? ` (${q.maxLabel})` : ''}
            </span>
            <div className="h-3">
              <div className={cx('h-full rounded-r bg-accent transition-opacity group-hover:opacity-80', !c && 'opacity-0')} style={{ width: `${(c / max) * 100}%`, minWidth: c ? 3 : 0 }} />
            </div>
            <span className="text-right tabular-nums">{c}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function toCsv(subs: FeedbackSubmission[], qs: FeedbackQuestion[]) {
  const qIds = [...new Set([...qs.map((q) => q.id), ...subs.flatMap((s) => Object.keys(s.answers))])];
  const head = ['id', 'createdAt', 'appVersion', 'sinceVersion', 'pathway', 'name', 'email', 'role', 'usedVoice', 'themes', ...qIds];
  const esc = (v: unknown) => {
    const s = v === undefined || v === null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = subs.map((s) => [s.id, s.createdAt, s.appVersion, s.sinceVersion, s.pathway, s.name, s.email, s.role, s.usedVoice, (s.themes ?? []).join('; '), ...qIds.map((q) => answerText(s.answers[q]))].map(esc).join(','));
  return [head.join(','), ...rows].join('\n');
}

export function AdminFeedbackPage() {
  const subs = useAsync(() => api.feedback(), []);
  const qs = useAsync(() => api.feedbackQuestions(), []);
  const [summary, setSummary] = useState<{ summary: string; themes: { theme: string; count: number }[] }>();
  const [openId, setOpenId] = useState<string>();
  const sum = useAction(async () => setSummary(await api.feedbackSummary()));

  if (subs.error && !subs.data) return <Page><ErrorCard error={subs.error} onRetry={subs.reload} /></Page>;
  if (!subs.data) return <Page><Loading /></Page>;
  const data = [...subs.data].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const questions = qs.data ?? [];
  const chartable = questions.filter((q) => q.type === 'scale' || q.type === 'choice' || q.type === 'multi');
  const qText = (id: string) => questions.find((q) => q.id === id)?.text ?? id;

  return (
    <Page wide>
      <PageHeader
        eyebrow="Admin"
        title="Alpha feedback"
        subtitle={`${data.length} submission${data.length === 1 ? '' : 's'} · ${data.filter((d) => d.usedVoice).length} used voice`}
        actions={
          <>
            <Button icon={ListChecks} loading={sum.pending} onClick={() => void sum.run()} disabled={!data.length}>
              AI summary
            </Button>
            <Button icon={Download} disabled={!data.length} onClick={() => download('concord-feedback.json', JSON.stringify(data, null, 2), 'application/json')}>
              JSON
            </Button>
            <Button icon={Download} disabled={!data.length} onClick={() => download('concord-feedback.csv', toCsv(data, questions), 'text/csv')}>
              CSV
            </Button>
          </>
        }
      />
      <InlineError error={sum.error} />
      {summary && (
        <Card className="mb-6">
          <CardHeader icon={ListChecks} title="Summary" />
          <div className="space-y-4 p-5">
            <Markdown text={summary.summary} />
            {summary.themes.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {summary.themes
                  .sort((a, b) => b.count - a.count)
                  .map((t) => (
                    <Badge key={t.theme} tone="accent">
                      {t.theme} · {t.count}
                    </Badge>
                  ))}
              </div>
            )}
          </div>
        </Card>
      )}
      {!data.length ? (
        <EmptyState title="No feedback yet">Submissions from /feedback will appear here.</EmptyState>
      ) : (
        <>
          {chartable.length > 0 && (
            <div className="mb-8">
              <h2 className="mb-3 text-sm font-semibold">Responses by question</h2>
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {chartable.map((q) => (
                  <Distribution key={q.id} q={q} subs={data.filter((d) => d.pathway === 'structured' || d.answers[q.id] !== undefined)} />
                ))}
              </div>
            </div>
          )}
          <h2 className="mb-3 text-sm font-semibold">Submissions</h2>
          <Card className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs text-muted">
                  <th className="px-4 py-2.5 font-medium">When</th>
                  <th className="px-4 py-2.5 font-medium">Who</th>
                  <th className="px-4 py-2.5 font-medium">Pathway</th>
                  <th className="px-4 py-2.5 font-medium">Answers</th>
                  <th className="px-4 py-2.5 font-medium">Themes</th>
                </tr>
              </thead>
              <tbody>
                {data.map((s) => (
                  <Fragment key={s.id}>
                    <tr className="cursor-pointer border-b border-line align-top hover:bg-surface-2" onClick={() => setOpenId(openId === s.id ? undefined : s.id)}>
                      <td className="px-4 py-2.5 whitespace-nowrap">
                        {formatDate(s.createdAt, true)}
                        {s.appVersion && (
                          <span className="block text-xs text-muted">
                            Version {s.appVersion}
                            {s.sinceVersion && ` (last tested ${s.sinceVersion})`}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        {s.name || <span className="text-muted">Anonymous</span>}
                        {s.role && <span className="block text-xs text-muted">{s.role}</span>}
                      </td>
                      <td className="px-4 py-2.5">
                        <span className="inline-flex items-center gap-1">
                          {s.pathway === 'structured' ? 'Guided' : s.pathway === 'changes' ? 'What’s changed' : 'General'}
                          {s.usedVoice && <Mic className="size-3.5 text-muted" aria-label="Used voice" />}
                        </span>
                      </td>
                      <td className="px-4 py-2.5">{Object.keys(s.answers).length}</td>
                      <td className="px-4 py-2.5">
                        <div className="flex flex-wrap gap-1">
                          {(s.themes ?? []).map((t) => (
                            <Badge key={t}>{t}</Badge>
                          ))}
                        </div>
                      </td>
                    </tr>
                    {openId === s.id && (
                      <tr className="border-b border-line bg-surface-2/40">
                        <td colSpan={5} className="px-4 py-4">
                          <dl className="grid gap-x-6 gap-y-2 md:grid-cols-2">
                            {Object.entries(s.answers).map(([k, v]) => (
                              <div key={k}>
                                <dt className="text-xs text-muted">{qText(k)}</dt>
                                <dd className="text-sm">{answerText(v) || '—'}</dd>
                              </div>
                            ))}
                          </dl>
                          {s.email && <p className="mt-3 text-xs text-muted">Contact: {s.email}</p>}
                          <details className="mt-3">
                            <summary className="cursor-pointer text-xs text-accent">Conversation ({s.transcript.length} messages)</summary>
                            <div className="mt-2 space-y-1.5 text-xs">
                              {s.transcript.map((m) => (
                                <p key={m.id}>
                                  <strong className="font-medium">{m.role === 'user' ? 'Tester' : 'Assistant'}:</strong> {m.content}
                                </p>
                              ))}
                            </div>
                          </details>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}
    </Page>
  );
}
