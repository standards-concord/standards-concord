import { useState } from 'react';
import { forPeople } from '../../lib/forPeople';
import { Link, useParams } from 'react-router';
import type { ForkCheck, ForkConflict, ForkTerm } from '@concord/shared';
import { ArrowLeft, ArrowRight, CircleCheck, GitFork, GitPullRequest, Info, RefreshCw, Sparkles, TriangleAlert, Undo2, X } from 'lucide-react';
import { api, type ForkDetail } from '../../api';
import { useAction, useAsync } from '../../lib/hooks';
import { useSession } from '../../lib/session';
import { formatDate, relativeTime } from '../../lib/format';
import { LevelBadge, StatusPill } from '../../components/badges';
import { Avatar, Badge, Button, Card, CardHeader, CopyButton, ErrorCard, InlineError, Loading, Textarea, cx } from '../../components/ui';
import { useOntology } from './Layout';
import { ForkStatusBadge } from './Forks';

const FORMAT_LABELS: Record<string, string> = {
  turtle: 'Turtle',
  jsonld: 'JSON-LD',
  rdfxml: 'RDF/XML',
  ntriples: 'N-Triples',
  manchester: 'Manchester',
  linkml: 'LinkML',
  shacl: 'SHACL shapes',
};

/** Turtle and JSON-LD up front; the other formats behind "More formats". */
const MAIN_FORMATS = ['turtle', 'jsonld'];

function ForkFormats({ formats }: { formats: Record<string, string> }) {
  const [more, setMore] = useState(false);
  const all = Object.entries(formats);
  const shown = more ? all : all.filter(([fmt]) => MAIN_FORMATS.includes(fmt));
  const hidden = all.length - all.filter(([fmt]) => MAIN_FORMATS.includes(fmt)).length;
  return (
    <ul className="mt-3 flex flex-wrap items-center gap-1.5" aria-label="Formats">
      {shown.map(([fmt, url]) => (
        <li key={fmt}>
          <a href={url} target="_blank" rel="noreferrer" className="inline-flex rounded-full border border-line-strong px-2 py-0.5 text-xs hover:bg-surface-2">
            {FORMAT_LABELS[fmt] ?? fmt}
          </a>
        </li>
      ))}
      {!more && hidden > 0 && (
        <li>
          <button type="button" onClick={() => setMore(true)} className="px-1 text-xs font-medium text-accent hover:underline">
            More formats
          </button>
        </li>
      )}
    </ul>
  );
}

const KIND_LABEL: Record<string, string> = { class: 'Class', objectProperty: 'Relationship', datatypeProperty: 'Attribute', individual: 'Individual', term: 'Term' };

function UpstreamChip({ t }: { t: ForkTerm }) {
  switch (t.upstream) {
    case 'released':
      return <Badge tone="ok">Released in {t.releasedIn}</Badge>;
    case 'merged':
      return <Badge tone="ok">Merged, not released</Badge>;
    case 'pending':
      return <Badge tone="accent">In review</Badge>;
    case 'rejected':
      return <Badge tone="danger">Not accepted</Badge>;
    case 'diverged':
      return <Badge tone="warn">Changed upstream too</Badge>;
    default:
      return <Badge tone="outline">Only in this fork</Badge>;
  }
}

const OUTCOME_TONE: Record<ForkCheck['outcome'], string> = {
  'keep-using-fork': 'border-line bg-surface-2',
  'sync-fork': 'border-warn/40 bg-warn-soft',
  'resolve-conflicts': 'border-danger/40 bg-danger-soft',
  'switch-to-draft': 'border-ok/40 bg-ok-soft',
  'switch-to-release': 'border-ok/40 bg-ok-soft',
  'fork-closed': 'border-line bg-surface-2',
  'recreate-fork': 'border-warn/40 bg-warn-soft',
};

