import { createContext, useContext, useEffect, useMemo } from 'react';
import { Link, Outlet, useLocation, useNavigate, useParams } from 'react-router';
import type { OntologyView, Role, User } from '@concord/shared';
import { api, type OntologyDetail } from '../../api';
import { useAsync, type AsyncState } from '../../lib/hooks';
import { useSession } from '../../lib/session';
import { makeLabeler, type Labeler } from '../../lib/ontology';
import { ExternalLink } from 'lucide-react';
import { publicPageUrl } from '../../lib/format';
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
  // Connecting an agent is how people read, query and validate against the ontology from their own tools, so it sits with Explore.
  { label: 'Explore', tabs: [['browse', 'Browse'], ['source', 'Source & export'], ['query', 'Query & validate'], ['connect', 'Connect an agent']] },
  // What agents report is requirements input, next to use cases and meetings.
  { label: 'Requirements', tabs: [['use-cases', 'Use cases'], ['meetings', 'Meetings'], ['agents', 'Agent reports']], also: ['interview'] },
  { label: 'Changes', tabs: [['changes', 'Change requests'], ['releases', 'Releases']] },
  { label: 'Governance', tabs: [['governance', 'Governance']] },
];

function sectionOf(segment: string) {
  return SECTIONS.find((s) => s.tabs.some(([p]) => p === segment) || s.also?.includes(segment)) ?? SECTIONS[0];
}

/** Pages that belong under a tab without being in the nav, e.g. an interview is part of Use cases. */
const TAB_ALIASES: Record<string, string> = { interview: 'use-cases' };

/** The last page visited in each section, per ontology, so returning to a section lands where you left it. */
const lastKey = (id: string, section: string) => `concord.nav.${id}.${section}`;
function rememberedPath(id: string, section: string): string | undefined {
  try {
    return sessionStorage.getItem(lastKey(id, section)) ?? undefined;
  } catch {
    return undefined;
  }
}

function SectionNav({ id }: { id: string }) {
  const loc = useLocation();
  const nav = useNavigate();
  const segment = loc.pathname.split('/')[3] ?? '';
  const current = sectionOf(segment);
  const activeTab = TAB_ALIASES[segment] ?? segment;
  const href = (path: string) => (path ? `/o/${id}/${path}` : `/o/${id}`);
  useEffect(() => {
    if (current.tabs.length < 2) return;
    try {
      // Remember the page (with its filters), not a detail view inside it.
      const onTabPage = loc.pathname.replace(/\/$/, '') === href(activeTab);
      sessionStorage.setItem(lastKey(id, current.label), onTabPage ? loc.pathname + loc.search : href(activeTab));
    } catch {
      /* storage unavailable: sections open their first page */
    }
  }, [id, current, activeTab, loc.pathname, loc.search]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <nav className="-mb-px mt-4 flex gap-1 overflow-x-auto" aria-label="Ontology sections">
        {SECTIONS.map((s) => {
          const active = s === current;
          const target = () => {
            const remembered = s.tabs.length > 1 ? rememberedPath(id, s.label) : undefined;
            return remembered && remembered.startsWith(`/o/${id}/`) ? remembered : href(s.tabs[0][0]);
          };
          return (
            <Link
              key={s.label}
              to={target()}
              onClick={(e) => {
                // The page is remembered after each render, so the href can lag behind a quick click
                // made straight after navigating: look it up again at click time.
                if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                e.preventDefault();
                nav(target());
              }}
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
            {current.tabs.map(([path, label]) => {
              const active = path === activeTab;
              return (
                <Link
                  key={path}
                  to={href(path)}
                  aria-current={active ? 'page' : undefined}
                  className={cx('rounded-pill px-3 py-1 text-sm whitespace-nowrap transition-colors', active ? 'bg-accent-soft font-medium text-accent' : 'text-muted hover:bg-surface-2 hover:text-fg')}
                >
                  {label}
                </Link>
              );
            })}
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
    // While another ontology loads, the previous one's data is still here: wait rather than pair
    // the new id with the old ontology's metadata (pages key drafts and defaults on both).
    if (!o || (o.id !== id && o.slug !== id)) return undefined;
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

  // No context for this ontology and its request has failed (even if a previous ontology's data
  // is still held): show the error with Retry rather than loading forever.
  if (state.error && !state.loading && !ctx)
    return (
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        <ErrorCard error={state.error} onRetry={state.reload} />
      </div>
    );
  if (!ctx) return <Loading className="py-24" />;
  const o = ctx.ontology;

  return (
    <Ctx.Provider value={ctx}>
      <div className="ontology-header border-b border-line bg-surface">
        <div className="mx-auto max-w-7xl px-4 pt-6 sm:px-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-xl font-semibold tracking-tight">{o.title}</h1>
                <LifecycleBubble stage={o.stage} />
                {o.demo && <Badge tone="warn">Demo</Badge>}
              </div>
              <p className="mt-0.5 truncate text-xs text-subtle">
                <span className="font-mono">{o.ontologyIRI}</span> · v{o.currentVersion} ·{' '}
                <a href={publicPageUrl(o.slug)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-accent hover:underline" data-testid="public-page-link">
                  Public page <ExternalLink className="size-3" aria-hidden />
                </a>
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {(o.stats.openChangeRequests ?? 0) > 0 && (
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
      {/* A clear gap between the ontology header and the page beneath it. */}
      <div className="ontology-content mx-auto max-w-7xl px-4 pt-10 pb-12 sm:px-6">
        <Outlet />
      </div>
    </Ctx.Provider>
  );
}
