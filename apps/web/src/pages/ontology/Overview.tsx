import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { ShieldCheck, Users } from 'lucide-react';
import { api } from '../../api';
import { useAsync } from '../../lib/hooks';
import { formatDate } from '../../lib/format';
import { ActivityFeed } from '../../components/ActivityFeed';
import { RoleChips } from '../../components/badges';
import { Disclosure } from '../../components/Disclosure';
import { ValidationDetails } from '../../components/Validation';
import { Avatar, Button, Card, CardHeader, ErrorCard, Loading, Stat } from '../../components/ui';
import { useOntology } from './Layout';

export function OverviewTab() {
  const { id, ontology: o, label } = useOntology();
  const validation = useAsync(() => api.validation(id, 'working'), [id]);
  const loc = useLocation();
  const wantsHealth = loc.hash === '#health';
  const healthRef = useRef<HTMLDivElement>(null);
  const [moreActivity, setMoreActivity] = useState(false);
  useEffect(() => {
    if (wantsHealth && validation.data) healthRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [wantsHealth, validation.data]);
  const members = o.members ?? [];
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
      <div className="space-y-6">
        <Card className="p-5">
          <p className="text-sm leading-relaxed">{o.description || <span className="text-muted">No description yet.</span>}</p>
          {o.domain && <p className="mt-2 text-xs text-muted">Domain: {o.domain}</p>}
          <div className="mt-5 grid grid-cols-3 gap-4 border-t border-line pt-4 sm:grid-cols-5">
            <Stat label="Classes" value={o.stats.classes} />
            <Stat label="Properties" value={o.stats.properties} />
            <Stat label="Individuals" value={o.stats.individuals} />
            <Stat label="Use cases" value={o.stats.useCases} />
            <Stat label="Open changes" value={o.stats.openChangeRequests} />
          </div>
        </Card>

        <div id="health" ref={healthRef} className="scroll-mt-20">
          <Card>
            <CardHeader icon={ShieldCheck} title="Health of the working draft" subtitle="Strict OWL lint, reasoner consistency, FAIR checks and competency-question tests." />
            <div className="p-5">
              {validation.error && !validation.data ? (
                <ErrorCard error={validation.error} onRetry={validation.reload} />
              ) : !validation.data ? (
                <Loading label="Validating…" />
              ) : (
                <ValidationDetails
                  report={validation.data}
                  label={label}
                  openLint={wantsHealth}
                  lintNote={
                    <>
                      Lint runs again on every{' '}
                      <Link to={`/o/${id}/changes`} className="text-accent hover:underline">
                        change request
                      </Link>
                      , and errors block approval.
                    </>
                  }
                />
              )}
            </div>
          </Card>
        </div>
      </div>

      <div className="space-y-6">
        <Card>
          <CardHeader
            icon={Users}
            title={`Members (${members.length})`}
            actions={
              <Link to={`/o/${id}/governance#roles`}>
                <Button size="sm" variant="ghost">
                  Manage
                </Button>
              </Link>
            }
          />
          <div className="p-5">
            {members.length ? (
              <>
                <ul className="flex flex-wrap gap-1.5" aria-label="Members">
                  {members.map((m) => (
                    <li key={m.userId}>
                      <Avatar name={m.user?.name ?? m.userId} src={m.user?.avatarUrl} simulated={m.user?.simulated} size={32} />
                    </li>
                  ))}
                </ul>
                <Disclosure className="mt-4" tone="muted" title="Who does what">
                  <ul className="divide-y divide-line">
                    {members.map((m) => (
                      <li key={m.userId} className="py-2.5 first:pt-0">
                        <div className="truncate text-sm font-medium">
                          {m.user?.name ?? m.userId}
                          {o.ownerIds.includes(m.userId) && <span className="ml-1.5 text-xs text-muted">(owner)</span>}
                        </div>
                        {m.user?.organisation && <div className="truncate text-xs text-muted">{m.user.organisation}</div>}
                        <RoleChips roles={m.roles} className="mt-1" />
                      </li>
                    ))}
                  </ul>
                </Disclosure>
              </>
            ) : (
              <p className="text-sm text-muted">No members yet.</p>
            )}
          </div>
        </Card>
        <Card>
          <CardHeader title="Recent activity" />
          <div className="p-2">
            <ActivityFeed ontologyId={id} limit={moreActivity ? 25 : 5} compact />
            <button className="mt-1 w-full rounded-lg px-2 py-1.5 text-xs font-medium text-accent hover:bg-surface-2" onClick={() => setMoreActivity((m) => !m)}>
              {moreActivity ? 'Show less' : 'Show more activity'}
            </button>
          </div>
        </Card>
        <p className="px-1 text-xs text-subtle">
          Governance:{' '}
          <Link to={`/o/${id}/governance`} className="font-medium text-muted hover:underline">
            {o.governance.name}
          </Link>{' '}
          · created {formatDate(o.createdAt)}
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
