import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { UseCaseDetail, UseCaseLink, UseCaseStatus } from '@concord/shared';
import { USE_CASE_STATUS_INFO } from '@concord/shared';
import { Archive, ArrowLeft, ExternalLink, FileText, GitPullRequest, Link2, Lock, MessageSquareText, Send, Sparkles, Tag, Trash2, Users, Workflow } from 'lucide-react';
import { api } from '../../api';
import { useAction, useAsync } from '../../lib/hooks';
import { formatDate } from '../../lib/format';
import { SourceBadge, StatusPill } from '../../components/badges';
import { CompletenessMeter, UseCaseDocument } from '../../components/UseCaseDocument';
import { AnonymisedVersion, UseCaseRefLink, UseCaseStatusBadge, VisibilityBadge, VisibilityPicker } from '../../components/UseCaseSharing';
import { Badge, Button, Card, CardHeader, ErrorCard, InlineError, Input, Loading, Select } from '../../components/ui';
import { useOntology } from './Layout';
import { useStartInterview } from './UseCases';

const RELATION_LABEL: Record<UseCaseLink['relation'], { out: string; in: string }> = {
  related: { out: 'Related to', in: 'Related to' },
  'duplicate-of': { out: 'Duplicate of', in: 'Duplicated by' },
  'depends-on': { out: 'Depends on', in: 'Needed by' },
  refines: { out: 'Refines', in: 'Refined by' },
};

