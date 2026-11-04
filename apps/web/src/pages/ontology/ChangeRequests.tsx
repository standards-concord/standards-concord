import { useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import type { ChangeRequestKind, ChangeRequestStatus } from '@concord/shared';
import { Bug, GitPullRequest, Globe, Plus } from 'lucide-react';
import { api } from '../../api';
import { useAction, useAsync } from '../../lib/hooks';
import { useSession } from '../../lib/session';
import { relativeTime } from '../../lib/format';
import { CR_STATUS_LABEL, LevelBadge, OriginIcon, StatusPill } from '../../components/badges';
import { BugReportDialog } from '../../components/BugReport';
import { Button, Card, Chip, Dialog, EmptyState, ErrorCard, Field, InlineError, Input, Loading, Select, Textarea, cx } from '../../components/ui';
import { useOntology } from './Layout';

/** Every status, in the order a request moves through them; Open and All are the two scopes. */
const STATUSES: ChangeRequestStatus[] = ['draft', 'triage', 'review', 'voting', 'needs-work', 'approved', 'merged', 'released', 'rejected', 'withdrawn'];
const FILTERS: (ChangeRequestStatus | 'open' | 'all')[] = ['open', 'all', ...STATUSES];
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

/**
 * Reports from the public page, held for review. Shown as plain text (never
 * rendered), only to editors, stewards and owners; nothing happens to one
 * until it's opened as a bug report or dismissed.
 */
function PublicReports() {
  const { id, hasRole } = useOntology();
  const nav = useNavigate();
  const { now } = useSession();
  const moderator = hasRole('editor', 'steward', 'owner');
  const reports = useAsync(() => (moderator ? api.publicReports(id) : Promise.resolve([])), [id, moderator]);
  const heading = useRef<HTMLHeadingElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  // What the last action did, for screen readers; and whether to keep the panel after its last report goes.
  const [status, setStatus] = useState('');
  const accept = useAction(async (reportId: string) => {
    const cr = await api.acceptPublicReport(id, reportId);
    nav(`/o/${id}/changes/${cr.id}`);
  });
  const dismiss = useAction(async (reportId: string) => {
    const at = reports.data?.findIndex((r) => r.id === reportId) ?? 0;
    await api.dismissPublicReport(id, reportId);
    await reports.reload();
    setStatus('Report dismissed.');
    // The focused button went with its report: move to the report that took its place, or the heading.
    requestAnimationFrame(() => {
      const items = listRef.current?.querySelectorAll<HTMLElement>('[data-public-report]') ?? [];
      const next = items[Math.min(at, items.length - 1)]?.querySelector<HTMLElement>('button');
      (next ?? heading.current)?.focus();
    });
  });
  if (!moderator) return null;
  if (reports.error && !reports.data)
    return <ErrorCard className="mb-6" title="Couldn’t load reports from the public page" error={reports.error} onRetry={() => void reports.reload()} />;
  // Nothing to show until loaded, or when there's nothing to review (unless the last one was just dealt with here).
  if (!reports.data || (!reports.data.length && !status)) return null;
  return (
    <section aria-labelledby="public-reports-h" className="mb-6">
      <Card>
        <div className="border-b border-line px-5 py-3.5">
          <h3 id="public-reports-h" ref={heading} tabIndex={-1} className="flex items-center gap-2 font-semibold outline-none">
            <Globe className="h-4 w-4 text-muted" aria-hidden="true" />
            Reports from the public page <span className="text-sm font-normal text-muted">({reports.data.length} to review)</span>
          </h3>
          <p className="mt-0.5 text-sm text-muted">Sent without an account. Only editors, stewards and owners see these. Open one as a bug report to discuss it, or dismiss it.</p>
        </div>
        <p role="status" className="sr-only">
          {status}
        </p>
        {reports.data.length ? (
          <ul ref={listRef} className="divide-y divide-line">
            {reports.data.map((r) => (
              <li key={r.id} className="px-5 py-3.5" data-public-report>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium">{r.title || `Problem with ${r.termName}`}</span>
                  <span className="text-xs text-muted">
                    <Link className="text-accent hover:underline" to={`/o/${id}/browse?term=${encodeURIComponent(r.termIri)}`}>
                      {r.termName}
                    </Link>{' '}
                    · {r.version === 'draft' ? 'working draft' : `version ${r.version}`} · {relativeTime(r.createdAt, now())}
                  </span>
                </div>
                <p className="mt-1.5 whitespace-pre-wrap break-words text-sm">{r.description}</p>
                <div className="mt-2.5 flex gap-2">
                  <Button size="sm" variant="primary" icon={Bug} loading={accept.pending} onClick={() => void accept.run(r.id)}>
                    Open as bug report
                  </Button>
                  <Button size="sm" variant="ghost" loading={dismiss.pending} onClick={() => void dismiss.run(r.id)}>
                    Dismiss
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-5 py-3.5 text-sm text-muted" data-public-reports-empty>
            No reports left to review.
          </p>
        )}
        {reports.error ? (
          <div className="px-5 pb-3">
            <InlineError error={reports.error} />
          </div>
        ) : null}
        <div className="px-5 pb-3">
          <InlineError error={accept.error ?? dismiss.error} />
        </div>
      </Card>
    </section>
  );
}

export function ChangeRequestsTab() {
  const { id, userById } = useOntology();
  const { now } = useSession();
  const [params, setParams] = useSearchParams();
  const filter = (params.get('status') ?? 'open') as (typeof FILTERS)[number];
  const list = useAsync(() => api.changeRequests(id, filter === 'open' || filter === 'all' ? undefined : filter), [id, filter]);
  const [dialog, setDialog] = useState<'new' | 'bug'>();
  const setFilter = (s: (typeof FILTERS)[number]) => {
    const n = new URLSearchParams(params);
    n.set('status', s);
    setParams(n, { replace: true });
  };
  const isStatus = filter !== 'open' && filter !== 'all';
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
      <PublicReports />
      <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2" role="group" aria-label="Filter change requests">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium text-muted">Show</span>
          {(['open', 'all'] as const).map((s) => (
            <Chip key={s} active={filter === s} onClick={() => setFilter(s)}>
              {s === 'open' ? 'Open' : 'All'}
            </Chip>
          ))}
        </div>
        <label className="flex items-center gap-1.5">
          <span className="text-xs font-medium text-muted">Status</span>
          <Select
            value={isStatus ? filter : ''}
            onChange={(e) => setFilter((e.target.value || 'all') as (typeof FILTERS)[number])}
            className={cx('h-8 w-40 py-0 text-xs', isStatus && 'border-accent text-accent')}
          >
            <option value="">{filter === 'open' ? 'Any open status' : 'Any status'}</option>
            {STATUSES.map((st) => (
              <option key={st} value={st}>
                {CR_STATUS_LABEL[st]}
              </option>
            ))}
          </Select>
        </label>
        {list.data && (
          <p className="text-xs text-muted" aria-live="polite">
            {isStatus ? (
              <>
                {rows.length} {CR_STATUS_LABEL[filter as ChangeRequestStatus].toLowerCase()} ·{' '}
                <button className="font-medium text-accent hover:underline" onClick={() => setFilter('open')}>
                  Clear
                </button>
              </>
            ) : (
              `${rows.length} ${filter === 'open' ? 'open' : 'in total'}`
            )}
          </p>
        )}
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
