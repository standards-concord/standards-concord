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
export function currentAccount() {
  return activeAccount;
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

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const s = await api.session();
      setSession(s);
      return s;
    } catch (e) {
      setError(e);
      return undefined;
    } finally {
      setLoading(false);
    }
  }, [setSession]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Another tab may have signed in or out: check quietly when this tab comes back into view,
  // so pages holding one account's drafts never carry on under another account.
  const sessionRef = useRef(session);
  sessionRef.current = session;
  useEffect(() => {
    const check = () => {
      if (document.visibilityState !== 'visible') return;
      void api
        .session()
        .then((s) => {
          if (s.user?.id !== sessionRef.current?.user?.id) setSession(s);
        })
        .catch(() => {});
    };
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    return () => {
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, [setSession]);

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

/** Drafts this browser keeps for an account (query drafts and query-assistant chats): removed on sign-out. */
export function forgetAccountDrafts(userId: string) {
  // First, so a reply still on its way for this account is dropped rather than saved after the clear-out.
  activeAccount = undefined;
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith(`concord.query.${userId}.`)) localStorage.removeItem(k);
  } catch {
    /* storage unavailable */
  }
}
