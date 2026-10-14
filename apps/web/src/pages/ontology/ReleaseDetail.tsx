import { Link, useParams } from 'react-router';
import type { ReleaseDetail } from '@concord/shared';
import { ArrowLeft, ExternalLink, Minus, Rocket, Scale, ThumbsDown, ThumbsUp } from 'lucide-react';
import { api, type VoteChoice } from '../../api';
import { useAction, useAsync } from '../../lib/hooks';
import { useSession } from '../../lib/session';
import { formatDate, roleLabel } from '../../lib/format';
import { GitHubIcon, LevelBadge } from '../../components/badges';
import { GovernancePanel } from '../../components/GovernancePanel';
import { Markdown } from '../../components/Markdown';
import { Button, Card, CardHeader, CopyButton, ErrorCard, InlineError, Loading } from '../../components/ui';
import { useOntology } from './Layout';
import { ReleaseStatus } from './Releases';

export function ReleaseDetailPage() {
  const { releaseId = '' } = useParams();
  const { id, userById, hasRole, myRoles, reload } = useOntology();
  const { session } = useSession();
  const state = useAsync(() => api.release(releaseId), [releaseId]);
  const act = useAction(async (fn: () => Promise<ReleaseDetail>) => {
    state.setData(await fn());
    void reload();
  });
  if (state.error && !state.data) return <ErrorCard error={state.error} onRetry={state.reload} />;
  if (!state.data) return <Loading />;
  const r = state.data;
  const g = r.governance;
  const voterRoles = g.rule.vote?.voterRoles ?? [];
  const canVote = voterRoles.some((x) => myRoles.includes(x)) || hasRole();
  const myVote = r.votes.find((v) => v.userId === session?.user?.id);
  const vote = (c: VoteChoice) => act.run(() => api.voteRelease(r.id, c));
  const canPublish = hasRole('steward', 'owner');

  return (
    <div>
      <Link to={`/o/${id}/releases`} className="mb-4 inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
        <ArrowLeft className="size-4" /> Releases
      </Link>
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <h2 className="font-mono text-2xl font-semibold">v{r.version}</h2>
        <LevelBadge level={r.level} />
        <ReleaseStatus r={r} />
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-6">
          <Card className="p-5">
            <h3 className="mb-2 text-sm font-semibold">Release notes</h3>
            {r.notes ? <Markdown text={r.notes} /> : <p className="text-sm text-muted">No notes.</p>}
            <div className="mt-4 space-y-1 border-t border-line pt-3 text-xs text-muted">
              <div className="flex items-center gap-1.5">
                Version IRI: <code className="font-mono">{r.versionIRI}</code> <CopyButton text={r.versionIRI} variant="ghost" />
              </div>
              {r.commit && <div>Commit: <code className="font-mono">{r.commit.slice(0, 10)}</code></div>}
              <div>
                Drafted by {userById(r.createdBy)?.name ?? 'someone'} on {formatDate(r.createdAt)}
                {r.publishedAt && ` · published ${formatDate(r.publishedAt, true)}`}
              </div>
            </div>
          </Card>
          <Card>
            <CardHeader title={`Included changes (${r.changeRequests.length})`} />
            <ul className="divide-y divide-line">
              {r.changeRequests.map((c) => (
                <li key={c.id}>
                  <Link to={`/o/${id}/changes/${c.id}`} className="flex items-center gap-2 px-5 py-3 text-sm hover:bg-surface-2">
                    <span className="text-muted">#{c.number}</span>
                    <span className="flex-1">{c.title}</span>
                    <LevelBadge level={c.classification?.level} />
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        </div>
        <div className="space-y-4">
          <Card>
            <CardHeader icon={Scale} title="Release approval" />
            <div className="p-5">
              <GovernancePanel g={g} userById={userById} />
            </div>
          </Card>
          <Card className="space-y-3 p-5">
            {r.status === 'voting' && (
              <>
                <div className="grid grid-cols-3 gap-2">
                  <Button variant={myVote?.choice === 'yes' ? 'primary' : 'secondary'} icon={ThumbsUp} disabled={!canVote || act.pending} onClick={() => void vote('yes')}>
                    Yes
                  </Button>
                  <Button variant={myVote?.choice === 'no' ? 'danger' : 'secondary'} icon={ThumbsDown} disabled={!canVote || act.pending} onClick={() => void vote('no')}>
                    No
                  </Button>
                  <Button variant={myVote?.choice === 'abstain' ? 'subtle' : 'secondary'} icon={Minus} disabled={!canVote || act.pending} onClick={() => void vote('abstain')}>
                    Abstain
                  </Button>
                </div>
                {!canVote && <p className="text-xs text-muted">Only {voterRoles.map(roleLabel).join(', ')} can vote on releases at this level.</p>}
              </>
            )}
            {r.status !== 'published' && r.status !== 'rejected' && (
              <Button variant="primary" icon={Rocket} className="w-full" loading={act.pending} disabled={!canPublish} onClick={() => void act.run(() => api.publishRelease(r.id))}>
                Publish v{r.version}
              </Button>
            )}
            {!canPublish && r.status !== 'published' && <p className="text-xs text-muted">A steward or owner publishes releases once approval conditions are met.</p>}
            {r.status === 'published' && (
              <p className="text-sm">
                Published {formatDate(r.publishedAt, true)}.{' '}
                {r.githubUrl && (
                  <a href={r.githubUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">
                    <GitHubIcon className="size-3.5" /> View on GitHub <ExternalLink className="size-3" />
                  </a>
                )}
              </p>
            )}
            <InlineError error={act.error} />
          </Card>
        </div>
      </div>
    </div>
  );
}
