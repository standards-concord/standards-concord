import { Link } from 'react-router';
import type { LifecycleStage } from '@concord/shared';
import { Check, ShieldCheck, Users } from 'lucide-react';
import { api } from '../../api';
import { useAsync } from '../../lib/hooks';
import { formatDate } from '../../lib/format';
import { ActivityFeed } from '../../components/ActivityFeed';
import { RoleChips } from '../../components/badges';
import { CqResults, FairChecks, ReasonerResult, ValidationSummary } from '../../components/Validation';
import { Avatar, Badge, Button, Card, CardHeader, ErrorCard, Loading, Stat, cx } from '../../components/ui';
import { useOntology } from './Layout';

const STAGES: { id: LifecycleStage; label: string; hint: string }[] = [
  { id: 'discovery', label: 'Discovery', hint: 'Gathering use cases and competency questions' },
  { id: 'drafting', label: 'Drafting', hint: 'Turning requirements into classes and properties' },
  { id: 'review', label: 'Review', hint: 'Community review of the first version' },
  { id: 'released', label: 'Released', hint: 'A published version exists' },
  { id: 'maintenance', label: 'Maintenance', hint: 'Governed changes and periodic releases' },
];

export function LifecycleStepper({ stage }: { stage: LifecycleStage }) {
  const idx = STAGES.findIndex((s) => s.id === stage);
  if (stage === 'retired') return <Badge tone="neutral">Retired</Badge>;
  return (
    <ol className="grid grid-cols-5 gap-1.5">
      {STAGES.map((s, i) => (
        <li key={s.id} className="min-w-0" title={s.hint}>
          <div className={cx('h-1.5 rounded-full', i <= idx ? 'bg-accent' : 'bg-surface-2')} />
          <div className={cx('mt-1.5 flex items-center gap-1 truncate text-xs', i === idx ? 'font-semibold text-fg' : 'text-muted')}>
            {i < idx && <Check className="size-3 shrink-0 text-accent" />}
            {s.label}
          </div>
        </li>
      ))}
    </ol>
  );
}

export function OverviewTab() {
  const { id, ontology: o, label } = useOntology();
  const validation = useAsync(() => api.validation(id, 'working'), [id]);
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
      <div className="space-y-6">
        <Card className="p-5">
          <p className="text-sm leading-relaxed">{o.description || <span className="text-muted">No description yet.</span>}</p>
          {o.domain && <p className="mt-2 text-xs text-muted">Domain: {o.domain}</p>}
          <div className="mt-5">
            <LifecycleStepper stage={o.stage} />
          </div>
          <div className="mt-5 grid grid-cols-3 gap-4 border-t border-line pt-4 sm:grid-cols-6">
            <Stat label="Version" value={`v${o.currentVersion}`} />
            <Stat label="Classes" value={o.stats.classes} />
            <Stat label="Properties" value={o.stats.properties} />
            <Stat label="Individuals" value={o.stats.individuals} />
            <Stat label="Use cases" value={o.stats.useCases} />
            <Stat label="Open changes" value={o.stats.openChangeRequests} />
          </div>
        </Card>

        <Card>
          <CardHeader icon={ShieldCheck} title="Health of the working draft" subtitle="Lint against strict OWL best practice, reasoner consistency, FAIR score and competency-question tests." />
          <div className="space-y-5 p-5">
            {validation.error && !validation.data ? (
              <ErrorCard error={validation.error} onRetry={validation.reload} />
            ) : !validation.data ? (
              <Loading label="Validating…" />
            ) : (
              <>
                <ValidationSummary report={validation.data} />
                <ReasonerResult report={validation.data} label={label} />
                <div className="grid gap-6 md:grid-cols-2">
                  <div>
                    <h4 className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">FAIR checks</h4>
                    <FairChecks report={validation.data} />
                  </div>
                  <div>
                    <h4 className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">Competency questions</h4>
                    <CqResults report={validation.data} />
                  </div>
                </div>
                {validation.data.lint.length > 0 && (
                  <p className="text-xs text-muted">
                    {validation.data.lint.length} lint findings —{' '}
                    <Link to={`/o/${id}/changes`} className="text-accent hover:underline">
                      they’re checked on every change request
                    </Link>
                    .
                  </p>
                )}
              </>
            )}
          </div>
        </Card>
      </div>

      <div className="space-y-6">
        <Card>
          <CardHeader
            icon={Users}
            title={`Members (${o.members?.length ?? 0})`}
            actions={
              <Link to={`/o/${id}/governance#roles`}>
                <Button size="sm" variant="ghost">
                  Manage
                </Button>
              </Link>
            }
          />
          <ul className="divide-y divide-line">
            {(o.members ?? []).map((m) => (
              <li key={m.userId} className="flex items-start gap-3 px-5 py-3">
                <Avatar name={m.user?.name} src={m.user?.avatarUrl} simulated={m.user?.simulated} size={30} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">
                    {m.user?.name ?? m.userId}
                    {o.ownerIds.includes(m.userId) && <span className="ml-1.5 text-xs text-muted">(owner)</span>}
                  </div>
                  {m.user?.organisation && <div className="truncate text-xs text-muted">{m.user.organisation}</div>}
                  <RoleChips roles={m.roles} className="mt-1" />
                </div>
              </li>
            ))}
            {!o.members?.length && <li className="px-5 py-4 text-sm text-muted">No members yet.</li>}
          </ul>
        </Card>
        <Card>
          <CardHeader title="Recent activity" />
          <div className="p-2">
            <ActivityFeed ontologyId={id} limit={10} compact />
          </div>
        </Card>
        <p className="px-1 text-xs text-subtle">
          Governance: <strong className="font-medium text-muted">{o.governance.name}</strong> · created {formatDate(o.createdAt)}
          {o.github && (
            <>
              {' '}
              · <a className="text-accent hover:underline" href={`https://github.com/${o.github.repo}`} target="_blank" rel="noreferrer">github.com/{o.github.repo}</a>
            </>
          )}
        </p>
      </div>
    </div>
  );
}
