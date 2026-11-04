import { Link, useNavigate, useParams } from 'react-router';
import { ArrowLeft, Archive, CircleCheck, Lock, MessageSquareText, GitPullRequestDraft } from 'lucide-react';
import { api } from '../../api';
import { useAction, useAsync } from '../../lib/hooks';
import { formatDate, titleCase } from '../../lib/format';
import { SourceBadge } from '../../components/badges';
import { CompletenessMeter, UseCaseDocument } from '../../components/UseCaseDocument';
import { Badge, Button, Card, ErrorCard, InlineError, Loading } from '../../components/ui';
import { useOntology } from './Layout';
import { useStartInterview } from './UseCases';

export function UseCaseDetailPage() {
  const { useCaseId = '' } = useParams();
  const { id, userById } = useOntology();
  const nav = useNavigate();
  const uc = useAsync(() => api.useCase(useCaseId), [useCaseId]);
  const start = useStartInterview(id);
  const setStatus = useAction(async (status: 'ready' | 'archived') => uc.setData(await api.updateUseCase(useCaseId, { status })));
  const synth = useAction(async () => {
    const cr = await api.synthesise(id, [useCaseId]);
    nav(`/o/${id}/changes/${cr.id}`);
  });

  if (uc.error && !uc.data) return <ErrorCard error={uc.error} onRetry={uc.reload} />;
  if (!uc.data) return <Loading />;
  const u = uc.data;
  const author = userById(u.authorId);
  const canContinue = u.source === 'chat' && u.status === 'eliciting';
  const canMarkReady = u.status !== 'ready' && u.status !== 'synthesised';

  return (
    <div>
      <Link to={`/o/${id}/use-cases`} className="mb-4 inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
        <ArrowLeft className="size-4" /> All use cases
      </Link>
      <div className="grid gap-6 lg:grid-cols-[1fr_300px]">
        <Card className="p-6">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <SourceBadge source={u.source} />
            <Badge tone={u.status === 'ready' ? 'ok' : 'neutral'}>{titleCase(u.status)}</Badge>
          </div>
          <h2 className="text-xl font-semibold">{u.sections.name || 'Untitled use case'}</h2>
          <p className="mt-1 mb-6 text-xs text-muted">
            {author?.name ?? 'Unknown author'} · started {formatDate(u.createdAt)} · updated {formatDate(u.updatedAt)}
          </p>
          <UseCaseDocument uc={u} collapsible />
        </Card>
        <div className="space-y-4">
          <Card className="space-y-4 p-5">
            <CompletenessMeter value={u.completeness} />
            <div className="flex flex-col gap-2">
              {/* The main action depends on where the use case is: finish it, mark it ready, then draft changes. */}
              {canContinue && (
                <Button variant="primary" icon={MessageSquareText} loading={start.pending} onClick={() => void start.run(u.id)}>
                  Continue the interview
                </Button>
              )}
              {canMarkReady && (
                <Button variant={canContinue ? 'secondary' : 'primary'} icon={CircleCheck} loading={setStatus.pending} onClick={() => void setStatus.run('ready')}>
                  Mark as ready
                </Button>
              )}
              <Button variant={canContinue || canMarkReady ? 'secondary' : 'primary'} icon={GitPullRequestDraft} loading={synth.pending} onClick={() => void synth.run()}>
                Draft changes
              </Button>
              {u.status !== 'archived' && (
                <Button variant="ghost" icon={Archive} disabled={setStatus.pending} onClick={() => void setStatus.run('archived')}>
                  Archive
                </Button>
              )}
            </div>
            <InlineError error={synth.error || start.error || setStatus.error} />
          </Card>
          {u.transcriptUrl && (
            <Card className="p-4 text-xs text-muted">
              <div className="mb-1 flex items-center gap-1.5 font-medium text-fg">
                <Lock className="size-3.5" /> Private transcript
              </div>
              The interview transcript is stored in the author’s Solid pod, not on the platform:{' '}
              <a href={u.transcriptUrl} target="_blank" rel="noreferrer" className="break-all text-accent hover:underline">
                {u.transcriptUrl}
              </a>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
