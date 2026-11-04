import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { ForkStatus, ForkSummary } from '@concord/shared';
import { GitFork, Plus } from 'lucide-react';
import { api } from '../../api';
import { useAction, useAsync } from '../../lib/hooks';
import { useSession } from '../../lib/session';
import { relativeTime } from '../../lib/format';
import { Avatar, Badge, Button, Card, Dialog, EmptyState, ErrorCard, Field, InlineError, Input, Loading, Textarea } from '../../components/ui';
import { useOntology } from './Layout';

export const FORK_STATUS: Record<ForkStatus, { label: string; tone: 'neutral' | 'accent' | 'ok' | 'warn' | 'outline'; hint: string }> = {
  active: { label: 'In development', tone: 'neutral', hint: 'Being worked on; not proposed upstream yet' },
  proposed: { label: 'Proposed', tone: 'accent', hint: 'Its change request is going through review' },
  merged: { label: 'Merged', tone: 'ok', hint: 'In the working draft, waiting for a release' },
  released: { label: 'Released', tone: 'ok', hint: 'Everything in it is in a published release' },
  closed: { label: 'Closed', tone: 'outline', hint: 'No longer in use; it still resolves' },
};

export function ForkStatusBadge({ status }: { status: ForkStatus }) {
  const s = FORK_STATUS[status];
  return (
    <Badge tone={s.tone} title={s.hint}>
      {s.label}
    </Badge>
  );
}

function NewForkDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { id, ontology } = useOntology();
  const nav = useNavigate();
  const [f, setF] = useState({ name: '', purpose: '' });
  const create = useAction(async () => {
    const fork = await api.createFork(id, { name: f.name.trim(), purpose: f.purpose.trim() || undefined });
    onClose();
    nav(`/o/${id}/forks/${fork.slug}`);
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Fork ${ontology.title}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" icon={GitFork} loading={create.pending} disabled={!f.name.trim()} onClick={() => void create.run()}>
            Create fork
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-muted">
          A fork is your own pre-release of v{ontology.currentVersion}. Add the terms your application needs and import the fork straight away, while the change goes through review.
        </p>
        <Field label="Name">
          <Input autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Volunteer hours" />
        </Field>
        <Field label="What is it for?" hint="Shown to reviewers when you propose it upstream.">
          <Textarea rows={2} value={f.purpose} onChange={(e) => setF({ ...f, purpose: e.target.value })} placeholder="e.g. Logging the hours volunteers give in the Helping Hands app" />
        </Field>
        <InlineError error={create.error} />
      </div>
    </Dialog>
  );
}

function ForkRow({ f }: { f: ForkSummary }) {
  const { id } = useOntology();
  const { now } = useSession();
  const added = f.terms.filter((t) => t.change === 'added').length;
  const changed = f.terms.length - added;
  return (
    <li>
      <Link to={`/o/${id}/forks/${f.slug}`} className="flex items-start gap-3 px-5 py-3.5 hover:bg-surface-2">
        <GitFork className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{f.title}</span>
            <span className="font-mono text-xs text-subtle">{f.version}</span>
          </div>
          {f.purpose && <p className="mt-0.5 line-clamp-1 text-sm text-muted">{f.purpose}</p>}
          <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-muted">
            <span className="inline-flex items-center gap-1">
              <Avatar name={f.owner?.name} src={f.owner?.avatarUrl} size={16} simulated={f.owner?.simulated} /> {f.owner?.name ?? 'someone'}
            </span>
            <span>·</span>
            <span>
              {f.terms.length ? [added && `${added} new term${added === 1 ? '' : 's'}`, changed && `${changed} changed`].filter(Boolean).join(', ') : 'no edits yet'}
            </span>
            {f.changeRequest && (
              <>
                <span>·</span>
                <span>#{f.changeRequest.number}</span>
              </>
            )}
            <span>·</span>
            <span>updated {relativeTime(f.updatedAt, now())}</span>
          </div>
        </div>
        <ForkStatusBadge status={f.status} />
      </Link>
    </li>
  );
}

export function ForksTab() {
  const { id } = useOntology();
  const { session } = useSession();
  const list = useAsync(() => api.forks(id), [id]);
  const [open, setOpen] = useState(false);
  const mine = (list.data ?? []).filter((f) => f.ownerId === session?.user?.id);
  const others = (list.data ?? []).filter((f) => f.ownerId !== session?.user?.id);

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Forks</h2>
          <p className="max-w-2xl text-sm text-muted">
            Personal pre-releases for building applications. Add the terms you need to a fork, import its URL, and keep building while the change is reviewed. Concord tells you when it has
            landed so you can switch back.
          </p>
        </div>
        {session?.user && (
          <Button variant="primary" icon={Plus} onClick={() => setOpen(true)}>
            New fork
          </Button>
        )}
      </div>
      {list.error && !list.data ? (
        <ErrorCard error={list.error} onRetry={list.reload} />
      ) : !list.data ? (
        <Loading />
      ) : !list.data.length ? (
        <EmptyState icon={GitFork} title="No forks yet" action={session?.user ? <Button icon={Plus} onClick={() => setOpen(true)}>New fork</Button> : undefined}>
          Coding agents can create forks too, over MCP (create_fork).
        </EmptyState>
      ) : (
        <div className="space-y-6">
          {mine.length > 0 && (
            <section aria-label="Your forks">
              <h3 className="mb-2 text-sm font-semibold text-muted">Yours</h3>
              <Card>
                <ul className="divide-y divide-line">
                  {mine.map((f) => (
                    <ForkRow key={f.id} f={f} />
                  ))}
                </ul>
              </Card>
            </section>
          )}
          {others.length > 0 && (
            <section aria-label="Other people's forks">
              {mine.length > 0 && <h3 className="mb-2 text-sm font-semibold text-muted">Everyone else's</h3>}
              <Card>
                <ul className="divide-y divide-line">
                  {others.map((f) => (
                    <ForkRow key={f.id} f={f} />
                  ))}
                </ul>
              </Card>
            </section>
          )}
        </div>
      )}
      <NewForkDialog open={open} onClose={() => setOpen(false)} />
    </div>
  );
}