/** Fork changes that can't be carried onto upstream as they are, each with a way out. */
function Conflicts({ conflicts, onDiscard, pending }: { conflicts: ForkConflict[]; onDiscard?: (c: ForkConflict) => void; pending?: boolean }) {
  return (
    <ul aria-label="Conflicts with upstream" className="mt-3 space-y-2">
      {conflicts.map((c, i) => (
        <li key={`${c.iri ?? ''}-${i}`} className="flex flex-wrap items-start gap-2 rounded-lg border border-line bg-surface p-3 text-sm">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
          <span className="min-w-0 flex-1">{c.message}</span>
          {onDiscard && (c.discard?.length || c.iri) && (
            <Button size="sm" variant="ghost" icon={Undo2} loading={pending} onClick={() => onDiscard(c)}>
              Discard my change to {(c.discardLabels ?? [c.curie ?? 'this term']).join(', ')}
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}

/** The same advice an agent gets at the start of a session, without the tool names (forPeople). */
function NextSteps({ check, onDiscard, pending }: { check: ForkCheck; onDiscard?: (c: ForkConflict) => void; pending?: boolean }) {
  const Icon =
    check.outcome === 'switch-to-release' || check.outcome === 'switch-to-draft' ? CircleCheck : check.outcome === 'sync-fork' ? RefreshCw : check.outcome === 'resolve-conflicts' ? TriangleAlert : Info;
  return (
    <section aria-label="What to do next" className={cx('rounded-xl border p-4', OUTCOME_TONE[check.outcome])}>
      <div className="flex items-start gap-3">
        <Icon className="mt-0.5 size-5 shrink-0" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="font-medium">{forPeople(check.message)}</p>
          {check.steps.length > 0 && (
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-muted">
              {check.steps.map((s) => (
                <li key={s}>{forPeople(s)}</li>
              ))}
            </ol>
          )}
          {check.conflicts.length > 0 && <Conflicts conflicts={check.conflicts} onDiscard={onDiscard} pending={pending} />}
          {check.replace.length > 0 && (
            <div className="mt-3 rounded-lg border border-line bg-surface p-3 text-xs">
              <div className="mb-1 font-medium">Replace in your imports</div>
              <div className="flex flex-wrap items-center gap-2 font-mono break-all">
                <span>{check.replace[0].from}</span>
                <ArrowRight className="size-3.5 shrink-0" aria-label="with" />
                <span>{check.replace[0].to}</span>
                <CopyButton text={check.replace[0].to} variant="ghost" />
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function AddTerms({ onDone }: { onDone: () => void }) {
  const { id } = useOntology();
  const { forkSlug = '' } = useParams();
  const [text, setText] = useState('');
  const [result, setResult] = useState<string>();
  const add = useAction(async () => {
    const r = await api.editFork(id, forkSlug, { description: text.trim() });
    const check = r.validation.reasoner === 'owl' ? 'The OWL reasoner confirms the ontology is still logically consistent.' : 'Checked with the structural reasoner only (the full OWL reasoner gave no verdict this time).';
    setResult(`Added ${r.terms.map((t) => t.curie).join(', ') || 'the edits'}. ${r.validation.consistent ? check : ''}`);
    setText('');
    onDone();
  });
  return (
    <Card className="p-5">
      <h3 className="mb-1 text-sm font-semibold">Add terms</h3>
      <p className="mb-3 text-sm text-muted">Describe what you need. Concord drafts the OWL, checks it stays consistent, and it is live at the fork's URL straight away.</p>
      <Textarea
        aria-label="Terms to add"
        rows={3}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="e.g. Add a class called Volunteering Activity as a subclass of vol:Session"
      />
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button variant="primary" icon={Sparkles} loading={add.pending} disabled={!text.trim()} onClick={() => void add.run()}>
          Add to fork
        </Button>
        {result && !add.pending && <span className="text-sm text-ok">{result}</span>}
      </div>
      <InlineError error={add.error} />
    </Card>
  );
}

export function ForkPage() {
  const { forkSlug = '' } = useParams();
  const { id, ontology, reload } = useOntology();
  const { session, now } = useSession();
  const state = useAsync(() => api.fork(id, forkSlug), [id, forkSlug], { keep: `fork|${id}|${forkSlug}` });
  const check = useAsync(() => api.checkFork(id, forkSlug), [id, forkSlug, state.data?.head, state.data?.status]);
  const [notice, setNotice] = useState<string>();
  const [syncConflicts, setSyncConflicts] = useState<ForkConflict[]>([]);
  const act = useAction(async (fn: () => Promise<string | undefined>) => {
    setSyncConflicts([]);
    setNotice(await fn());
    await state.reload();
    void reload();
  });
  const discard = (c: ForkConflict) => {
    // The conflict says which of the fork's changes cause it (an edit can reach a term indirectly).
    const terms = c.discard ?? (c.iri ? [c.iri] : []);
    const names = (c.discardLabels ?? [c.curie ?? c.iri ?? 'this term']).join(', ');
    if (!terms.length) return;
    if (window.confirm(`Discard this fork's change to ${names}? The fork goes back to upstream's version; you can redo the change after syncing.`))
      void act.run(async () => {
        const after = f.behindBy ? ' Now sync with upstream.' : '';
        try {
          await api.discardForkChanges(id, forkSlug, terms);
        } catch (err) {
          // The same edit also changed other terms: say which, and only go ahead if confirmed.
          const message = (err as Error).message ?? '';
          if (!/^The same edit also changed/.test(message) || !window.confirm(`${message.replace(/ Discard them as well.*$/, '')} Discard all of them?`)) throw err;
          await api.discardForkChanges(id, forkSlug, terms, true);
          return `Discarded the edit to ${names} and the other changes made with it.${after}`;
        }
        return `Discarded the change to ${names}.${after}`;
      });
  };
  const sync = () =>
    void act.run(async () => {
      const r = await api.syncFork(id, forkSlug);
      setSyncConflicts(r.conflicts);
      return r.message;
    });

  if (state.error && !state.data) return <ErrorCard error={state.error} onRetry={state.reload} />;
  if (!state.data) return <Loading />;
  const f: ForkDetail = state.data;
  const isOwner = !!session?.user && (session.user.id === f.ownerId || !!session.user.isPlatformAdmin);
  // Forks made before generated provenance had its own property can only be read, downloaded and closed.
  const editable = f.status !== 'closed' && f.provenanceFormat === 2;
  const cr = f.changeRequest;
  const crOpen = cr && ['draft', 'triage', 'review', 'voting', 'approved', 'needs-work'].includes(cr.status);
  // Terms whose fork version isn't upstream or in the open change request (including edits made since proposing).
  const toPropose = f.terms.some((t) => t.upstream === 'not-proposed' || t.upstream === 'rejected' || t.upstream === 'diverged');
  const conflicted = check.data?.outcome === 'resolve-conflicts';

  return (
    <div>
      <Link to={`/o/${id}/forks`} className="mb-4 inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
        <ArrowLeft className="size-4" /> Forks
      </Link>
      <div className="mb-5">
        <div className="flex flex-wrap items-center gap-2">
          <GitFork className="size-5 text-muted" aria-hidden />
          <h2 className="text-xl font-semibold">{f.title}</h2>
          <ForkStatusBadge status={f.status} />
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
          <span className="flex items-center gap-1.5">
            <Avatar name={f.owner?.name} src={f.owner?.avatarUrl} size={18} simulated={f.owner?.simulated} /> {f.owner?.name ?? 'Unknown'}
            {session?.user?.id === f.ownerId && ' (you)'}
          </span>
          <span>
            Fork of {ontology.title} v{f.baseVersion}
          </span>
          <span>updated {relativeTime(f.updatedAt, now())}</span>
        </div>
        {f.purpose && <p className="mt-2 max-w-3xl text-sm">{f.purpose}</p>}
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-6">
          {check.data && <NextSteps check={check.data} onDiscard={isOwner && editable ? discard : undefined} pending={act.pending} />}

          <Card>
            <CardHeader title={`Terms in this fork (${f.terms.length})`} subtitle="New terms use the standard's own namespace, so your data stays valid when they land upstream." />
            {f.terms.length ? (
              <ul className="divide-y divide-line">
                {f.terms.map((t) => (
                  <li key={t.iri} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3">
                    <code className="font-mono text-sm">{t.curie}</code>
                    {t.label && <span className="text-sm text-muted">{t.label}</span>}
                    <span className="text-xs text-subtle">
                      {KIND_LABEL[t.kind] ?? t.kind} · {t.change === 'added' ? 'new' : t.change === 'removed' ? 'removed' : 'changed'}
                    </span>
                    <span className="ml-auto">
                      <UpstreamChip t={t} />
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-5 pb-5 text-sm text-muted">No edits yet. {isOwner ? 'Add the terms your application needs below.' : ''}</p>
            )}
          </Card>

          {isOwner && editable && <AddTerms onDone={() => void state.reload()} />}

          <Card>
            <CardHeader title="History" />
            <ol className="divide-y divide-line">
              {f.history.map((h) => (
                <li key={h.sha} className="flex flex-wrap items-baseline gap-x-3 px-5 py-2.5 text-sm">
                  <span className="min-w-0 flex-1">{h.subject}</span>
                  <span className="text-xs text-muted">
                    {h.author} · {formatDate(h.date, true)}
                  </span>
                </li>
              ))}
            </ol>
          </Card>
        </div>

        <aside className="space-y-6">
          <Card className="p-5">
            <h3 className="mb-1 text-sm font-semibold">Use it in your application</h3>
            <p className="mb-3 text-xs text-muted">Import the fork instead of the release while you develop. The URL always serves the fork's latest revision.</p>
            <div className="flex items-center gap-1.5 rounded-lg border border-line bg-surface-2 px-2.5 py-1.5">
              <code className="min-w-0 flex-1 truncate font-mono text-xs" title={f.urls.iri}>
                {f.urls.iri}
              </code>
              <CopyButton text={f.urls.iri} variant="ghost" />
            </div>
            <p className="mt-2 text-xs text-muted">
              Version <span className="font-mono">{f.version}</span>
            </p>
            <ForkFormats formats={f.urls.formats} />
            <p className="mt-3 text-xs text-muted">
              Coding agents can do all of this too.{' '}
              <Link to={`/o/${id}/connect`} className="text-accent hover:underline">
                Connect an agent
              </Link>
            </p>
          </Card>

          <Card className="p-5">
            <h3 className="mb-2 text-sm font-semibold">Upstream</h3>
            {cr ? (
              <Link to={`/o/${id}/changes/${cr.id}`} className="flex items-start gap-2 rounded-lg border border-line p-3 hover:bg-surface-2">
                <GitPullRequest className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
                <span className="min-w-0 flex-1 text-sm">
                  <span className="text-muted">#{cr.number}</span> {cr.title}
                  <span className="mt-1 flex flex-wrap items-center gap-1.5">
                    <StatusPill status={cr.status} />
                    <LevelBadge level={cr.level} />
                  </span>
                </span>
              </Link>
            ) : (
              <p className="text-sm text-muted">Not proposed yet. Proposing opens one change request with all of the fork's edits, reviewed under this standard's governance policy.</p>
            )}
            {f.behindBy > 0 && (
              <p className="mt-3 text-xs text-warn">
                Upstream has {f.behindBy} new commit{f.behindBy === 1 ? '' : 's'} since this fork was {f.revision ? 'last synced' : 'created'}.
              </p>
            )}
            {isOwner && f.status !== 'closed' && (
              <div className="mt-3 flex flex-wrap gap-2">
                {editable && toPropose && !conflicted && (
                  <Button
                    variant="primary"
                    icon={GitPullRequest}
                    loading={act.pending}
                    onClick={() =>
                      void act.run(async () => {
                        const r = await api.proposeFork(id, forkSlug);
                        return crOpen ? `Updated #${r.changeRequest.number} with the fork's latest edits.` : `Opened change request #${r.changeRequest.number}.`;
                      })
                    }
                  >
                    {crOpen ? `Update #${cr!.number}` : 'Propose upstream'}
                  </Button>
                )}
                {editable && f.behindBy > 0 && (
                  <Button icon={RefreshCw} loading={act.pending} onClick={sync}>
                    Sync with upstream
                  </Button>
                )}
                <Button
                  variant="ghost"
                  icon={X}
                  onClick={() => {
                    if (window.confirm('Close this fork? It keeps resolving, so applications that import it will not break.')) void act.run(async () => (await api.closeFork(id, forkSlug), 'Closed the fork.'));
                  }}
                >
                  Close fork
                </Button>
              </div>
            )}
            {notice && !act.pending && (
              <p className="mt-3 text-sm" role="status">
                {notice}
              </p>
            )}
            {syncConflicts.length > 0 && !act.pending && <Conflicts conflicts={syncConflicts} onDiscard={isOwner && editable ? discard : undefined} pending={act.pending} />}
            <InlineError error={act.error} />
          </Card>
        </aside>
      </div>
    </div>
  );
}
