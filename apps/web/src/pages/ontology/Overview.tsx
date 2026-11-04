import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { ShieldCheck, Users } from 'lucide-react';
import { api } from '../../api';
import { useAsync } from '../../lib/hooks';
import { formatDate, plural } from '../../lib/format';
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
  // loc.key changes on every navigation, so following the report link again (already on #health) still scrolls and reopens lint.
  const healthKey = wantsHealth ? loc.key : undefined;
  useEffect(() => {
    if (healthKey && validation.data) healthRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [healthKey, validation.data]);
  const members = o.members ?? [];
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
      <div className="space-y-6">
        <Card className="p-5">
          <p className="text-sm leading-relaxed">{o.description || <span className="text-muted">No description yet.</span>}</p>
          <Disclosure
            className="mt-4 border-t border-line pt-3"
            tone="muted"
            title="Ontology details"
            summary={`${plural(o.stats.classes, 'class', 'classes')}, ${plural(o.stats.properties, 'property', 'properties')}, ${plural(o.stats.useCases, 'use case')}`}
          >
            <div className="grid grid-cols-3 gap-4 sm:grid-cols-5">
              <Stat label="Classes" value={o.stats.classes} />
              <Stat label="Properties" value={o.stats.properties} />
              <Stat label="Individuals" value={o.stats.individuals} />
              <Stat label="Use cases" value={o.stats.useCases} />
              <Stat label="Releases" value={o.stats.releases} />
            </div>
            <dl className="mt-4 grid gap-x-4 gap-y-1.5 text-xs sm:grid-cols-[8rem_1fr]">
              <dt className="text-muted">Ontology IRI</dt>
              <dd className="font-mono break-all">{o.ontologyIRI}</dd>
              <dt className="text-muted">Current version</dt>
              <dd>v{o.currentVersion}</dd>
              {o.domain && (
                <>
                  <dt className="text-muted">Domain</dt>
                  <dd>{o.domain}</dd>
                </>
              )}
              <dt className="text-muted">Governance</dt>
              <dd>
                <Link to={`/o/${id}/governance`} className="font-medium text-accent hover:underline">
                  {o.governance.name}
                </Link>
              </dd>
              <dt className="text-muted">Created</dt>
              <dd>{formatDate(o.createdAt)}</dd>
              {o.github && (
                <>
                  <dt className="text-muted">Published to</dt>
                  <dd>
                    <a className="text-accent hover:underline" href={`https://github.com/${o.github.repo}`} target="_blank" rel="noreferrer">
                      github.com/{o.github.repo}
                    </a>
                  </dd>
                </>
              )}
            </dl>
          </Disclosure>
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
                  openLintKey={healthKey}
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
            <ActivityFeed ontologyId={id} limit={moreActivity ? 50 : 3} compact />
            <button className="mt-1 w-full rounded-lg px-2 py-1.5 text-xs font-medium text-accent hover:bg-surface-2" onClick={() => setMoreActivity((m) => !m)}>
              {moreActivity ? 'Show less' : 'Show more activity'}
            </button>
          </div>
        </Card>
      </div>
    </div>
  );
}
