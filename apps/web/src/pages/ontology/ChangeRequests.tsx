import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import type { ChangeRequestKind, ChangeRequestStatus } from '@concord/shared';
import { Bug, GitPullRequest, Plus } from 'lucide-react';
import { api } from '../../api';
import { useAction, useAsync } from '../../lib/hooks';
import { useSession } from '../../lib/session';
import { relativeTime } from '../../lib/format';
import { CR_STATUS_LABEL, LevelBadge, OriginIcon, StatusPill } from '../../components/badges';
import { BugReportDialog } from '../../components/BugReport';
import { Button, Card, Chip, Dialog, EmptyState, ErrorCard, Field, InlineError, Input, Loading, Select, Textarea } from '../../components/ui';
import { useOntology } from './Layout';

const FILTERS: (ChangeRequestStatus | 'open' | 'all')[] = ['open', 'draft', 'review', 'voting', 'approved', 'needs-work', 'merged', 'released', 'all'];
const OPEN: ChangeRequestStatus[] = ['draft', 'triage', 'review', 'voting', 'approved', 'needs-work'];

const KINDS: { id: ChangeRequestKind; label: string }[] = [
  { id: 'feature', label: 'New capability' },
  { id: 'gap', label: 'Fill a gap' },
  { id: 'editorial', label: 'Editorial (labels, definitions)' },
  { id: 'deprecation', label: 'Deprecation' },
  { id: 'bug', label: 'Bug fix' },
];

function NewChangeRequestDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { id } = useOntology();
  const nav = useNavigate();
  const [f, setF] = useState({ title: '', description: '', naturalLanguage: '', kind: 'feature' as ChangeRequestKind });
  const create = useAction(async () => {
    const cr = await api.createChangeRequest(id, {
      title: f.title.trim(),
      description: f.description.trim(),
      kind: f.kind,
      naturalLanguage: f.naturalLanguage.trim() || f.description.trim(),
    });
    onClose();
    nav(`/o/${id}/changes/${cr.id}`);
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New change request"
      wide
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={create.pending} disabled={!f.title.trim() || !(f.naturalLanguage.trim() || f.description.trim())} onClick={() => void create.run()}>
            {create.pending ? 'Drafting changes…' : 'Create and draft changes'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Title">
          <Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="e.g. Model volunteer shifts" />
        </Field>
        <Field label="Kind">
          <Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as ChangeRequestKind })}>
            {KINDS.map((k) => (
              <option key={k.id} value={k.id}>
                {k.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Why is this needed?" hint="Context for reviewers: who needs it, and for what.">
          <Textarea rows={3} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </Field>
        <Field label="Describe the change in plain language" hint="Concord drafts the precise OWL changes from this; you can review and revise them before submitting.">
          <Textarea
            rows={4}
            value={f.naturalLanguage}
            onChange={(e) => setF({ ...f, naturalLanguage: e.target.value })}
            placeholder="e.g. Add a Shift class: a scheduled period when a volunteer performs a role at a location. A shift has a start and end time and is for one Role."
          />
        </Field>
        <InlineError error={create.error} />
      </div>
    </Dialog>
  );
}

export function ChangeRequestsTab() {
  const { id, userById } = useOntology();
  const { now } = useSession();
  const [params, setParams] = useSearchParams();
  const filter = (params.get('status') ?? 'open') as (typeof FILTERS)[number];
  const list = useAsync(() => api.changeRequests(id, filter === 'open' || filter === 'all' ? undefined : filter), [id, filter]);
  const [dialog, setDialog] = useState<'new' | 'bug'>();
  const rows = (list.data ?? []).filter((cr) => (filter === 'open' ? OPEN.includes(cr.status) : true)).sort((a, b) => b.number - a.number);

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Change requests</h2>
          <p className="max-w-2xl text-sm text-muted">Every change is classified (patch / minor / major), validated, and reviewed according to the governance policy.</p>
        </div>
        <div className="flex gap-2">
          <Button icon={Bug} onClick={() => setDialog('bug')}>
            Report a bug
          </Button>
          <Button variant="primary" icon={Plus} onClick={() => setDialog('new')}>
            New change request
          </Button>
        </div>
      </div>
      <div className="mb-4 flex flex-wrap gap-1.5">
        {FILTERS.map((s) => (
          <Chip
            key={s}
            active={filter === s}
            onClick={() => {
              const n = new URLSearchParams(params);
              n.set('status', s);
              setParams(n, { replace: true });
            }}
          >
            {s === 'open' ? 'Open' : s === 'all' ? 'All' : CR_STATUS_LABEL[s]}
          </Chip>
        ))}
      </div>
      {list.error && !list.data ? (
        <ErrorCard error={list.error} onRetry={list.reload} />
      ) : !list.data ? (
        <Loading />
      ) : !rows.length ? (
        <EmptyState icon={GitPullRequest} title={filter === 'open' ? 'No open change requests' : 'Nothing here'} action={<Button icon={Plus} onClick={() => setDialog('new')}>New change request</Button>}>
          Change requests also come from use cases (Synthesise), meetings, coding agents and bug reports.
        </EmptyState>
      ) : (
        <Card>
          <ul className="divide-y divide-line">
            {rows.map((cr) => (
              <li key={cr.id}>
                <Link to={`/o/${id}/changes/${cr.id}`} className="flex items-start gap-3 px-5 py-3.5 hover:bg-surface-2">
                  <span className="mt-0.5">
                    <OriginIcon origin={cr.origin} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{cr.title}</span>
                      <LevelBadge level={cr.classification?.level} />
                    </div>
                    <div className="mt-0.5 text-xs text-muted">
                      #{cr.number} · {userById(cr.authorId)?.name ?? 'someone'} · {cr.ops.length} change{cr.ops.length === 1 ? '' : 's'} · updated {relativeTime(cr.updatedAt, now())}
                    </div>
                  </div>
                  <StatusPill status={cr.status} />
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <NewChangeRequestDialog open={dialog === 'new'} onClose={() => setDialog(undefined)} />
      <BugReportDialog open={dialog === 'bug'} onClose={() => setDialog(undefined)} ontologyId={id} />
    </div>
  );
}
