import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { ClipboardList, MessageSquarePlus, GitPullRequestDraft } from 'lucide-react';
import { api } from '../../api';
import { useAction, useAsync } from '../../lib/hooks';
import { useSession } from '../../lib/session';
import { pct, relativeTime, titleCase } from '../../lib/format';
import { Badge, Button, Card, EmptyState, ErrorCard, InlineError, Loading, cx } from '../../components/ui';

const SOURCE_LABEL: Record<string, string> = { chat: 'From an interview', meeting: 'From a meeting', agent: 'From an agent', form: 'From a form' };
import { useOntology } from './Layout';

export function useStartInterview(ontologyId: string) {
  const nav = useNavigate();
  return useAction(async (useCaseId?: string) => {
    const s = await api.startInterview(ontologyId, useCaseId);
    nav(`/o/${ontologyId}/interview/${s.id}`);
  });
}

export function UseCasesTab() {
  const { id, userById } = useOntology();
  const { now } = useSession();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const highlight = params.get('start') === '1';
  const list = useAsync(() => api.useCases(id), [id]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Picking use cases to draft changes from is a mode, so the list stays plain the rest of the time.
  const [selecting, setSelecting] = useState(false);
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
              <Button icon={GitPullRequestDraft} loading={synth.pending} onClick={() => void synth.run()} title="Draft a change request proposing ontology changes from the selected use cases">
                {selected.size ? `Draft changes from ${selected.size} selected` : 'Draft changes from all'}
              </Button>
            </>
          ) : (
            <Button icon={GitPullRequestDraft} disabled={!list.data?.length} onClick={() => setSelecting(true)} title="Choose use cases and let the platform draft ontology changes from them">
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
          <span>Choose the use cases to draft changes from, or draft from all of them.</span>
          <button className="font-medium text-accent hover:underline" onClick={() => setSelected(new Set(list.data!.map((u) => u.id)))}>
            Select all
          </button>
          {selected.size > 0 && (
            <button className="font-medium text-accent hover:underline" onClick={() => setSelected(new Set())}>
              Clear
            </button>
          )}
        </div>
      ) : null}
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
          {list.data.map((uc) => {
            const author = userById(uc.authorId);
            const cqs = uc.competencyQuestions.length;
            return (
              <Card key={uc.id} className={cx('flex items-start gap-3 p-4', selected.has(uc.id) && 'border-accent')}>
                {selecting && (
                  <input type="checkbox" className="mt-1 size-4 accent-[var(--accent)]" checked={selected.has(uc.id)} onChange={() => toggle(uc.id)} aria-label={`Select ${uc.sections.name || 'use case'}`} />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link to={`/o/${id}/use-cases/${uc.id}`} className="font-medium hover:text-accent">
                      {uc.sections.name || 'Untitled use case'}
                    </Link>
                    <Badge tone={uc.status === 'ready' ? 'ok' : uc.status === 'synthesised' ? 'accent' : 'neutral'}>{titleCase(uc.status)}</Badge>
                    <span className="text-xs text-subtle">updated {relativeTime(uc.updatedAt, now())}</span>
                  </div>
                  {uc.sections.goal && <p className="mt-1 line-clamp-1 text-sm text-muted">{uc.sections.goal}</p>}
                  <p className="mt-1 text-xs text-subtle">
                    {SOURCE_LABEL[uc.source] ?? uc.source} · {pct(uc.completeness)} complete · {cqs} competency question{cqs === 1 ? '' : 's'} · {uc.terms.length} terms · {author?.name ?? 'Someone'}
                  </p>
                </div>
                {uc.status === 'eliciting' && uc.source === 'chat' && (
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
