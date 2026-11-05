import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate, useParams } from 'react-router';
import { ChevronDown, Clock, Plug, FastForward, LogOut, MessageSquareHeart, Shield, UserRound, Compass, Palette } from 'lucide-react';
import { api } from '../api';
import { useSession } from '../lib/session';
import { useOntologies } from '../lib/ontologies';
import { testerRoleFor, useWalkthrough } from '../lib/walkthrough';
import { useAction, useTick } from '../lib/hooks';
import { formatDate, roleLabel } from '../lib/format';
import { Logo, OdiLogo } from './badges';
import { Avatar, Button, cx } from './ui';
import { WalkthroughDock } from './Walkthrough';
import { Popover } from './Disclosure';

function OntologySwitcher() {
  const { data } = useOntologies();
  const params = useParams();
  const loc = useLocation();
  const nav = useNavigate();
  const currentId = params.id ?? loc.pathname.match(/^\/o\/([^/]+)/)?.[1];
  if (!data?.length) return null;
  return (
    <div className="relative hidden min-w-0 md:block">
      <select
        aria-label="Switch ontology"
        value={currentId ?? ''}
        onChange={(e) => nav(e.target.value ? `/o/${e.target.value}` : '/')}
        className="h-8 max-w-56 appearance-none truncate rounded-lg border border-control bg-surface py-0 pr-8 pl-3 text-sm hover:border-line-strong focus:border-accent focus:outline-none"
      >
        <option value="">All ontologies</option>
        {data.map((o) => (
          <option key={o.id} value={o.id}>
            {o.title}
          </option>
        ))}
      </select>
      <ChevronDown className="app-header-muted pointer-events-none absolute top-2 right-2.5 size-4 text-muted" />
    </div>
  );
}

/** The sign-in page, coming back to this exact place (path, query and #section) afterwards. */
export function loginHref(loc: { pathname: string; search: string; hash: string }) {
  if (loc.pathname === '/login') return '/login';
  const here = loc.pathname + loc.search + loc.hash;
  return here === '/' ? '/login' : `/login?next=${encodeURIComponent(here)}`;
}

function UserMenu() {
  const { session, setSession, refresh, isDemo } = useSession();
  const loc = useLocation();
  const w = useWalkthrough();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const nav = useNavigate();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // A disclosure of ordinary links: focus moves to the first link, Escape closes and returns to the button,
  // and clicking outside or tabbing away closes it.
  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector<HTMLElement>('a, button')?.focus();
    const h = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const k = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener('mousedown', h);
    document.addEventListener('keydown', k);
    return () => {
      document.removeEventListener('mousedown', h);
      document.removeEventListener('keydown', k);
    };
  }, [open]);
  const user = session?.user;
  // In the demo, say which tester role this persona plays, e.g. "Alpha tester (Voting member)".
  const testerRole = isDemo && user && w.demo ? testerRoleFor(user, w.myRoles).title : undefined;
  if (!user)
    return (
      <Link to={loginHref(loc)}>
        <Button size="sm" variant="primary">
          Sign in
        </Button>
      </Link>
    );
  const logout = async () => {
    try {
      await api.logout();
    } catch {
      /* ignore */
    }
    const s = await refresh();
    if (s) setSession(s);
    nav('/login');
  };
  return (
    <div
      className="relative"
      ref={ref}
      onBlur={(e) => {
        if (open && e.relatedTarget && !ref.current?.contains(e.relatedTarget as Node)) setOpen(false);
      }}
    >
      <button ref={buttonRef} onClick={() => setOpen((o) => !o)} className="app-user-button flex items-center gap-2 rounded-pill p-0.5 pr-2 hover:bg-surface-2" aria-expanded={open} aria-controls="account-menu">
        <Avatar name={user.name} src={user.avatarUrl} size={30} />
        <span className="hidden max-w-32 truncate text-sm font-medium lg:inline">{user.name}</span>
        {testerRole && <span className="app-header-muted hidden text-sm whitespace-nowrap text-muted lg:inline">({testerRole})</span>}
        {/* Below lg only the avatar shows, so give the button its name for screen readers. */}
        <span className="sr-only lg:hidden">
          {user.name}
          {testerRole && ` (${testerRole})`}
        </span>
        <ChevronDown className="app-header-muted hidden size-3.5 text-muted lg:inline" />
      </button>
      {open && (
        <nav id="account-menu" ref={panelRef} aria-label="Account" className="absolute right-0 z-50 mt-2 w-64 overflow-hidden rounded-xl border border-line bg-surface py-1 text-fg shadow-xl" onClick={() => setOpen(false)}>
          <div className="border-b border-line px-4 py-3">
            <div className="truncate text-sm font-medium">{user.name}</div>
            {testerRole && <div className="truncate text-xs text-muted">Trying Concord as: {testerRole}</div>}
            {user.email && <div className="truncate text-xs text-muted">{user.email}</div>}
            {user.organisation && <div className="truncate text-xs text-muted">{user.organisation}</div>}
          </div>
          <MenuLink to="/settings" icon={<UserRound className="size-4" />}>
            Profile
          </MenuLink>
          <MenuLink to="/connect" icon={<Plug className="size-4" />}>
            Connect an agent
          </MenuLink>
          <MenuLink to="/appearance" icon={<Palette className="size-4" />}>
            Appearance
          </MenuLink>
          <MenuLink to="/alpha" icon={<Compass className="size-4" />}>
            Alpha walkthrough
          </MenuLink>
          {user.isPlatformAdmin && (
            <MenuLink to="/admin/feedback" icon={<Shield className="size-4" />}>
              Feedback admin
            </MenuLink>
          )}
          <button onClick={() => void logout()} className="flex w-full items-center gap-2.5 px-4 py-2 text-left text-sm hover:bg-surface-2">
            <LogOut className="size-4" /> Sign out
          </button>
        </nav>
      )}
    </div>
  );
}

