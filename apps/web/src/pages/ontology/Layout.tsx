import { createContext, useContext, useMemo } from 'react';
import { NavLink, Outlet, useParams } from 'react-router';
import type { OntologyView, Role, User } from '@concord/shared';
import { api, type OntologyDetail } from '../../api';
import { useAsync, type AsyncState } from '../../lib/hooks';
import { useSession } from '../../lib/session';
import { makeLabeler, type Labeler } from '../../lib/ontology';
import { titleCase } from '../../lib/format';
import { HealthBadges } from '../../components/badges';
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

const TABS: [string, string][] = [
  ['', 'Overview'],
  ['browse', 'Browse'],
  ['source', 'Formats'],
  ['use-cases', 'Use cases'],
  ['meetings', 'Meetings'],
  ['changes', 'Change requests'],
  ['releases', 'Releases'],
  ['governance', 'Governance'],
  ['agents', 'Agents'],
];

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
                <Badge tone="outline">{titleCase(o.stage)}</Badge>
                {o.demo && <Badge tone="warn">Demo</Badge>}
              </div>
              <p className="mt-0.5 truncate font-mono text-xs text-subtle">{o.ontologyIRI}</p>
            </div>
            <HealthBadges o={o} />
          </div>
          <nav className="-mb-px mt-4 flex gap-1 overflow-x-auto" aria-label="Ontology sections">
            {TABS.map(([path, label]) => (
              <NavLink
                key={path}
                to={path ? `/o/${id}/${path}` : `/o/${id}`}
                end={!path}
                className={({ isActive }) =>
                  cx('border-b-2 px-3 py-2.5 text-sm whitespace-nowrap transition-colors', isActive ? 'border-accent font-medium text-fg' : 'border-transparent text-muted hover:text-fg')
                }
              >
                {label}
              </NavLink>
            ))}
          </nav>
        </div>
      </div>
      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
        <Outlet />
      </div>
    </Ctx.Provider>
  );
}
