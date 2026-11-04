import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import type { ChangeRequestStatus } from '@concord/shared';
import { askOf, odiApprovedFromTimeline } from '../../lib/asks';
import { scrollBehavior } from '../../lib/motion';
import { api } from '../../api';
import { useAsync } from '../../lib/hooks';
import { formatDate, plural, relativeTime } from '../../lib/format';
import { useSession } from '../../lib/session';
import { ActivityFeed } from '../../components/ActivityFeed';
import { LevelBadge, RoleChips, StatusPill } from '../../components/badges';
import { Disclosure } from '../../components/Disclosure';
import { ValidationDetails } from '../../components/Validation';
import { Avatar, ErrorCard, Loading } from '../../components/ui';
import { useOntology } from './Layout';

/** Links inside sentences are underlined in every look, so they never rely on colour alone. */
const proseLink = 'text-accent underline decoration-1 underline-offset-[0.18em] hover:decoration-2';

/** Change requests still moving through the process, in the order people need to act on them. */
const IN_PROGRESS: ChangeRequestStatus[] = ['voting', 'review', 'triage', 'needs-work', 'approved'];

/**
 * The ontology's front page. It reads top to bottom like a short report: what this is, what is
 * waiting for you, what is changing, and how healthy the draft is. People and activity sit beside it.
 */
