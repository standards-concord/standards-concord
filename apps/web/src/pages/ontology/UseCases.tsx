import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import type { UseCase } from '@concord/shared';
import { USE_CASE_STATUS_INFO, useCaseLabel } from '@concord/shared';
import { ClipboardList, FileText, MessageSquarePlus, Sparkles } from 'lucide-react';
import { api } from '../../api';
import { useAction, useAsync } from '../../lib/hooks';
import { useSession } from '../../lib/session';
import { pct, relativeTime } from '../../lib/format';
import { UseCaseStatusBadge, VisibilityBadge } from '../../components/UseCaseSharing';
import { Badge, Button, Card, Chip, EmptyState, ErrorCard, InlineError, Loading, cx } from '../../components/ui';
import { useOntology } from './Layout';

const SOURCE_LABEL: Record<string, string> = { chat: 'From an interview', meeting: 'From a meeting', agent: 'From an agent', form: 'From a form' };

export function useStartInterview(ontologyId: string) {
  const nav = useNavigate();
  return useAction(async (useCaseId?: string) => {
    const s = await api.startInterview(ontologyId, useCaseId);
    nav(`/o/${ontologyId}/interview/${s.id}`);
  });
}

export function UseCasesTab() {
  const { id, userById } = useOntology();
  const { now, session } = useSession();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const highlight = params.get('start') === '1';
  const list = useAsync(() => api.useCases(id), [id]);
  const docs = useAsync(() => api.requirementsDocs(id), [id]);
  const [filter, setFilter] = useState<Filter>('open');
  const shown = useMemo(() => (list.data ?? []).filter((u) => FILTERS[filter].test(u, session?.user?.id)), [list.data, filter, session?.user?.id]);
  const counts = useMemo(
    () => Object.fromEntries((Object.keys(FILTERS) as Filter[]).map((f) => [f, (list.data ?? []).filter((u) => FILTERS[f].test(u, session?.user?.id)).length])) as Record<Filter, number>,
    [list.data, session?.user?.id],
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Picking use cases to draft changes from is a mode, so the list stays plain the rest of the time.
  // Private use cases are never drafted from directly, so they can't be picked.
  const [selecting, setSelecting] = useState(false);
  // Change requests are public, so only public use cases can be picked.
  const selectable = shown.filter((u) => u.visibility === 'public');
  const start = useStartInterview(id);
  const synth = useAction(async () => {
    const cr = await api.synthesise(id, selected.size ? [...selected] : undefined);
    nav(`/o/${id}/changes/${cr.id}`);
  });
  const toggle = (ucId: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(ucId)) n.delete(ucId);
      else n.add(ucId);
      return n;
    });

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Use cases</h2>
          <p className="max-w-2xl text-sm text-muted">
            Requirements captured with Elisa Kendall’s use case template and competency questions — by interview, from meetings, or from coding agents.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {selecting ? (
            <>
              <Button
                variant="ghost"
                onClick={() => {
                  setSelecting(false);
                  setSelected(new Set());
                }}
              >
                Cancel
              </Button>
              <Button icon={Sparkles} loading={synth.pending} onClick={() => void synth.run()} title="Draft a change request proposing ontology changes from the selected use cases">
                {selected.size ? `Draft changes from ${selected.size} selected` : 'Draft changes from all'}
              </Button>
            </>
          ) : (
            <Button icon={Sparkles} disabled={!list.data?.length} onClick={() => setSelecting(true)} title="Choose use cases and let the platform draft ontology changes from them">
              Draft changes
            </Button>
          )}
          <Button variant="primary" icon={MessageSquarePlus} loading={start.pending} onClick={() => void start.run()} className={cx(highlight && 'ring-4 ring-accent/30')}>
            Describe a use case
          </Button>
        </div>
      </div>
      <InlineError error={start.error || synth.error} />
      {selecting && list.data?.length ? (
        <div className="mb-3 flex flex-wrap items-center gap-3 rounded-lg bg-accent-soft px-4 py-2 text-sm">
          <span>Choose the use cases to draft changes from, or draft from all of them. Change requests are public, so only public use cases can be used.</span>
          <button className="font-medium text-accent hover:underline" onClick={() => setSelected(new Set(selectable.map((u) => u.id)))}>
            Select all
          </button>
          {selected.size > 0 && (
            <button className="font-medium text-accent hover:underline" onClick={() => setSelected(new Set())}>
              Clear
            </button>
          )}
        </div>
      ) : null}
      {!!docs.data?.length && (
        <div className="mb-4 flex flex-wrap items-center gap-2 text-sm" aria-label="Use cases and requirements documents">
          <FileText className="size-4 text-muted" />
          <span className="text-muted">Use cases and requirements:</span>
          {docs.data.map((d) => (
            <Link key={d.id} to={`/o/${id}/requirements/${d.version}`} className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 font-mono text-xs hover:border-accent hover:text-accent">
              v{d.version}
              {d.status === 'draft' && <span className="font-sans text-muted">(draft)</span>}
            </Link>
          ))}
        </div>
      )}
      {!!list.data?.length && (
        <div className="mb-4 flex flex-wrap gap-1.5" role="group" aria-label="Filter use cases">
          {(Object.keys(FILTERS) as Filter[]).map((f) => (
            <Chip key={f} active={filter === f} onClick={() => setFilter(f)}>
              {FILTERS[f].label} <span className="tabular-nums text-muted">{counts[f]}</span>
            </Chip>
          ))}
        </div>
      )}
      {list.error && !list.data ? (
        <ErrorCard error={list.error} onRetry={list.reload} />
      ) : !list.data ? (
        <Loading />
      ) : !list.data.length ? (
        <EmptyState
          icon={ClipboardList}
          title="No use cases yet"
          action={
            <Button variant="primary" icon={MessageSquarePlus} onClick={() => void start.run()} loading={start.pending}>
              Describe a use case
            </Button>
          }
        >
          A friendly AI interviewer will ask how you use (or want to use) this data, and fill in the use case document as you talk.
        </EmptyState>
      ) : (
        <div className="space-y-2">
          {!shown.length && <p className="py-6 text-center text-sm text-muted">Nothing here. Try another filter.</p>}
          {shown.map((uc) => {
            const author = uc.anonymous ? undefined : userById(uc.authorId);
            const isPrivate = uc.visibility === 'private';
            const cqs = uc.competencyQuestions.length;
            return (
              <Card key={uc.id} className={cx('flex items-start gap-3 p-4', selected.has(uc.id) && 'border-accent')}>
                {selecting &&
                  (uc.visibility !== 'public' ? (
                    <span className="mt-1 size-4 shrink-0" title="Change requests are public, so only public use cases can be used. Make it public, or publish an anonymised version of a private one." />
                  ) : (
                    <input type="checkbox" className="mt-1 size-4 accent-[var(--accent)]" checked={selected.has(uc.id)} onChange={() => toggle(uc.id)} aria-label={`Select ${useCaseLabel(uc.number)} ${uc.sections.name || 'use case'}`} />
                  ))}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs text-muted">{useCaseLabel(uc.number)}</span>
                    <Link to={`/o/${id}/use-cases/${uc.id}`} className="font-medium hover:text-accent">
                      {uc.sections.name || 'Untitled use case'}
                    </Link>
                    <UseCaseStatusBadge status={uc.status} version={uc.resolution?.version} />
                    <VisibilityBadge visibility={uc.visibility} anonymous={uc.anonymous} />
                    {isPrivate && uc.anonymisation?.status === 'proposed' && <Badge tone="warn">Anonymised version waiting for you</Badge>}
                  </div>
                  {uc.sections.goal && <p className="mt-1 line-clamp-1 text-sm text-muted">{uc.sections.goal}</p>}
                  <p className="mt-1 text-xs text-subtle">
                    {SOURCE_LABEL[uc.source] ?? uc.source} · {pct(uc.completeness)} complete · {cqs} competency question{cqs === 1 ? '' : 's'} · {uc.terms.length} terms · {uc.anonymous ? 'Anonymous' : (author?.name ?? 'Someone')} · updated {relativeTime(uc.updatedAt, now())}
                  </p>
                </div>
                {uc.status === 'draft' && uc.source === 'chat' && uc.authorId === session?.user?.id && (
                  <Button size="sm" variant="ghost" onClick={() => void start.run(uc.id)}>
                    Continue
                  </Button>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

type Filter = 'open' | 'triage' | 'closed' | 'mine' | 'all';
const FILTERS: Record<Filter, { label: string; test: (u: UseCase, me?: string) => boolean }> = {
  open: { label: 'Open', test: (u) => USE_CASE_STATUS_INFO[u.status]?.open && u.status !== 'archived' },
  triage: { label: 'Needs triage', test: (u) => u.status === 'triage' },
  closed: { label: 'Closed', test: (u) => !USE_CASE_STATUS_INFO[u.status]?.open },
  mine: { label: 'Mine', test: (u, me) => !!me && u.authorId === me },
  all: { label: 'All', test: () => true },
};
