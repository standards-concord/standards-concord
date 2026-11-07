import { Link, useParams } from 'react-router';
import { canCastVote, type ReleaseDetail } from '@concord/shared';
import { ArrowLeft, ClipboardList, ExternalLink, FileText, Minus, RefreshCw, Rocket, Scale, ThumbsDown, ThumbsUp } from 'lucide-react';
import { api, type VoteChoice } from '../../api';
import { useAction, useAsync } from '../../lib/hooks';
import { useSession } from '../../lib/session';
import { formatDate, publicPageUrl, roleLabel } from '../../lib/format';
import { GitHubIcon, LevelBadge } from '../../components/badges';
import { GovernancePanel } from '../../components/GovernancePanel';
import { ApprovalRecord } from '../../components/ApprovalRecord';
import { PolicyGlance } from '../../components/PolicyRules';
import { CollapsibleCard, Disclosure } from '../../components/Disclosure';
import { Markdown } from '../../components/Markdown';
import { Button, Card, CardHeader, CopyButton, ErrorCard, InlineError, Loading } from '../../components/ui';
import { UseCaseRefLink } from '../../components/UseCaseSharing';
import { useOntology } from './Layout';
import { ReleaseStatus } from './Releases';

export function ReleaseDetailPage() {
  const { releaseId = '' } = useParams();
  const { id, ontology, userById, hasRole, myRoles, reload } = useOntology();
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
  // The same check the server uses to accept and count a vote.
  const canVote = canCastVote(myRoles, voterRoles);
  const myVote = r.votes.find((v) => v.userId === session?.user?.id);
  const vote = (c: VoteChoice) => act.run(() => api.voteRelease(r.id, c));
  const canPublish = hasRole('steward', 'owner');
  const canWrite = hasRole('editor', 'steward', 'owner');

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
            <p className="mt-4 border-t border-line pt-3 text-xs text-muted">
              {/* The policy's automation drafts releases as "system"; that used to read "Drafted by someone". */}
              {r.createdBy === 'system' ? 'Drafted automatically' : `Drafted by ${userById(r.createdBy)?.name ?? 'someone'}`} on {formatDate(r.createdAt)}
              {r.publishedAt && ` · published ${formatDate(r.publishedAt, true)}`}
              {r.status === 'published' && (
                <>
                  {' · '}
                  <a href={publicPageUrl(ontology.slug, r.version)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-accent hover:underline" data-testid="release-public-page">
                    Public page <ExternalLink className="size-3" aria-hidden />
                  </a>
                </>
              )}
            </p>
            <Disclosure className="mt-2" tone="muted" title="Technical details" summary="version IRI">
              <div className="space-y-1 text-xs text-muted">
                <div className="flex items-center gap-1.5">
                  Version IRI: <code className="font-mono">{r.versionIRI}</code> <CopyButton text={r.versionIRI} variant="ghost" />
                </div>
              </div>
            </Disclosure>
          </Card>
          <RequirementsCard r={r} canWrite={canWrite} onChange={() => void state.reload()} />
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
          {r.status === 'published' ? (
            <>
              <Card className="p-5">
                <p className="text-sm">
                  Published {formatDate(r.publishedAt, true)}.{' '}
                  {r.githubUrl && (
                    <a href={r.githubUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">
                      <GitHubIcon className="size-3.5" /> View on GitHub <ExternalLink className="size-3" />
                    </a>
                  )}
                </p>
                {/* Today's rules, not a record of the rules at the time: kept outside the approval history on purpose. */}
                <PolicyGlance policy={ontology.governance} ontologyId={id} kind="release" title="Current release policy" className="mt-4 border-t border-line pt-3" />
              </Card>
              <ApprovalHistory r={r} userById={userById} />
            </>
          ) : r.status === 'rejected' ? (
            <>
              <Card className="p-5">
                <p className="text-sm text-muted">This release attempt was rejected. Draft a new release to try again.</p>
                <PolicyGlance policy={ontology.governance} ontologyId={id} kind="release" title="Current release policy" className="mt-4 border-t border-line pt-3" />
              </Card>
              <ApprovalHistory r={r} userById={userById} />
            </>
          ) : (
            <Card>
              <CardHeader icon={Scale} title="Release approval" />
              <div className="space-y-4 p-5">
                <GovernancePanel
                  g={g}
                  userById={userById}
                  subject="release"
                  actions={
                    <div className="space-y-3">
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
                      <Button variant="primary" icon={Rocket} className="w-full" loading={act.pending} disabled={!canPublish} onClick={() => void act.run(() => api.publishRelease(r.id))}>
                        Publish v{r.version}
                      </Button>
                      {!canPublish && <p className="text-xs text-muted">A steward or owner publishes releases once approval conditions are met.</p>}
                      <InlineError error={act.error} />
                    </div>
                  }
                />
                <PolicyGlance policy={ontology.governance} ontologyId={id} kind="release" />
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * How a decided (published or rejected) release was approved or turned down, read-only. It shows the
 * evaluation recorded at the decision, so later policy or membership changes don't rewrite it. Older
 * releases without that record say plainly that they're checked against today's rules.
 */
function ApprovalHistory({ r, userById }: { r: ReleaseDetail; userById: ReturnType<typeof useOntology>['userById'] }) {
  if (r.approvalSource === 'bootstrap')
    return (
      <CollapsibleCard icon={Scale} title="How this was approved" summary="The first release, published when the ontology was set up" keepMounted>
        <p className="p-5 text-sm text-muted" data-testid="approval-source">
          This was the ontology’s first release, published when it was set up in Concord. No approval rules applied to it; every release since follows the policy.
        </p>
      </CollapsibleCard>
    );
  const published = r.status === 'published';
  const decidedAt = published ? r.publishedAt : r.statusSince;
  const verb = published ? 'published' : 'rejected';
  const recorded = r.approvalSource === 'recorded';
  const title = recorded
    ? published
      ? 'How this was approved'
      : 'Why this was rejected'
    : published
      ? 'Approval, checked against today’s policy'
      : 'Rejection, checked against today’s policy';
  return (
    <CollapsibleCard
      icon={Scale}
      title={title}
      summary={recorded ? `Recorded when it was ${verb} on ${formatDate(decidedAt)}` : `No record was kept when this was ${verb}`}
      defaultOpen={!published}
      keepMounted
    >
      <div className="space-y-4 p-5">
        <p className="text-xs text-muted" data-testid="approval-source">
          {recorded
            ? `The rules, approvals and vote as they stood when this release was ${verb} on ${formatDate(decidedAt, true)}. Later changes to the policy or members don’t change this record.`
            : `Concord didn’t keep a record of this decision when the release was ${verb}, so the rules and counts below apply today’s policy and members. They may not match what was required at the time.`}
        </p>
        <ApprovalRecord g={r.governance} outcome={published ? 'approved' : 'rejected'} decidedAt={decidedAt} votes={r.votes} userById={userById} subject="release" timing={recorded ? 'recorded' : 'unavailable'} />
      </div>
    </CollapsibleCard>
  );
}

/** The release's use cases and requirements document, and the use cases it closes. */
function RequirementsCard({ r, canWrite, onChange }: { r: ReleaseDetail; canWrite: boolean; onChange: () => void }) {
  const { id } = useOntology();
  const gen = useAction(async () => {
    await api.generateRequirements(r.id);
    onChange();
  });
  const doc = r.requirements;
  return (
    <Card>
      <CardHeader
        icon={ClipboardList}
        title="Use cases and requirements"
        subtitle={
          r.status === 'published'
            ? 'Published with this release.'
            : 'Drafted with the release. It is frozen and committed when the release is published.'
        }
        actions={
          canWrite &&
          r.status !== 'published' && (
            <Button size="sm" icon={RefreshCw} loading={gen.pending} onClick={() => void gen.run()}>
              {doc ? 'Rewrite' : 'Write it now'}
            </Button>
          )
        }
      />
      <div className="space-y-4 p-5 text-sm">
        {doc ? (
          <Link to={`/o/${id}/requirements/${doc.version}`} className="inline-flex items-center gap-1.5 font-medium text-accent hover:underline">
            <FileText className="size-4" /> {doc.title}
            {doc.status === 'draft' && <span className="font-normal text-muted">(draft)</span>}
          </Link>
        ) : (
          <p className="text-muted">{r.status === 'published' ? 'No document was written for this release.' : 'Being written… refresh in a moment.'}</p>
        )}
        {!!r.useCases?.length && (
          <div>
            <p className="mb-1.5 text-xs font-semibold tracking-wide text-muted uppercase">{r.status === 'published' ? 'Use cases this release closed' : 'Use cases this release will close'}</p>
            <ul className="space-y-1.5">
              {r.useCases.map((u) => (
                <li key={u.id}>
                  <UseCaseRefLink ontologyId={id} r={u} />
                </li>
              ))}
            </ul>
          </div>
        )}
        <InlineError error={gen.error} />
      </div>
    </Card>
  );
}
