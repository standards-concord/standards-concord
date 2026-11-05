import { useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import type { ChangeOp, ChangeRequestDetail } from '@concord/shared';
import { ArrowLeft, Check, CircleSlash, GitMerge, Lightbulb, MessageSquare, Send, ShieldCheck, ThumbsDown, ThumbsUp, TriangleAlert, Undo2, X, Minus, History, Scale, PenLine, ScanSearch } from 'lucide-react';
import { api, type ReviewDecision, type VoteChoice } from '../../api';
import { useAction, useAsync } from '../../lib/hooks';
import { useSession } from '../../lib/session';
import { formatDate, plural, relativeTime, roleLabel, titleCase } from '../../lib/format';
import { makeLabeler } from '../../lib/ontology';
import { LevelBadge, OriginIcon, RoleChips } from '../../components/badges';
import { GovernancePanel } from '../../components/GovernancePanel';
import { OpCards, TermChanges, TripleDiff } from '../../components/OpsView';
import { ValidationDetails } from '../../components/Validation';
import { ChangeStatusBubble } from '../../components/Phase';
import { Markdown } from '../../components/Markdown';
import { Disclosure, Popover } from '../../components/Disclosure';
import { Avatar, Badge, Button, Card, CardHeader, Dialog, ErrorCard, InlineError, Loading, Textarea, cx } from '../../components/ui';
import { useOntology } from './Layout';

/**
 * A request drafted from use cases (which may be private) is published only
 * as an editor approved it: this shows exactly what merging it would publish,
 * highlights what looks like a use case title or a person's name (a hint,
 * never a verdict), and approves that exact version.
 */
function PublicationApproval({ cr, onUpdate }: { cr: ChangeRequestDetail; onUpdate: (d: ChangeRequestDetail) => void }) {
  const { hasRole, userById } = useOntology();
  const pub = useAsync(() => api.publication(cr.id), [cr.id, cr.opsUpdatedAt, cr.title, cr.status, cr.privacyCleared?.fingerprint]);
  const approve = useAction(async (fingerprint: string) => {
    try {
      onUpdate(await api.approvePublication(cr.id, fingerprint));
    } finally {
      // Changed since it was shown (409) or approved: either way, show what is there now.
      await pub.reload();
    }
  });
  const p = pub.data;
  const approved = !!p && cr.privacyCleared?.fingerprint === p.fingerprint;
  const hinted = p ? p.hints.length + p.statements.filter((st) => st.hint).length : 0;
  const kind = (k: 'use case title' | 'name') => (k === 'name' ? 'a person’s name' : 'a use case title');
  const short = (iri: string) => iri.replace(/^.*[#/]/, '') || iri;
  return (
    <Card>
      <CardHeader icon={ShieldCheck} title="What this publishes" subtitle="Drafted from use cases, which may be private. An editor approves exactly this before it is merged." />
      <div className="space-y-3 p-5 text-sm" data-testid="publication">
        {pub.error && !p ? (
          <ErrorCard title="Couldn’t work out what this publishes" error={pub.error} onRetry={() => void pub.reload()} />
        ) : !p ? (
          <Loading label="Working out what this publishes…" />
        ) : (
          <>
            {approved ? (
              <p className="rounded-lg bg-ok-soft p-2.5 text-ok" data-testid="publication-approved">
                Approved by {userById(cr.privacyCleared!.by)?.name ?? 'an editor'} {relativeTime(cr.privacyCleared!.at, Date.now())}. Any change needs approving again.
              </p>
            ) : hinted ? (
              <p className="rounded-lg bg-warn-soft p-2.5 text-warn" role="note">
                {plural(hinted, 'item')} may name a use case or a person (highlighted). The check can miss things, so read it all.
              </p>
            ) : (
              <p className="text-muted">Nothing below looks private, but the check can miss things, so read it all.</p>
            )}
            <dl className="space-y-2">
              <div>
                <dt className="text-xs font-medium text-muted">Title (in the commit and the release notes)</dt>
                <dd className={cx('mt-0.5 break-words', p.hints.some((h) => h.where === 'the title') && 'rounded bg-warn-soft px-1')}>{p.title}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-muted">Statements added to the public ontology ({p.statements.length})</dt>
                <dd>
                  <ul className="mt-1 max-h-72 space-y-1 overflow-auto">
                    {p.statements.map((st, i) => (
                      <li key={i} data-statement data-hint={st.hint ?? undefined} className={cx('break-words rounded px-1 font-mono text-xs', st.hint && 'bg-warn-soft')}>
                        <span className="block font-sans">
                          <span className="font-medium">{short(st.subject)}</span> · {short(st.predicate)} · {st.object}
                        </span>
                        {/* Exactly as published: full IRIs, language and datatype. A private name can sit anywhere in an IRI. */}
                        <code className="block text-muted" data-nt>
                          {st.nt}
                        </code>
                        {st.hint && <span className="sr-only"> (may be {kind(st.hint)})</span>}
                      </li>
                    ))}
                  </ul>
                </dd>
              </div>
              {p.kgcl.length > 0 && (
                <div>
                  <dt className="text-xs font-medium text-muted">Edit list (in the commit and the release notes)</dt>
                  <dd>
                    <ul className="mt-1 space-y-0.5 font-mono text-xs">
                      {p.kgcl.map((k, i) => (
                        <li key={i} className="break-words">
                          {k}
                        </li>
                      ))}
                    </ul>
                  </dd>
                </div>
              )}
            </dl>
            {!approved && hasRole('editor', 'steward', 'owner') && (
              <Button variant="primary" icon={Check} loading={approve.pending} onClick={() => void approve.run(p.fingerprint)}>
                Approve exactly this for publishing
              </Button>
            )}
            <InlineError error={approve.error} />
          </>
        )}
      </div>
    </Card>
  );
}

function ActionBar({ cr, onUpdate }: { cr: ChangeRequestDetail; onUpdate: (d: ChangeRequestDetail) => void }) {
  const { hasRole, myRoles } = useOntology();
  const { session } = useSession();
  const uid = session?.user?.id;
  const [comment, setComment] = useState('');
  const [reviseOpen, setReviseOpen] = useState(false);
  const [instruction, setInstruction] = useState('');
  const act = useAction(async (fn: () => Promise<ChangeRequestDetail>) => {
    const d = await fn();
    onUpdate(d);
    setComment('');
  });
  const revise = useAction(async () => {
    onUpdate(await api.revise(cr.id, instruction.trim()));
    setReviseOpen(false);
    setInstruction('');
  });

  const isAuthor = cr.authorId === uid;
  const canEdit = isAuthor || hasRole('editor', 'steward', 'owner');
  const open = ['draft', 'triage', 'review', 'voting', 'approved', 'needs-work'].includes(cr.status);
  const voterRoles = cr.governance.rule.vote?.voterRoles ?? [];
  const canVote = cr.status === 'voting' && (voterRoles.some((r) => myRoles.includes(r)) || hasRole());
  const myVote = cr.votes.find((v) => v.userId === uid);
  const myReview = [...cr.reviews].reverse().find((r) => r.userId === uid && r.decision !== 'comment');
  const c = comment.trim() || undefined;
  const review = (d: ReviewDecision) => act.run(() => api.review(cr.id, d, c));
  const vote = (ch: VoteChoice) => act.run(() => api.voteChangeRequest(cr.id, ch, c));
  const approverOk = cr.governance.rule.approverRoles.some((r) => myRoles.includes(r));

  if (!open) return <p className="text-sm text-muted">No actions — this request is {cr.status}.</p>;

  return (
    <div className="space-y-3">
      {(cr.status === 'review' || cr.status === 'voting' || cr.status === 'triage' || cr.status === 'needs-work' || cr.status === 'draft') && (
        <Textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Add a comment (optional for approvals, helpful for objections)…" />
      )}
      {cr.heldForPublication && cr.status === 'needs-work' && (
        <p className="rounded-lg border border-warn/40 bg-warn-soft p-3 text-sm" data-testid="publication-hold">
          Held before merging until an editor approves exactly what it publishes (under “What this publishes”).
        </p>
      )}
      {(cr.status === 'draft' || cr.status === 'needs-work') && canEdit && (
        <Button variant="primary" icon={Send} className="w-full" loading={act.pending} onClick={() => void act.run(() => api.submitChangeRequest(cr.id))}>
          {cr.status === 'draft' ? 'Submit for review' : 'Resubmit'}
        </Button>
      )}
      {(cr.status === 'review' || cr.status === 'triage') && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <Button variant="primary" icon={Check} disabled={act.pending} onClick={() => void review('approve')}>
              Approve
            </Button>
            <Button icon={Undo2} disabled={act.pending} onClick={() => void review('request-changes')}>
              Request changes
            </Button>
            <Button variant="ghost" icon={CircleSlash} disabled={act.pending} onClick={() => void review('object')} className="text-danger">
              Object
            </Button>
            <Button variant="ghost" icon={MessageSquare} disabled={act.pending || !c} onClick={() => void review('comment')}>
              Comment
            </Button>
          </div>
          {!approverOk && <p className="text-xs text-muted">Your approval is recorded but only {cr.governance.rule.approverRoles.map(roleLabel).join(', ')} approvals count towards the threshold.</p>}
          {myReview && <p className="text-xs text-muted">You previously chose “{myReview.decision.replace('-', ' ')}”.</p>}
        </>
      )}
      {cr.status === 'voting' && (
        <>
          <div className="grid grid-cols-3 gap-2">
            <Button variant={myVote?.choice === 'yes' ? 'primary' : 'secondary'} icon={ThumbsUp} disabled={act.pending || !canVote} onClick={() => void vote('yes')}>
              Yes
            </Button>
            <Button variant={myVote?.choice === 'no' ? 'danger' : 'secondary'} icon={ThumbsDown} disabled={act.pending || !canVote} onClick={() => void vote('no')}>
              No
            </Button>
            <Button variant={myVote?.choice === 'abstain' ? 'subtle' : 'secondary'} icon={Minus} disabled={act.pending || !canVote} onClick={() => void vote('abstain')}>
              Abstain
            </Button>
          </div>
          {!canVote && <p className="text-xs text-muted">Only {voterRoles.map(roleLabel).join(', ')} can vote on this.</p>}
          {myVote && <p className="text-xs text-muted">You voted “{myVote.choice}”. You can change your vote while it’s open.</p>}
        </>
      )}
      {cr.status === 'approved' && (
        <Button variant="primary" icon={GitMerge} className="w-full" loading={act.pending} disabled={!hasRole('editor', 'steward', 'owner')} onClick={() => void act.run(() => api.merge(cr.id))}>
          Merge into working draft
        </Button>
      )}
      {cr.status === 'approved' && !hasRole('editor', 'steward', 'owner') && <p className="text-xs text-muted">An editor or steward will merge this.</p>}
      <div className="flex flex-wrap gap-2 border-t border-line pt-3">
        {['draft', 'review', 'needs-work', 'triage'].includes(cr.status) && (
          <Button size="sm" icon={PenLine} onClick={() => setReviseOpen(true)}>
            Ask AI to revise
          </Button>
        )}
        {(isAuthor || hasRole('steward', 'owner')) && (
          <Button size="sm" variant="ghost" icon={X} disabled={act.pending} onClick={() => confirm('Withdraw this change request?') && void act.run(() => api.withdraw(cr.id))}>
            Withdraw
          </Button>
        )}
      </div>
      <InlineError error={act.error} />
      <Dialog
        open={reviseOpen}
        onClose={() => setReviseOpen(false)}
        title="Ask the AI to revise the proposed changes"
        footer={
          <>
            <Button variant="ghost" onClick={() => setReviseOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" icon={PenLine} loading={revise.pending} disabled={!instruction.trim()} onClick={() => void revise.run()}>
              Revise
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-muted">Describe what should change. The AI rewrites the operations, then the request is re-classified and re-validated.</p>
          <Textarea rows={5} value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="e.g. Make Shift a subclass of Event rather than Session, and add a definition that mentions the location." />
          {cr.reviews.filter((r) => r.decision === 'request-changes' && r.comment).length > 0 && (
            <div className="text-xs">
              <div className="mb-1 font-medium text-muted">Reviewer feedback</div>
              {cr.reviews
                .filter((r) => r.decision === 'request-changes' && r.comment)
                .map((r) => (
                  <button key={r.id} className="mb-1 block w-full rounded-md bg-surface-2 p-2 text-left hover:bg-accent-soft" onClick={() => setInstruction((x) => (x ? `${x}\n${r.comment}` : r.comment!))}>
                    “{r.comment}” <span className="text-accent">— use this</span>
                  </button>
                ))}
            </div>
          )}
          <InlineError error={revise.error} />
        </div>
      </Dialog>
    </div>
  );
}

const DECISION: Record<string, { label: string; tone: 'ok' | 'warn' | 'danger' | 'neutral' }> = {
  approve: { label: 'Approved', tone: 'ok' },
  'request-changes': { label: 'Requested changes', tone: 'warn' },
  object: { label: 'Objected', tone: 'danger' },
  comment: { label: 'Commented', tone: 'neutral' },
};

const RECOMMENDATION: Record<string, string> = {
  'change-ontology': 'Change the ontology',
  'use-existing-terms': 'Use existing terms',
  'local-extension': 'Local extension',
  'needs-discussion': 'Needs discussion',
};

/** The level badge opens the rule-based reasons for the classification, so the explanation sits on the badge itself. */
function ClassificationBubble({ cr }: { cr: ChangeRequestDetail }) {
  const c = cr.classification;
  if (!c) return <LevelBadge level={undefined} />;
  return (
    <Popover label={`Level: ${c.level}. Why it’s ${c.level}`} className="rounded-pill focus-visible:outline-offset-2" trigger={<LevelBadge level={c.level} />}>
      <h4 className="mb-1 text-xs font-semibold tracking-wide text-muted uppercase">Why it’s {c.level}</h4>
      <p className="mb-3 text-xs text-muted">Rule-based semantic versioning classification. The level decides which governance rules apply.</p>
      <ul className="space-y-2 text-sm">
        {c.reasons.map((r, i) => (
          <li key={i} className="flex items-start gap-2">
            <LevelBadge level={r.level} className="mt-0.5" />
            <span>
              {r.message}
              <span className="block font-mono text-[0.7rem] text-subtle">{r.rule}</span>
            </span>
          </li>
        ))}
        {!c.reasons.length && <li className="text-muted">No reasons recorded.</li>}
      </ul>
    </Popover>
  );
}

type View = 'changes' | 'checks' | 'discussion';

function Tabs({ view, onChange, items }: { view: View; onChange: (v: View) => void; items: { id: View; label: string; note?: string; tone?: 'danger' | 'warn' }[] }) {
  return (
    <div role="tablist" aria-label="Change request views" className="flex gap-1 overflow-x-auto border-b border-line">
      {items.map((t) => (
        <button
          key={t.id}
          role="tab"
          id={`cr-tab-${t.id}`}
          aria-selected={view === t.id}
          aria-controls={`cr-panel-${t.id}`}
          onClick={() => onChange(t.id)}
          className={cx('-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm whitespace-nowrap', view === t.id ? 'border-accent font-medium text-fg' : 'border-transparent text-muted hover:text-fg')}
        >
          {t.label}
          {t.note && <span className={cx('text-xs', t.tone === 'danger' ? 'text-danger' : t.tone === 'warn' ? 'text-warn' : 'text-muted')}>{t.note}</span>}
        </button>
      ))}
    </div>
  );
}

export function ChangeRequestPage() {
  const { crId = '' } = useParams();
  const { id, ontology, view, userById } = useOntology();
  const { now } = useSession();
  const state = useAsync(() => api.changeRequest(crId), [crId]);
  const [showTriples, setShowTriples] = useState(false);
  const [params, setParams] = useSearchParams();
  const tab = (['changes', 'checks', 'discussion'].includes(params.get('view') ?? '') ? params.get('view') : 'changes') as View;
  const setTab = (v: View) => {
    const n = new URLSearchParams(params);
    if (v === 'changes') n.delete('view');
    else n.set('view', v);
    setParams(n, { replace: true });
  };

  const label = useMemo(() => {
    const extra: Record<string, string> = {};
    for (const op of (state.data?.ops ?? []) as ChangeOp[]) if ('localName' in op && op.localName) extra[`${ontology.namespace}${op.localName}`] = op.label;
    return makeLabeler(view.data, extra);
  }, [state.data?.ops, view.data, ontology.namespace]);

  if (state.error && !state.data) return <ErrorCard error={state.error} onRetry={state.reload} />;
  if (!state.data) return <Loading />;
  const cr = state.data;
  const author = cr.author ?? userById(cr.authorId);
  const nameOf = (uid: string) => userById(uid)?.name ?? (uid === cr.authorId ? author?.name : undefined) ?? 'Someone';

  return (
    <div>
      <Link to={`/o/${id}/changes`} className="mb-4 inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
        <ArrowLeft className="size-4" /> Change requests
      </Link>
      <div className="mb-5">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-xl font-semibold">
            <span className="font-normal text-muted">#{cr.number}</span> {cr.title}
          </h2>
          <ChangeStatusBubble status={cr.status} hasVote={!!cr.governance.rule.vote} />
          <ClassificationBubble cr={cr} />
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
          <span className="flex items-center gap-1.5">
            <Avatar name={author?.name} src={author?.avatarUrl} size={18} simulated={author?.simulated} /> {author?.name ?? 'Unknown'}
          </span>
          <OriginIcon origin={cr.origin} withLabel />
          <span>{titleCase(cr.kind)}</span>
          <span>opened {relativeTime(cr.createdAt, now())}</span>
          {cr.origin.type === 'meeting' && (
            <Link className="text-accent hover:underline" to={`/o/${id}/meetings/${cr.origin.meetingId}`}>
              view meeting
            </Link>
          )}
          {cr.origin.type === 'chat' && cr.origin.useCaseId && (
            <Link className="text-accent hover:underline" to={`/o/${id}/use-cases/${cr.origin.useCaseId}`}>
              view use case
            </Link>
          )}
          {cr.origin.type === 'synthesis' &&
            cr.origin.useCaseIds.map((u, i) => (
              <Link key={u} className="text-accent hover:underline" to={`/o/${id}/use-cases/${u}`}>
                use case {i + 1}
              </Link>
            ))}
        </div>
        {cr.status === 'needs-work' && <p className="mt-2 text-xs font-medium text-warn">Sent back for more work: revise and resubmit.</p>}
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-6">
          <Tabs
            view={tab}
            onChange={setTab}
            items={[
              { id: 'changes', label: 'Changes', note: `${cr.ops.length}` },
              {
                id: 'checks',
                label: 'Checks',
                note: !cr.validation ? 'not run' : cr.validation.passed ? 'passing' : 'failing',
                tone: cr.validation && !cr.validation.passed ? 'danger' : undefined,
              },
              { id: 'discussion', label: 'Discussion', note: `${cr.reviews.length + cr.votes.length}` },
            ]}
          />
          {tab === 'changes' && (
            <div role="tabpanel" id="cr-panel-changes" aria-labelledby="cr-tab-changes" className="space-y-6">
            {cr.description && (
              <Card className="p-5">
                <Markdown text={cr.description} />
              </Card>
            )}

            <Card>
              <CardHeader
                title={`Proposed changes (${cr.ops.length})`}
                actions={
                  <div className="inline-flex rounded-lg border border-line-strong p-0.5 text-xs">
                    <button onClick={() => setShowTriples(false)} className={cx('rounded-md px-2.5 py-1', !showTriples ? 'bg-surface-2 font-medium' : 'text-muted')}>
                      Readable
                    </button>
                    <button onClick={() => setShowTriples(true)} className={cx('rounded-md px-2.5 py-1', showTriples ? 'bg-surface-2 font-medium' : 'text-muted')}>
                      Triples
                    </button>
                  </div>
                }
              />
              <div className="p-5">
                {showTriples ? (
                  <TripleDiff diff={cr.diff} />
                ) : (
                  <div className="space-y-4">
                    <OpCards ops={cr.ops} label={label} />
                    {cr.diff?.terms.length ? (
                      <details>
                        <summary className="cursor-pointer text-xs font-medium text-accent">Effect on terms ({cr.diff.terms.length})</summary>
                        <div className="mt-2">
                          <TermChanges diff={cr.diff} />
                        </div>
                      </details>
                    ) : null}
                  </div>
                )}
              </div>
            </Card>

            {cr.analysis && (
              <Card>
                <CardHeader icon={ScanSearch} title="AI analysis" actions={cr.analysis.recommendation && <Badge tone="accent">{RECOMMENDATION[cr.analysis.recommendation]}</Badge>} />
                <div className="space-y-3 p-5 text-sm">
                  <Markdown text={cr.analysis.summary} />
                  {/* Decision-relevant cautions stay visible; the supporting explanation is behind the disclosure. */}
                  {cr.analysis.existingTerms?.length ? (
                    <p className="flex items-start gap-2 rounded-lg bg-warn-soft p-2.5 text-xs" role="note">
                      <Lightbulb className="mt-0.5 size-3.5 shrink-0 text-warn" />
                      <span>
                        <strong className="font-medium">Existing terms may already cover this:</strong> {cr.analysis.existingTerms.map(label).join(', ')}. Consider reusing them instead of adding new ones.
                      </span>
                    </p>
                  ) : null}
                  {cr.analysis.suggestedLevel && cr.analysis.suggestedLevel !== cr.classification?.level && (
                    <p className="flex items-start gap-2 rounded-lg bg-warn-soft p-2.5 text-xs" role="note">
                      <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warn" />
                      <span>
                        The AI would rate this <LevelBadge level={cr.analysis.suggestedLevel} />, but the rule-based classification (<LevelBadge level={cr.classification?.level} />) decides which rules apply.
                      </span>
                    </p>
                  )}
                  <Disclosure tone="muted" title="Rationale and risks" summary={cr.analysis.risks?.length ? `${cr.analysis.risks.length} ${cr.analysis.risks.length === 1 ? 'risk' : 'risks'}` : undefined}>
                    <div className="space-y-3">
                      <div>
                        <div className="mb-1 text-xs font-semibold tracking-wide text-muted uppercase">Rationale</div>
                        <Markdown text={cr.analysis.rationale} className="text-muted" />
                      </div>
                      {cr.analysis.risks?.length ? (
                        <div>
                          <div className="mb-1 text-xs font-semibold tracking-wide text-muted uppercase">Risks</div>
                          <ul className="list-disc space-y-0.5 pl-5">
                            {cr.analysis.risks.map((r, i) => (
                              <li key={i}>{r}</li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                    </div>
                  </Disclosure>
                </div>
              </Card>
            )}
            </div>
          )}
          {tab === 'checks' && (
            <div role="tabpanel" id="cr-panel-checks" aria-labelledby="cr-tab-checks" className="space-y-6">
            <Card>
              <CardHeader icon={ShieldCheck} title="Validation" subtitle="Run automatically on the working draft with this change applied." />
              <div className="p-5">
                {cr.validation ? (
                  <ValidationDetails report={cr.validation} label={label} />
                ) : (
                  <p className="text-sm text-muted">Not validated yet — validation runs when the request is submitted.</p>
                )}
              </div>
            </Card>
            </div>
          )}
          {tab === 'discussion' && (
            <div role="tabpanel" id="cr-panel-discussion" aria-labelledby="cr-tab-discussion" className="space-y-6">
            <Card>
              <CardHeader icon={History} title="Reviews and timeline" />
              <ol className="relative space-y-4 p-5">
                {[
                  ...cr.reviews.map((r) => ({ at: r.at, kind: 'review' as const, r })),
                  ...cr.votes.map((v) => ({ at: v.at, kind: 'vote' as const, v })),
                  // Reviews (comments included) and votes are listed from their own records above, so skip their timeline copies.
                  ...cr.timeline.filter((e) => e.type !== 'review' && e.type !== 'vote' && e.type !== 'comment').map((e) => ({ at: e.at, kind: 'event' as const, e })),
                ]
                  .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
                  .map((item, i) => (
                    <li key={i} className="flex gap-3">
                      {item.kind === 'event' ? (
                        <span className="mt-1.5 ml-2 size-2 shrink-0 rounded-full bg-line-strong" />
                      ) : (
                        <Avatar name={nameOf(item.kind === 'review' ? item.r.userId : item.v.userId)} size={24} />
                      )}
                      <div className="min-w-0 flex-1 text-sm">
                        {item.kind === 'review' && (
                          <>
                            <div className="flex flex-wrap items-center gap-1.5">
                              <strong className="font-medium">{nameOf(item.r.userId)}</strong>
                              <Badge tone={DECISION[item.r.decision].tone}>{DECISION[item.r.decision].label}</Badge>
                              <RoleChips roles={item.r.roles} />
                              <span className="text-xs text-subtle">{relativeTime(item.at, now())}</span>
                            </div>
                            {item.r.comment && <div className="mt-1 rounded-lg border border-line bg-surface-2/50 p-2.5"><Markdown text={item.r.comment} /></div>}
                          </>
                        )}
                        {item.kind === 'vote' && (
                          <div className="flex flex-wrap items-center gap-1.5">
                            <strong className="font-medium">{nameOf(item.v.userId)}</strong> voted
                            <Badge tone={item.v.choice === 'yes' ? 'ok' : item.v.choice === 'no' ? 'danger' : 'neutral'}>{item.v.choice}</Badge>
                            <span className="text-xs text-subtle">{relativeTime(item.at, now())}</span>
                            {item.v.comment && <p className="w-full text-muted">{item.v.comment}</p>}
                          </div>
                        )}
                        {item.kind === 'event' && (
                          <p className="text-muted">
                            {item.e.actorId && <strong className="font-medium text-fg">{nameOf(item.e.actorId)} </strong>}
                            {item.e.message} <span className="text-xs text-subtle" title={formatDate(item.at, true)}>{relativeTime(item.at, now())}</span>
                          </p>
                        )}
                      </div>
                    </li>
                  ))}
              </ol>
            </Card>
            </div>
          )}
        </div>

        <div className="space-y-4 lg:sticky lg:top-20 lg:self-start">
          {cr.origin.type === 'synthesis' && !['merged', 'released', 'rejected', 'withdrawn'].includes(cr.status) && <PublicationApproval cr={cr} onUpdate={state.setData} />}
          <Card>
            <CardHeader icon={Scale} title="Decision" subtitle={`${ontology.governance.name} · ${plural(cr.reviews.filter((r) => r.decision !== 'comment').length, 'review')}`} />
            <div className="p-5">
              <GovernancePanel g={cr.governance} userById={userById} actions={<ActionBar cr={cr} onUpdate={state.setData} />} />
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
