import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { ChatMessage } from '@concord/shared';
import { ArrowLeft, CircleCheck, Columns2, FileText, Lock, MessageSquareText } from 'lucide-react';
import { api, type InterviewDetail } from '../../api';
import { useAction, useAsync } from '../../lib/hooks';
import { useSession } from '../../lib/session';
import { ChatView } from '../../components/ChatView';
import { CompletenessMeter, UseCaseDocument, sectionLabel, sectionProgress } from '../../components/UseCaseDocument';
import { AnonymisedVersion, VisibilityPicker } from '../../components/UseCaseSharing';
import { Button, Card, ErrorCard, Loading, cx } from '../../components/ui';
import { useOntology } from './Layout';

export function InterviewPage() {
  const { sessionId = '' } = useParams();
  const { id, ontology } = useOntology();
  const { session: auth } = useSession();
  const nav = useNavigate();
  const state = useAsync(() => api.interview(sessionId), [sessionId]);
  const [pending, setPending] = useState(false);
  const [sendError, setSendError] = useState<unknown>();
  const [layout, setLayoutState] = useState<Layout>(readLayout);
  const setLayout = (l: Layout) => {
    setLayoutState(l);
    try {
      localStorage.setItem(LAYOUT_KEY, l);
    } catch {
      /* not remembered */
    }
  };
  // Sections captured since the previous answer, so the conversation view can say what was just recorded.
  const seen = useRef<Set<string> | undefined>(undefined);
  const [justCaptured, setJustCaptured] = useState<string[]>([]);
  const filledKeys = state.data ? Object.entries(state.data.useCase.sections ?? {}).filter(([, v]) => (Array.isArray(v) ? v.length : typeof v === 'string' ? v.trim() : v)).map(([k]) => k) : [];
  const filledSig = filledKeys.join(',');
  useEffect(() => {
    if (!state.data) return;
    const now = new Set(filledKeys);
    if (seen.current) {
      const fresh = [...now].filter((k) => !seen.current!.has(k));
      if (fresh.length) setJustCaptured(fresh);
    }
    seen.current = now;
  }, [filledSig]); // eslint-disable-line react-hooks/exhaustive-deps
  const finish = useAction(async () => {
    await api.finishInterview(sessionId);
    // Reload so the interviewer's closing message and the sharing choices show.
    await state.reload();
  });

  if (state.error && !state.data) return <ErrorCard error={state.error} onRetry={state.reload} />;
  if (!state.data) return <Loading label="Opening interview…" />;
  const s = state.data;
  const lastTargets = [...s.messages].reverse().find((m) => m.role === 'assistant')?.targets ?? [];

  const send = async (content: string) => {
    const optimistic: ChatMessage = { id: `local-${Date.now()}`, role: 'user', content, at: new Date().toISOString() };
    state.setData((prev) => ({ ...(prev as InterviewDetail), messages: [...(prev?.messages ?? []), optimistic] }));
    setPending(true);
    setSendError(undefined);
    try {
      const r = await api.sendInterviewMessage(sessionId, content);
      state.setData({ ...r.session, useCase: r.useCase });
    } catch (e) {
      setSendError(e);
      state.setData((prev) => ({ ...(prev as InterviewDetail), messages: (prev?.messages ?? []).filter((m) => m.id !== optimistic.id) }));
    } finally {
      setPending(false);
    }
  };

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <Link to={`/o/${id}/use-cases`} className="mb-1 inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
            <ArrowLeft className="size-4" /> Use cases
          </Link>
          <h2 className="text-lg font-semibold">{s.useCase.sections.name || 'Describe a use case'}</h2>
          <p className="text-sm text-muted">Talk or type about how you use — or would like to use — {ontology.domain ? `${ontology.domain} data` : 'this data'}. There are no wrong answers.</p>
        </div>
        <Button variant="primary" icon={CircleCheck} loading={finish.pending} onClick={() => (s.done ? nav(`/o/${id}/use-cases/${s.useCaseId}`) : void finish.run())}>
          {s.done ? 'View use case' : 'Finish'}
        </Button>
      </div>
      {finish.error ? <ErrorCard error={finish.error} className="mb-4" /> : null}
      {s.done && (
        <Card className="mb-6 p-5" as="section">
          <h3 className="mb-1 text-base font-semibold">What happens to this use case?</h3>
          <p className="mb-4 text-sm text-muted">
            {s.useCase.visibility === 'private'
              ? 'It is private: only you can see it. You can publish the anonymised version below, share the original, or keep everything private.'
              : s.useCase.visibility === 'group'
                ? 'It is shared with the working group, who will triage it.'
                : 'It is public and will be triaged by the working group.'}
          </p>
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
            <div>
              {s.useCase.visibility === 'private' ? (
                <AnonymisedVersion uc={s.useCase} ontologyId={id} onChange={(u) => state.setData((p) => ({ ...(p as InterviewDetail), useCase: u }))} />
              ) : (
                <Button onClick={() => nav(`/o/${id}/use-cases/${s.useCaseId}`)}>View the use case</Button>
              )}
            </div>
            <VisibilityPicker uc={s.useCase} onChange={(u) => state.setData((p) => ({ ...(p as InterviewDetail), useCase: u }))} />
          </div>
        </Card>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-lg border border-line-strong p-0.5" role="group" aria-label="Interview layout">
          {LAYOUTS.map(({ id: l, label, icon: Icon, wide }) => (
            <button
              key={l}
              aria-pressed={layout === l}
              onClick={() => setLayout(l)}
              className={cx('items-center gap-1.5 rounded-md px-3 py-1 text-sm', wide ? 'hidden lg:inline-flex' : 'inline-flex', layout === l ? 'bg-surface-2 font-medium' : 'text-muted')}
            >
              <Icon className="size-4" /> {label}
            </button>
          ))}
        </div>
      </div>

      {layout === 'chat' && <ProgressStrip s={s} targets={lastTargets as string[]} justCaptured={justCaptured} onView={() => setLayout('doc')} />}

      <div className={cx('grid gap-6', layout === 'split' && 'lg:grid-cols-[minmax(0,1fr)_420px]')}>
        <Card className={cx('flex h-[calc(100vh-15rem)] min-h-[480px] flex-col p-4', layout === 'doc' && 'hidden', layout === 'split' && 'max-lg:hidden')}>
          <ChatView
            className="h-full"
            messages={s.messages}
            pending={pending}
            onSend={(t) => send(t)}
            userName={auth?.user?.name}
            disabled={s.done}
            error={sendError}
            placeholder={s.done ? 'This interview is finished.' : 'Type your answer, or tap the mic and talk…'}
            footer={
              <p className="mt-2 flex items-start gap-1.5 text-xs text-subtle">
                <Lock className="mt-0.5 size-3 shrink-0" />
                <span>
                  This transcript is saved privately to {s.storage.kind === 'solid' ? 'your Solid pod' : 'private storage'}
                  {s.storage.url && (
                    <>
                      {' '}
                      (
                      <a href={s.storage.url} target="_blank" rel="noreferrer" className="break-all underline">
                        {s.storage.url}
                      </a>
                      )
                    </>
                  )}
                  . The use case stays private to you unless you choose to share it.
                </span>
              </p>
            }
          />
        </Card>
        {layout !== 'chat' && (
          <section aria-label="Use case document" className={cx('h-fit', layout === 'split' && 'lg:sticky lg:top-20 lg:self-start')}>
            <Card className={cx('p-5', layout === 'split' && 'lg:max-h-[calc(100vh-7rem)] lg:overflow-y-auto')}>
              <div className="mb-4 flex items-center gap-2 text-sm font-semibold">
                <FileText className="size-4 text-muted" /> Use case document
              </div>
              <div className="mb-5">
                <CompletenessMeter value={s.useCase.completeness} />
                <p className="mt-1.5 text-xs text-muted">Fills in as you talk.</p>
              </div>
              <UseCaseDocument uc={s.useCase} live highlight={lastTargets as string[]} />
            </Card>
          </section>
        )}
      </div>
    </div>
  );
}

type Layout = 'chat' | 'doc' | 'split';
const LAYOUT_KEY = 'concord.interview.layout';
const LAYOUTS: { id: Layout; label: string; icon: typeof FileText; wide?: boolean }[] = [
  { id: 'chat', label: 'Conversation', icon: MessageSquareText },
  { id: 'doc', label: 'View document', icon: FileText },
  { id: 'split', label: 'Side by side', icon: Columns2, wide: true },
];
function readLayout(): Layout {
  try {
    const v = localStorage.getItem(LAYOUT_KEY);
    return v === 'doc' || v === 'split' ? v : 'chat';
  } catch {
    return 'chat';
  }
}

/** Conversation-first summary: how complete the document is, what the interviewer is asking about, and what was just captured. */
function ProgressStrip({ s, targets, justCaptured, onView }: { s: InterviewDetail; targets: string[]; justCaptured: string[]; onView: () => void }) {
  const p = sectionProgress(s.useCase);
  const asking = targets.filter((t) => t !== 'name').map(sectionLabel);
  return (
    <div className="mb-3 grid gap-3 rounded-xl border border-line bg-surface p-3 text-sm sm:grid-cols-[12rem_1fr_auto] sm:items-center" aria-label="Use case progress" role="region">
      <div>
        <CompletenessMeter value={s.useCase.completeness} />
        <p className="mt-1 text-xs text-muted">
          {p.filled} of {p.total} sections filled
        </p>
      </div>
      <div className="min-w-0 space-y-0.5 text-xs">
        {asking.length > 0 && (
          <p>
            <span className="font-medium">Now discussing:</span> {asking.join(', ')}
          </p>
        )}
        {justCaptured.length > 0 && (
          <p className="text-ok">
            <span className="font-medium">Just captured:</span> {justCaptured.map(sectionLabel).join(', ')}
          </p>
        )}
        {p.missing.length > 0 && (
          <p className="truncate text-muted" title={p.missing.join(', ')}>
            <span className="font-medium">Not covered yet:</span> {p.missing.join(', ')}
          </p>
        )}
      </div>
      <Button size="sm" variant="ghost" icon={FileText} onClick={onView}>
        Open document
      </Button>
    </div>
  );
}
