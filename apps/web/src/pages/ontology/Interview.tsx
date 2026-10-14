import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { ChatMessage } from '@concord/shared';
import { ArrowLeft, CircleCheck, FileText, Lock, MessageSquareText } from 'lucide-react';
import { api, type InterviewDetail } from '../../api';
import { useAction, useAsync } from '../../lib/hooks';
import { useSession } from '../../lib/session';
import { ChatView } from '../../components/ChatView';
import { CompletenessMeter, UseCaseDocument } from '../../components/UseCaseDocument';
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
  const [panel, setPanel] = useState<'chat' | 'doc'>('chat');
  const finish = useAction(async () => {
    const { useCase } = await api.finishInterview(sessionId);
    nav(`/o/${id}/use-cases/${useCase.id}`);
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
          {s.done ? 'Done — view use case' : 'Finish'}
        </Button>
      </div>
      {finish.error ? <ErrorCard error={finish.error} className="mb-4" /> : null}

      <div className="mb-3 inline-flex rounded-lg border border-line-strong p-0.5 lg:hidden">
        <button onClick={() => setPanel('chat')} className={cx('inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-sm', panel === 'chat' ? 'bg-surface-2 font-medium' : 'text-muted')}>
          <MessageSquareText className="size-4" /> Conversation
        </button>
        <button onClick={() => setPanel('doc')} className={cx('inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-sm', panel === 'doc' ? 'bg-surface-2 font-medium' : 'text-muted')}>
          <FileText className="size-4" /> Use case document
        </button>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_420px]">
        <Card className={cx('flex h-[calc(100vh-15rem)] min-h-[480px] flex-col p-4', panel !== 'chat' && 'hidden lg:flex')}>
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
                  . Only the use case document is shared with the group.
                </span>
              </p>
            }
          />
        </Card>
        <Card className={cx('h-fit p-5 lg:sticky lg:top-20 lg:max-h-[calc(100vh-7rem)] lg:overflow-y-auto', panel !== 'doc' && 'hidden lg:block')}>
          <div className="mb-4 flex items-center gap-2 text-sm font-semibold">
            <FileText className="size-4 text-muted" /> Use case document
          </div>
          <div className="mb-5">
            <CompletenessMeter value={s.useCase.completeness} />
            <p className="mt-1.5 text-xs text-muted">Fills in as you talk, following Elisa Kendall’s use case template.</p>
          </div>
          <UseCaseDocument uc={s.useCase} live highlight={lastTargets as string[]} />
        </Card>
      </div>
    </div>
  );
}