function MenuLink({ to, icon, children }: { to: string; icon: ReactNode; children: ReactNode }) {
  return (
    <Link to={to} className="flex items-center gap-2.5 px-4 py-2 text-sm hover:bg-surface-2">
      {icon}
      {children}
    </Link>
  );
}

function DemoBanner() {
  const { session, setSession, now, isDemo } = useSession();
  const w = useWalkthrough();
  const nav = useNavigate();
  useTick(30_000);
  const clock = useAction(async (days: number) => setSession(await api.advanceClock(days)));
  if (!isDemo || !session?.user) return null;
  const roles = w.myRoles.length ? w.myRoles.map(roleLabel).join(', ') : 'participant';
  const offsetDays = Math.round((session.clockOffsetMs ?? 0) / 86400e3);
  return (
    <div className="border-b border-accent/20 bg-accent-soft text-sm">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-x-4 gap-y-1.5 px-4 py-1.5 sm:px-6">
        <div className="min-w-0">
          Viewing as <strong>{session.user.name}</strong> <span className="text-muted">({roles})</span> —{' '}
          <button
            className="font-medium text-accent hover:underline"
            onClick={() => {
              w.setStep(1);
              nav('/alpha');
            }}
          >
            switch role
          </button>
        </div>
        <Popover
          label="Simulated clock. Show fast-forward controls"
          align="right"
          className="px-2 py-0.5 text-muted hover:bg-surface/60 hover:text-fg"
          trigger={
            <>
              <Clock className="size-3.5" aria-hidden />
              {formatDate(new Date(now()).toISOString(), true)}
              {offsetDays > 0 && <span className="text-xs">(+{offsetDays}d)</span>}
            </>
          }
        >
          <p className="font-medium">Simulated governance clock</p>
          <p className="mt-1 text-xs text-muted">Review periods and votes run on this clock. Fast-forward it to see what happens when deadlines pass. Everyone in the demo shares it.</p>
          <div className="mt-3 flex gap-2">
            <Button size="sm" icon={FastForward} disabled={clock.pending} onClick={() => void clock.run(1)} title="Fast-forward the simulated clock by one day">
              1 day
            </Button>
            <Button size="sm" icon={FastForward} disabled={clock.pending} onClick={() => void clock.run(7)} title="Fast-forward the simulated clock by seven days">
              7 days
            </Button>
          </div>
          {clock.error ? <p className="mt-2 text-xs text-danger">Couldn’t change the clock</p> : null}
        </Popover>
      </div>
    </div>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      {/* Skips the repeated header. It focuses <main> without touching the URL hash, which some pages use for their own sections. */}
      <a
        href="#main"
        onClick={(e) => {
          e.preventDefault();
          const main = document.getElementById('main');
          main?.focus();
          main?.scrollIntoView({ block: 'start' });
        }}
        className="sr-only z-50 rounded-lg bg-surface px-3 py-2 text-sm font-medium text-accent shadow-lg focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:outline-2 focus:outline-accent"
      >
        Skip to main content
      </a>
      <header className="app-header sticky top-0 z-30 border-b border-line backdrop-blur">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-3 px-4 sm:px-6">
          <Link to="/" className="flex min-w-0 items-center gap-2.5" aria-label="Concord: home">
            {/* The ODI look puts the ODI logo ahead of Concord's own mark; the unbranded looks show only Concord's (index.css). */}
            <OdiLogo className="brand-odi h-6 shrink-0" />
            <span className="brand-odi h-6 w-px shrink-0 bg-line-strong" aria-hidden />
            <Logo className="shrink-0" />
            <span className="truncate text-sm font-semibold tracking-tight">
              Concord<span className="app-brand-sub hidden sm:inline"></span>
            </span>
            <span className="rounded bg-warn-soft px-1.5 py-0.5 text-xs font-semibold text-warn">Alpha</span>
          </Link>
          <div className="flex-1" />
          <OntologySwitcher />
          <NavLink to="/feedback" className={({ isActive }) => cx(isActive && 'pointer-events-none opacity-60')}>
            <Button size="sm" variant="subtle" icon={MessageSquareHeart} className="ui-button-header">
              <span className="hidden sm:inline">Give feedback</span>
              <span className="sm:hidden">Feedback</span>
            </Button>
          </NavLink>
          <UserMenu />
        </div>
      </header>
      <DemoBanner />
      <main id="main" tabIndex={-1} className="flex-1 scroll-mt-16 outline-none">
        {children}
      </main>
      <footer className="border-t border-line py-6 text-center text-xs text-subtle">
        Concord is an alpha prototype by the Open Data Institute Standards Platform. Private data is saved to your own Solid pod, or to Concord’s private storage when no pod can be used. ·{' '}
        <Link to="/privacy" className="underline-offset-2 hover:text-fg hover:underline">
          Privacy policy
        </Link>
      </footer>
      <WalkthroughDock />
    </div>
  );
}

export function Page({ children, className, wide }: { children: ReactNode; className?: string; wide?: boolean }) {
  return <div className={cx('mx-auto w-full px-4 py-8 sm:px-6', wide ? 'max-w-7xl' : 'max-w-5xl', className)}>{children}</div>;
}
