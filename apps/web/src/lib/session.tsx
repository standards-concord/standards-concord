import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { SessionInfo } from '@concord/shared';
import { api } from '../api';

interface SessionCtx {
  session?: SessionInfo;
  loading: boolean;
  error: unknown;
  refresh: () => Promise<SessionInfo | undefined>;
  setSession: (s: SessionInfo) => void;
  /** Simulated "now" in ms (server clock incl. fast-forward offset). */
  now: () => number;
  isDemo: boolean;
}

const Ctx = createContext<SessionCtx | null>(null);

/**
 * The account this tab is signed in as right now ('guest' when nobody is), or
 * undefined while signing out. Work that started under one account (an
 * assistant reply on its way) checks this before saving anything, so a late
 * answer never lands in another account's drafts or after they were cleared.
 */
let activeAccount: string | undefined;

/**
 * Counts sign-outs across every tab of this browser (in localStorage, so it is
 * shared and read synchronously). Work started before a sign-out anywhere
 * compares it before saving: a tab that hasn't heard about another tab's
 * sign-out yet still can't write the signed-out account's drafts back.
 */
const SIGN_OUTS = 'concord.signOuts';
function signOuts(): string {
  try {
    return localStorage.getItem(SIGN_OUTS) ?? '0';
  } catch {
    return '0';
  }
}

/** A token for "this account, as of now": still current while the tab is on that account and nobody has signed out since. */
export function accountToken(): { account: string | undefined; signOuts: string } {
  return { account: activeAccount, signOuts: signOuts() };
}
export function stillCurrent(token: { account: string | undefined; signOuts: string }, account: string) {
  return token.account === account && activeAccount === account && signOuts() === token.signOuts;
}

function clearDrafts(userId: string) {
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith(`concord.query.${userId}.`)) localStorage.removeItem(k);
  } catch {
    /* storage unavailable */
  }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSessionState] = useState<SessionInfo>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>();
  const fetchedAt = useRef(Date.now());

  const setSession = useCallback((s: SessionInfo) => {
    activeAccount = s.user?.id ?? 'guest';
    fetchedAt.current = Date.now();
    setSessionState(s);
    setError(undefined);
  }, []);

  /**
   * The session from the server, or undefined if a sign-out happened while asking:
   * a signed-in answer sent before the sign-out must not sign this tab back in.
   */
  const fetchSession = useCallback(async () => {
    const before = signOuts();
    const s = await api.session();
    return s.user && signOuts() !== before ? undefined : s;
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const s = await fetchSession();
      if (!s) return undefined;
      setSession(s);
      return s;
    } catch (e) {
      setError(e);
      return undefined;
    } finally {
      setLoading(false);
    }
  }, [setSession, fetchSession]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Another tab may have signed in or out: check quietly when this tab comes back into view,
  // so pages holding one account's drafts never carry on under another account.
  const sessionRef = useRef(session);
  sessionRef.current = session;
  // Another tab finished signing out: this tab is signed out too, straight away (its workspace for the
  // account closes, and anything of it written in the meantime goes), then the server confirms.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== SIGN_OUTS) return;
      const current = sessionRef.current;
      const was = current?.user?.id;
      if (was) clearDrafts(was);
      if (current) setSession({ ...current, user: undefined });
      activeAccount = undefined;
      void fetchSession()
        .then((s) => s && setSession(s))
        .catch(() => {});
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [setSession, fetchSession]);

  useEffect(() => {
    const check = () => {
      if (document.visibilityState !== 'visible') return;
      void fetchSession()
        .then((s) => {
          if (s && s.user?.id !== sessionRef.current?.user?.id) setSession(s);
        })
        .catch(() => {});
    };
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    return () => {
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, [setSession, fetchSession]);

  const now = useCallback(() => {
    if (!session) return Date.now();
    const base = Date.parse(session.now);
    if (Number.isNaN(base)) return Date.now() + (session.clockOffsetMs ?? 0);
    return base + (Date.now() - fetchedAt.current);
  }, [session]);

  const isDemo = !!session?.user && (session.user.simulated || session.user.providers?.some((p) => p.provider === 'demo'));

  const value = useMemo(() => ({ session, loading, error, refresh, setSession, now, isDemo: !!isDemo }), [session, loading, error, refresh, setSession, now, isDemo]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useSession outside SessionProvider');
  return c;
}

/**
 * Signing out, in two steps around the request that ends the session. First,
 * this tab forgets the account (so a reply on its way here is dropped) and
 * clears its drafts. Then, once the server has ended the session, every tab is
 * told: replies on their way there are dropped, their copy of the drafts is
 * cleared again (anything written in between goes too), and they switch to
 * signed out at once rather than asking the server while it may still say
 * otherwise. The query drafts and assistant chats are what is cleared.
 */
/** Called on signing out, in this tab, to drop anything kept in memory that only the account signing out could read. */
const signOutListeners = new Set<() => void>();
export function onSignOut(fn: () => void): () => void {
  signOutListeners.add(fn);
  return () => signOutListeners.delete(fn);
}
function notifySignOut() {
  for (const fn of signOutListeners) fn();
}

export function beginSignOut(userId: string) {
  activeAccount = undefined;
  clearDrafts(userId);
  notifySignOut();
}
export function finishSignOut(userId: string) {
  activeAccount = undefined;
  notifySignOut();
  try {
    localStorage.setItem(SIGN_OUTS, String(Number(signOuts()) + 1));
  } catch {
    /* storage unavailable */
  }
  clearDrafts(userId);
}