export function UseCaseDetailPage() {
  const { useCaseId = '' } = useParams();
  const { id, userById } = useOntology();
  const nav = useNavigate();
  const uc = useAsync(() => api.useCase(useCaseId), [useCaseId]);
  const start = useStartInterview(id);
  const archive = useAction(async () => uc.setData(await api.updateUseCase(useCaseId, { status: 'archived' })));
  const synth = useAction(async () => {
    const cr = await api.synthesise(id, [useCaseId]);
    nav(`/o/${id}/changes/${cr.id}`);
  });

  if (uc.error && !uc.data) return <ErrorCard error={uc.error} onRetry={uc.reload} />;
  if (!uc.data) return <Loading />;
  const u = uc.data;
  const author = u.anonymous ? undefined : userById(u.authorId);
  const set = (x: UseCaseDetail) => uc.setData(x);
  const isPrivate = u.visibility === 'private';
  const canContinue = u.source === 'chat' && u.status === 'draft' && u.can.changeVisibility;
  const canDraft = !isPrivate && u.can.edit && !['closed', 'archived', 'out-of-scope'].includes(u.status);
  // Drafting changes is the next step once the working group has accepted the use case.
  const draftIsNext = canDraft && ['accepted', 'in-progress'].includes(u.status);

  return (
    <div>
      <Link to={`/o/${id}/use-cases`} className="mb-4 inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
        <ArrowLeft className="size-4" /> All use cases
      </Link>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-6">
          <Card className="p-6">
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs text-muted">UC-{u.number}</span>
              <UseCaseStatusBadge status={u.status} version={u.resolution?.version} />
              <VisibilityBadge visibility={u.visibility} anonymous={u.anonymous} />
              <SourceBadge source={u.source} />
            </div>
            <h2 className="text-xl font-semibold">{u.sections.name || 'Untitled use case'}</h2>
            <p className="mt-1 mb-6 text-xs text-muted">
              {u.anonymous ? 'Published anonymously' : (author?.name ?? 'Unknown author')} · started {formatDate(u.createdAt)} · updated {formatDate(u.updatedAt)}
            </p>
            {isPrivate && u.can.changeVisibility && (
              <div className="mb-6">
                <AnonymisedVersion uc={u} onChange={set} ontologyId={id} />
              </div>
            )}
            <UseCaseDocument uc={u} collapsible />
          </Card>
          <TraceCard uc={u} onChange={set} />
        </div>
        <div className="space-y-4">
          <LifecycleCard uc={u} onChange={set} />
          {u.can.changeVisibility && (
            <Card className="p-5">
              <VisibilityPicker uc={u} onChange={set} />
            </Card>
          )}
          <Card className="space-y-4 p-5">
            <CompletenessMeter value={u.completeness} />
            <div className="flex flex-col gap-2">
              {/* The main action depends on where the use case is: finish the interview, or draft changes once accepted. */}
              {canContinue && (
                <Button variant="primary" icon={MessageSquareText} loading={start.pending} onClick={() => void start.run(u.id)}>
                  Continue the interview
                </Button>
              )}
              {canDraft && (
                <Button variant={draftIsNext ? 'primary' : 'secondary'} icon={Sparkles} loading={synth.pending} onClick={() => void synth.run()} title="Draft a change request proposing the ontology changes this use case needs">
                  Draft changes
                </Button>
              )}
              {u.can.edit && u.status !== 'archived' && (
                <Button variant="ghost" icon={Archive} disabled={archive.pending} onClick={() => void archive.run()}>
                  Archive
                </Button>
              )}
            </div>
            <InlineError error={synth.error || start.error || archive.error} />
          </Card>
          {(u.transcriptUrl || u.podUrl) && (
            <Card className="space-y-2 p-4 text-xs text-muted">
              <div className="flex items-center gap-1.5 font-medium text-fg">
                <Lock className="size-3.5" /> Your private copies
              </div>
              {u.transcriptUrl && (
                <p>
                  Interview transcript:{' '}
                  <a href={u.transcriptUrl} target="_blank" rel="noreferrer" className="break-all text-accent hover:underline">
                    {u.transcriptUrl}
                  </a>
                </p>
              )}
              {u.podUrl && (
                <p>
                  This use case, in your Solid pod:{' '}
                  <a href={u.podUrl} target="_blank" rel="noreferrer" className="break-all text-accent hover:underline">
                    {u.podUrl}
                  </a>
                </p>
              )}
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- lifecycle */

const STEPS: UseCaseStatus[] = ['draft', 'triage', 'accepted', 'in-progress', 'addressed', 'closed'];

function LifecycleCard({ uc, onChange }: { uc: UseCaseDetail; onChange: (u: UseCaseDetail) => void }) {
  const { userById } = useOntology();
  const [note, setNote] = useState('');
  const triage = useAction(async (status: UseCaseStatus) => {
    onChange(await api.triageUseCase(uc.id, status, note || undefined));
    setNote('');
  });
  const submit = useAction(async () => onChange(await api.submitUseCase(uc.id)));
  const info = USE_CASE_STATUS_INFO[uc.status];
  const step = STEPS.indexOf(uc.status);
  const by = uc.resolution?.by ? userById(uc.resolution.by)?.name : undefined;

  return (
    <Card>
      <CardHeader icon={Workflow} title="Status" />
      <div className="space-y-4 p-5">
        <ol className="flex items-center gap-1" aria-label="Lifecycle">
          {STEPS.map((s, i) => (
            <li
              key={s}
              title={USE_CASE_STATUS_INFO[s].label}
              aria-current={s === uc.status ? 'step' : undefined}
              className={`h-1.5 flex-1 rounded-full ${step >= 0 && i <= step ? 'bg-accent' : 'bg-line'}`}
            />
          ))}
        </ol>
        <div>
          <UseCaseStatusBadge status={uc.status} version={uc.resolution?.version} />
          <p className="mt-1.5 text-xs text-muted">{info.description}</p>
          {uc.resolution?.note && (
            <p className="mt-2 rounded-md bg-surface-2 p-2 text-xs">
              {uc.resolution.note}
              {by && <span className="text-muted"> · {by}</span>}
            </p>
          )}
        </div>
        {uc.visibility === 'private' && uc.can.changeVisibility && (
          <p className="text-xs text-muted">Private use cases are not triaged. Share it, make it public, or publish the anonymised version for the working group to consider it.</p>
        )}
        {uc.can.changeVisibility && uc.visibility !== 'private' && ['draft', 'deferred', 'archived'].includes(uc.status) && (
          <Button icon={Send} loading={submit.pending} onClick={() => void submit.run()} className="w-full">
            Submit for triage
          </Button>
        )}
        {uc.can.triage && uc.status !== 'archived' && (
          <div className="space-y-2 border-t border-line pt-4">
            <p className="text-xs font-medium">Triage</p>
            <Input placeholder="Note (optional), e.g. why it is out of scope" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Triage note" />
            <div className="grid grid-cols-2 gap-2">
              {uc.status !== 'accepted' && !['in-progress', 'addressed'].includes(uc.status) && (
                <Button size="sm" variant="primary" disabled={triage.pending} onClick={() => void triage.run('accepted')}>
                  Accept
                </Button>
              )}
              {uc.status !== 'deferred' && (
                <Button size="sm" disabled={triage.pending} onClick={() => void triage.run('deferred')}>
                  Defer
                </Button>
              )}
              {uc.status !== 'out-of-scope' && (
                <Button size="sm" disabled={triage.pending} onClick={() => void triage.run('out-of-scope')}>
                  Out of scope
                </Button>
              )}
              {uc.status !== 'closed' && (
                <Button size="sm" disabled={triage.pending} onClick={() => void triage.run('closed')} title="Already covered by the current version, no change needed">
                  Already covered
                </Button>
              )}
              {['closed', 'deferred', 'out-of-scope'].includes(uc.status) && (
                <Button size="sm" variant="ghost" disabled={triage.pending} onClick={() => void triage.run('triage')}>
                  Reopen
                </Button>
              )}
            </div>
          </div>
        )}
        <InlineError error={triage.error || submit.error} />
      </div>
    </Card>
  );
}

/* ---------------------------------------------------------------- links */

function TraceCard({ uc, onChange }: { uc: UseCaseDetail; onChange: (u: UseCaseDetail) => void }) {
  const { id } = useOntology();
  const t = uc.trace;
  const [adding, setAdding] = useState(false);
  const canLink = uc.can.edit || uc.visibility !== 'private';
  const remove = useAction(async (target: string) => onChange(await api.removeUseCaseLink(uc.id, target)));
  const empty = !t.source && !t.changeRequests.length && !t.releases.length && !t.related.length && !t.other.length && !t.documents.length;

  return (
    <Card>
      <CardHeader
        icon={Link2}
        title="Links"
        subtitle="Where this came from and what it led to"
        actions={
          canLink && (
            <Button size="sm" variant="ghost" icon={Link2} onClick={() => setAdding((x) => !x)}>
              {adding ? 'Cancel' : 'Add link'}
            </Button>
          )
        }
      />
      <div className="space-y-5 p-5 text-sm">
        {adding && <AddLink uc={uc} onDone={(u) => (onChange(u), setAdding(false))} />}
        {t.source && (
          <section>
            <h3 className="mb-1.5 text-xs font-semibold tracking-wide text-muted uppercase">Came from</h3>
            <div className="flex items-start gap-2">
              {t.source.kind === 'meeting' ? <Users className="mt-0.5 size-4 text-muted" /> : <MessageSquareText className="mt-0.5 size-4 text-muted" />}
              <div className="min-w-0">
                {t.source.href ? (
                  <Link to={t.source.href} className="font-medium text-accent hover:underline">
                    {t.source.title}
                  </Link>
                ) : (
                  <span className="font-medium">{t.source.title}</span>
                )}
                {t.source.date && <span className="text-xs text-muted"> · {formatDate(t.source.date)}</span>}
                {!!t.source.lines?.length && (
                  <div className="mt-2 space-y-1.5" data-testid="source-lines">
                    {t.source.lines.map((l, i) => (
                      <blockquote key={i} className="border-l-2 border-line-strong pl-2 text-xs">
                        <span className="font-semibold">{l.speaker}:</span> {l.text}
                      </blockquote>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </section>
        )}
        {!!t.changeRequests.length && (
          <section>
            <h3 className="mb-1.5 text-xs font-semibold tracking-wide text-muted uppercase">Change requests</h3>
            <ul className="space-y-1.5">
              {t.changeRequests.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center gap-2">
                  <GitPullRequest className="size-4 text-muted" />
                  <Link to={`/o/${id}/changes/${c.id}`} className="hover:text-accent">
                    <span className="text-muted">#{c.number}</span> {c.title}
                  </Link>
                  <StatusPill status={c.status} />
                </li>
              ))}
            </ul>
          </section>
        )}
        {!!t.releases.length && (
          <section>
            <h3 className="mb-1.5 text-xs font-semibold tracking-wide text-muted uppercase">Released in</h3>
            <ul className="flex flex-wrap gap-2">
              {t.releases.map((r) => (
                <li key={r.id}>
                  <Link to={`/o/${id}/releases/${r.id}`} className="inline-flex items-center gap-1 font-mono text-sm hover:text-accent">
                    <Tag className="size-3.5" />v{r.version}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
        {!!t.documents.length && (
          <section>
            <h3 className="mb-1.5 text-xs font-semibold tracking-wide text-muted uppercase">Cited in</h3>
            <ul className="space-y-1">
              {t.documents.map((d) => (
                <li key={d.version} className="flex items-center gap-2">
                  <FileText className="size-4 text-muted" />
                  <Link to={`/o/${id}/requirements/${d.version}#uc-${uc.id}`} className="hover:text-accent">
                    Use cases and requirements, v{d.version}
                  </Link>
                  {d.status === 'draft' && <Badge tone="outline">Draft</Badge>}
                </li>
              ))}
            </ul>
          </section>
        )}
        {!!t.related.length && (
          <section>
            <h3 className="mb-1.5 text-xs font-semibold tracking-wide text-muted uppercase">Related use cases</h3>
            <ul className="space-y-1.5">
              {t.related.map((r) => (
                <li key={`${r.id}-${r.direction}`} className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-muted">{RELATION_LABEL[r.relation][r.direction]}</span>
                  <UseCaseRefLink ontologyId={id} r={r} />
                  {r.direction === 'out' && canLink && (
                    <button className="text-muted hover:text-danger" aria-label={`Remove link to UC-${r.number}`} onClick={() => void remove.run(r.id)}>
                      <Trash2 className="size-3.5" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
        {!!t.other.length && (
          <section>
            <h3 className="mb-1.5 text-xs font-semibold tracking-wide text-muted uppercase">Other links</h3>
            <ul className="space-y-1.5">
              {t.other.map((l) => (
                <li key={l.id ?? l.url} className="flex items-center gap-2">
                  {l.type === 'url' ? (
                    <a href={l.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">
                      {l.label || l.url} <ExternalLink className="size-3" />
                    </a>
                  ) : (
                    <Link to={`/o/${id}/${l.type === 'meeting' ? 'meetings' : 'changes'}/${l.id}`} className="text-accent hover:underline">
                      {l.label || (l.type === 'meeting' ? 'Meeting' : 'Change request')}
                    </Link>
                  )}
                  {canLink && (
                    <button className="text-muted hover:text-danger" aria-label="Remove link" onClick={() => void remove.run((l.id ?? l.url)!)}>
                      <Trash2 className="size-3.5" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
        {empty && !adding && <p className="text-muted">No links yet.</p>}
        <InlineError error={remove.error} />
      </div>
    </Card>
  );
}

function AddLink({ uc, onDone }: { uc: UseCaseDetail; onDone: (u: UseCaseDetail) => void }) {
  const { id } = useOntology();
  const all = useAsync(() => api.useCases(id), [id]);
  const meetings = useAsync(() => api.meetings(id), [id]);
  const [kind, setKind] = useState<'use-case' | 'meeting' | 'url'>('use-case');
  const [target, setTarget] = useState('');
  const [relation, setRelation] = useState<UseCaseLink['relation']>('related');
  const [label, setLabel] = useState('');
  const add = useAction(async () =>
    onDone(await api.addUseCaseLink(uc.id, kind === 'url' ? { type: 'url', url: target, label: label || undefined, relation } : { type: kind, id: target, relation, label: label || undefined })),
  );
  return (
    <form
      className="space-y-2 rounded-lg border border-line p-3"
      onSubmit={(e) => {
        e.preventDefault();
        void add.run();
      }}
    >
      <div className="grid gap-2 sm:grid-cols-[140px_1fr]">
        <Select aria-label="Link to" value={kind} onChange={(e) => (setKind(e.target.value as typeof kind), setTarget(''))}>
          <option value="use-case">Use case</option>
          <option value="meeting">Meeting</option>
          <option value="url">Web page</option>
        </Select>
        {kind === 'url' ? (
          <Input aria-label="URL" placeholder="https://…" value={target} onChange={(e) => setTarget(e.target.value)} />
        ) : (
          <Select aria-label={kind === 'meeting' ? 'Meeting' : 'Use case'} value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">Choose…</option>
            {kind === 'use-case'
              ? (all.data ?? [])
                  .filter((x) => x.id !== uc.id)
                  .sort((a, b) => a.number - b.number)
                  .map((x) => (
                    <option key={x.id} value={x.id}>
                      UC-{x.number} {x.sections.name || 'Untitled'}
                    </option>
                  ))
              : (meetings.data ?? []).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.title}
                  </option>
                ))}
          </Select>
        )}
      </div>
      <div className="grid gap-2 sm:grid-cols-[140px_1fr]">
        <Select aria-label="Relation" value={relation} onChange={(e) => setRelation(e.target.value as UseCaseLink['relation'])}>
          <option value="related">Related to</option>
          <option value="depends-on">Depends on</option>
          <option value="refines">Refines</option>
          <option value="duplicate-of">Duplicate of</option>
        </Select>
        <Input aria-label="Label (optional)" placeholder="Label (optional)" value={label} onChange={(e) => setLabel(e.target.value)} />
      </div>
      <Button type="submit" size="sm" variant="primary" loading={add.pending} disabled={!target}>
        Add link
      </Button>
      <InlineError error={add.error} />
    </form>
  );
}