export function OverviewTab() {
  const { id, ontology: o, label, myRoles } = useOntology();
  const { session, now } = useSession();
  const me = session?.user?.id;
  const validation = useAsync(() => api.validation(id, 'working'), [id]);
  const changes = useAsync(() => api.changeRequests(id), [id]);
  const loc = useLocation();
  const wantsHealth = loc.hash === '#health';
  const healthRef = useRef<HTMLElement>(null);
  const [moreActivity, setMoreActivity] = useState(false);
  // loc.key changes on every navigation, so following the report link again (already on #health) still scrolls and reopens lint.
  const healthKey = wantsHealth ? loc.key : undefined;
  useEffect(() => {
    if (!healthKey || !validation.data) return;
    healthRef.current?.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
  }, [healthKey, validation.data]);

  const members = o.members ?? [];
  const inProgress = (changes.data ?? [])
    .filter((cr) => IN_PROGRESS.includes(cr.status))
    .sort((a, b) => IN_PROGRESS.indexOf(a.status) - IN_PROGRESS.indexOf(b.status) || b.updatedAt.localeCompare(a.updatedAt));
  const asks = inProgress.flatMap((cr) => {
    const verb = askOf(cr, o.governance, {
      roles: myRoles,
      me,
      isAdmin: !!session?.user?.isPlatformAdmin,
      odiApproved: odiApprovedFromTimeline(cr, members),
    });
    return verb ? [{ cr, verb }] : [];
  });

  return (
    <div className="grid gap-x-12 gap-y-10 lg:grid-cols-[minmax(0,1fr)_18rem]">
      <div className="min-w-0 space-y-10">
        <section aria-label="About this ontology">
          <p className="max-w-[68ch] text-lg leading-relaxed">{o.description || <span className="text-muted">No description yet.</span>}</p>
          <p className="mt-3 max-w-[68ch] text-sm leading-relaxed text-muted" data-testid="overview-summary">
            <Link to={`/o/${id}/browse`} className={proseLink}>
              {plural(o.stats.classes, 'class', 'classes')} and {plural(o.stats.properties, 'property', 'properties')}
            </Link>
            , drawn from{' '}
            <Link to={`/o/${id}/use-cases`} className={proseLink}>
              {plural(o.stats.useCases, 'use case')}
            </Link>
            . Version {o.currentVersion}
            {o.stats.releases > 0 && (
              <>
                {' '}
                after{' '}
                <Link to={`/o/${id}/releases`} className={proseLink}>
                  {plural(o.stats.releases, 'release')}
                </Link>
              </>
            )}
            , run as{' '}
            <Link to={`/o/${id}/governance`} className={proseLink}>
              {o.governance.name}
            </Link>
            .
          </p>
          <Disclosure className="mt-4 max-w-[68ch] border-t border-line pt-3" tone="muted" title="Ontology details">
            <dl className="grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[9rem_1fr]">
              <Row term="Classes">{o.stats.classes}</Row>
              <Row term="Properties">{o.stats.properties}</Row>
              <Row term="Individuals">{o.stats.individuals}</Row>
              <Row term="Use cases">{o.stats.useCases}</Row>
              <Row term="Releases">{o.stats.releases}</Row>
              <Row term="Ontology IRI">
                <span className="font-mono text-xs break-all">{o.ontologyIRI}</span>
              </Row>
              <Row term="Current version">v{o.currentVersion}</Row>
              {o.domain && <Row term="Domain">{o.domain}</Row>}
              <Row term="Governance">
                <Link to={`/o/${id}/governance`} className={proseLink}>
                  {o.governance.name}
                </Link>
              </Row>
              <Row term="Created">{formatDate(o.createdAt)}</Row>
              {o.github && (
                <Row term="Published to">
                  <a className={proseLink} href={`https://github.com/${o.github.repo}`} target="_blank" rel="noreferrer">
                    github.com/{o.github.repo}
                  </a>
                </Row>
              )}
            </dl>
          </Disclosure>
        </section>

        {asks.length > 0 && (
          <section className="overview-asks bg-accent p-6 text-accent-fg" aria-labelledby="asks-title" data-testid="overview-asks">
            <h2 id="asks-title" className="text-xl font-bold">
              {asks.length === 1 ? 'One change is waiting for you' : `${asks.length} changes are waiting for you`}
            </h2>
            <ul className="mt-3 space-y-1.5">
              {asks.slice(0, 5).map(({ cr, verb }) => (
                <li key={cr.id}>
                  <Link to={`/o/${id}/changes/${cr.id}`} className="underline decoration-1 underline-offset-[0.2em] hover:decoration-2">
                    {verb} #{cr.number}: {cr.title}
                  </Link>
                </li>
              ))}
            </ul>
            {asks.length > 5 && (
              <Link to={`/o/${id}/changes`} className="mt-3 inline-block text-sm underline underline-offset-[0.2em]">
                See all {asks.length}
              </Link>
            )}
          </section>
        )}

        <section aria-labelledby="changes-title">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="changes-title" className="text-xl font-bold">
              Changes in progress
            </h2>
            <Link to={`/o/${id}/changes?status=all`} className="text-sm text-accent hover:underline">
              All change requests
            </Link>
          </div>
          {changes.error && !changes.data ? (
            <ErrorCard className="mt-3" error={changes.error} onRetry={changes.reload} />
          ) : !changes.data ? (
            <Loading className="mt-3" />
          ) : inProgress.length === 0 ? (
            <p className="mt-2 text-sm text-muted">
              Nothing is in progress.{' '}
              <Link to={`/o/${id}/changes`} className={proseLink}>
                Propose a change
              </Link>{' '}
              or{' '}
              <Link to={`/o/${id}/use-cases`} className={proseLink}>
                describe a use case
              </Link>
              .
            </p>
          ) : (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-left text-sm" data-testid="changes-in-progress">
                <thead className="border-b border-fg text-xs text-muted">
                  <tr>
                    <th scope="col" className="py-2 pr-3 font-semibold">
                      Change
                    </th>
                    <th scope="col" className="py-2 pr-3 font-semibold">
                      Stage
                    </th>
                    <th scope="col" className="hidden py-2 pr-3 font-semibold sm:table-cell">
                      Size
                    </th>
                    <th scope="col" className="py-2 text-right font-semibold">
                      Updated
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {inProgress.slice(0, 8).map((cr) => (
                    <tr key={cr.id}>
                      <td className="py-2.5 pr-3">
                        <Link to={`/o/${id}/changes/${cr.id}`} className="hover:text-accent hover:underline">
                          <span className="text-muted">#{cr.number}</span> {cr.title}
                        </Link>
                      </td>
                      <td className="py-2.5 pr-3 whitespace-nowrap">
                        <StatusPill status={cr.status} />
                      </td>
                      <td className="hidden py-2.5 pr-3 sm:table-cell">
                        <LevelBadge level={cr.classification?.level} />
                      </td>
                      <td className="py-2.5 text-right whitespace-nowrap text-muted">{relativeTime(cr.updatedAt, now())}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {inProgress.length > 8 && (
                <Link to={`/o/${id}/changes`} className="mt-2 inline-block text-sm text-accent hover:underline">
                  {inProgress.length - 8} more in progress
                </Link>
              )}
            </div>
          )}
        </section>

        <section id="health" ref={healthRef} className="scroll-mt-20" aria-labelledby="health-title">
          <h2 id="health-title" className="text-xl font-bold">
            Health of the working draft
          </h2>
          <p className="mt-1 text-sm text-muted">Strict OWL lint, reasoner consistency, FAIR checks and competency-question tests, run on every change.</p>
          <div className="mt-4">
            {validation.error && !validation.data ? (
              <ErrorCard error={validation.error} onRetry={validation.reload} />
            ) : !validation.data ? (
              <Loading label="Validating…" />
            ) : (
              <ValidationDetails
                report={validation.data}
                label={label}
                headingLevel={3}
                openLintKey={healthKey}
                lintNote={
                  <>
                    Lint runs again on every{' '}
                    <Link to={`/o/${id}/changes`} className={proseLink}>
                      change request
                    </Link>
                    , and errors block approval.
                  </>
                }
              />
            )}
          </div>
        </section>
      </div>

      <aside className="min-w-0 space-y-10" aria-label="People and activity">
        <section aria-labelledby="members-title" data-testid="overview-members">
          <div className="flex items-baseline justify-between gap-2">
            <h2 id="members-title" className="text-base font-bold">
              Members ({members.length})
            </h2>
            <Link to={`/o/${id}/governance#roles`} className="text-sm text-accent hover:underline">
              Manage
            </Link>
          </div>
          {members.length ? (
            <>
              <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Members">
                {members.slice(0, 14).map((m) => (
                  <li key={m.userId}>
                    <Avatar name={m.user?.name ?? m.userId} src={m.user?.avatarUrl} simulated={m.user?.simulated} size={32} />
                  </li>
                ))}
              </ul>
              {members.length > 14 && <p className="mt-2 text-sm text-muted">and {members.length - 14} more</p>}
              <Disclosure className="mt-3" tone="muted" title="Who does what">
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
            <p className="mt-2 text-sm text-muted">No members yet.</p>
          )}
        </section>

        <section aria-labelledby="activity-title" data-testid="overview-activity">
          <h2 id="activity-title" className="text-base font-bold">
            Recent activity
          </h2>
          <div className="-mx-2 mt-2">
            <ActivityFeed ontologyId={id} limit={moreActivity ? 50 : 3} compact />
          </div>
          <button className="mt-1 text-sm text-accent hover:underline" onClick={() => setMoreActivity((m) => !m)}>
            {moreActivity ? 'Show less' : 'Show more activity'}
          </button>
        </section>
      </aside>
    </div>
  );
}

function Row({ term, children }: { term: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted">{term}</dt>
      <dd>{children}</dd>
    </>
  );
}
