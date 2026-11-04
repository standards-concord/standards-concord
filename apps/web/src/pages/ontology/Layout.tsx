import { createContext, useContext, useMemo } from 'react';
import { Link, NavLink, Outlet, useLocation, useParams } from 'react-router';
import type { OntologyView, Role, User } from '@concord/shared';
import { api, type OntologyDetail } from '../../api';
import { useAsync, type AsyncState } from '../../lib/hooks';
import { useSession } from '../../lib/session';
import { makeLabeler, type Labeler } from '../../lib/ontology';
import { HealthBubble, LifecycleBubble } from '../../components/Phase';
import { Badge, ErrorCard, Loading, cx } from '../../components/ui';

interface OntologyCtx {
  id: string;
  ontology: OntologyDetail;
  reload: () => Promise<void>;
  view: AsyncState<OntologyView>;
  label: Labeler;
  myRoles: Role[];
  userById: (id?: string) => User | undefined;
  hasRole: (...roles: Role[]) => boolean;
}

const Ctx = createContext<OntologyCtx | null>(null);

export function useOntology() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useOntology outside OntologyLayout');
  return c;
}

/**
 * The ontology's pages, grouped into five sections so the top-level navigation stays short.
 * URLs are unchanged; `also` lists extra path segments that belong to a section.
 */
export const SECTIONS: { label: string; tabs: [path: string, label: string][]; also?: string[] }[] = [
  { label: 'Overview', tabs: [['', 'Overview']] },
  { label: 'Explore', tabs: [['browse', 'Browse'], ['source', 'Formats'], ['query', 'Query']] },
  { label: 'Requirements', tabs: [['use-cases', 'Use cases'], ['meetings', 'Meetings'], ['agents', 'Agents']], also: ['interview'] },
  { label: 'Changes', tabs: [['changes', 'Change requests'], ['forks', 'Forks'], ['releases', 'Releases']] },
  { label: 'Governance', tabs: [['governance', 'Governance']] },
];

function sectionOf(segment: string) {
  return SECTIONS.find((s) => s.tabs.some(([p]) => p === segment) || s.also?.includes(segment)) ?? SECTIONS[0];
}

function SectionNav({ id }: { id: string }) {
  const loc = useLocation();
  const segment = loc.pathname.split('/')[3] ?? '';
  const current = sectionOf(segment);
  const href = (path: string) => (path ? `/o/${id}/${path}` : `/o/${id}`);
  return (
    <>
      <nav className="-mb-px mt-4 flex gap-1 overflow-x-auto" aria-label="Ontology sections">
        {SECTIONS.map((s) => {
          const active = s === current;
          return (
            <Link
              key={s.label}
              to={href(s.tabs[0][0])}
              aria-current={active ? 'page' : undefined}
              className={cx('border-b-2 px-3 py-2.5 text-sm whitespace-nowrap transition-colors', active ? 'border-accent font-medium text-fg' : 'border-transparent text-muted hover:text-fg')}
            >
              {s.label}
            </Link>
          );
        })}
      </nav>
      {current.tabs.length > 1 && (
        <div className="border-t border-line">
          <nav className="flex gap-1 overflow-x-auto py-2" aria-label={`${current.label} pages`}>
            {current.tabs.map(([path, label]) => (
              <NavLink
                key={path}
                to={href(path)}
                className={({ isActive }) =>
                  cx('rounded-full px-3 py-1 text-sm whitespace-nowrap transition-colors', isActive ? 'bg-accent-soft font-medium text-accent' : 'text-muted hover:bg-surface-2 hover:text-fg')
                }
              >
                {label}
              </NavLink>
            ))}
          </nav>
        </div>
      )}
    </>
  );
}

export function OntologyLayout() {
  const { id = '' } = useParams();
  const { session } = useSession();
  const state = useAsync(() => api.ontology(id), [id]);
  const view = useAsync(() => api.view(id, 'working'), [id]);

  const ctx = useMemo<OntologyCtx | undefined>(() => {
    const o = state.data;
    if (!o) return undefined;
    const uid = session?.user?.id;
    const myRoles = o.members?.find((m) => m.userId === uid)?.roles ?? [];
    const users = new Map((o.members ?? []).map((m) => [m.userId, m.user]));
    return {
      id,
      ontology: o,
      reload: state.reload,
      view,
      label: makeLabeler(view.data),
      myRoles,
      userById: (uid2?: string) => (uid2 ? users.get(uid2) : undefined),
      hasRole: (...roles: Role[]) => roles.some((r) => myRoles.includes(r)) || !!session?.user?.isPlatformAdmin,
    };
  }, [state.data, state.reload, view, id, session?.user?.id, session?.user?.isPlatformAdmin]);

  if (state.error && !state.data)
    return (
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        <ErrorCard error={state.error} onRetry={state.reload} />
      </div>
    );
  if (!ctx) return <Loading className="py-24" />;
  const o = ctx.ontology;

  return (
    <Ctx.Provider value={ctx}>
      <div className="border-b border-line bg-surface">
        <div className="mx-auto max-w-7xl px-4 pt-6 sm:px-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-xl font-semibold tracking-tight">{o.title}</h1>
                <LifecycleBubble stage={o.stage} />
                {o.demo && <Badge tone="warn">Demo</Badge>}
              </div>
              <p className="mt-0.5 truncate text-xs text-subtle">
                <span className="font-mono">{o.ontologyIRI}</span> · v{o.currentVersion}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {o.stats.openChangeRequests > 0 && (
                <Link to={`/o/${id}/changes`} className="text-xs font-medium text-accent hover:underline">
                  {o.stats.openChangeRequests} open {o.stats.openChangeRequests === 1 ? 'change' : 'changes'}
                </Link>
              )}
              <HealthBubble o={o} detailsHref={`/o/${id}#health`} />
            </div>
          </div>
          <SectionNav id={id} />
        </div>
      </div>
      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
        <Outlet />
      </div>
    </Ctx.Provider>
  );
}
