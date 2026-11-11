import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { SessionInfo } from '@concord/shared';
import { api, ApiError } from '../api';
import { clearDiagramProposalStorage } from './diagramProposalStorage';

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
 * Called whenever this tab's account changes: signing in, out (here or in another tab) or as someone
 * else. Anything kept in memory that only one account could read is dropped then.
 */
const accountListeners = new Set<() => void | Promise<unknown>>();
export function onAccountChange(fn: () => void | Promise<unknown>): () => void {
  accountListeners.add(fn);
  return () => accountListeners.delete(fn);
}
/** What listeners are still doing for the last account change (say, reading back what this device saved). */
let accountSettling: Promise<unknown> = Promise.resolve();
function setActiveAccount(next: string | undefined) {
  if (next === activeAccount) return;
  activeAccount = next;
  const work: unknown[] = [];
  for (const fn of accountListeners) work.push(fn());
  accountSettling = Promise.allSettled(work);
}
// Initial session discovery on reload restores drafts; later account changes forget all proposals.
let proposalAccountKnown = false;
onAccountChange(() => {
  if (proposalAccountKnown) clearDiagramProposalStorage();
  proposalAccountKnown = true;
});
/** Waits for the last account change's listeners, but never longer than a moment. */
function accountSettled(): Promise<unknown> {
  return Promise.race([accountSettling, new Promise((r) => setTimeout(r, 1500))]);
}

/**
 * The last signed-in session, saved on this device so Concord can open with no connection as the
 * same person (showing what the device saved for them). Removed on signing out.
 */
const OFFLINE_SESSION = 'concord.offline.session';
function saveOfflineSession(s: SessionInfo) {
  try {
    if (s.user) localStorage.setItem(OFFLINE_SESSION, JSON.stringify({ session: s, savedAt: Date.now() }));
    else localStorage.removeItem(OFFLINE_SESSION);
  } catch {
    /* storage unavailable */
  }
}
function forgetOfflineSession() {
  try {
    localStorage.removeItem(OFFLINE_SESSION);
  } catch {
    /* storage unavailable */
  }
}
/**
 * Signing out with no connection can't end the server's session. The session it meant (its handle,
 * SessionInfo.sessionId) is remembered here and ended as soon as the server can be reached: the server
 * ends that session only, so a newer sign-in or another account's session in this browser is never
 * touched. Each pending sign-out has its own key, and only that one is removed when it is done.
 */
const SIGN_OUT_PENDING = 'concord.signOutPending.';
export function markSignOutPending(session: string | undefined) {
  if (!session) return;
  try {
    // One key per sign-out, so finishing one can never remove another tab's.
    localStorage.setItem(SIGN_OUT_PENDING + crypto.randomUUID(), session);
  } catch {
    /* storage unavailable */
  }
}
/** Ends the sessions sign-outs made with no connection meant, now the server answers; each is done whatever it says. */
async function finishPendingSignOut() {
  let pending: [string, string][] = [];
  try {
    pending = Object.keys(localStorage)
      .filter((k) => k.startsWith(SIGN_OUT_PENDING))
      .map((k) => [k, localStorage.getItem(k) ?? '']);
  } catch {
    return;
  }
  for (const [key, session] of pending) {
    if (session) await api.logout(session);
    try {
      localStorage.removeItem(key);
    } catch {
      /* storage unavailable */
    }
  }
}

/** The saved session, its clock moved on by the time since it was saved; undefined if there is none. */
function offlineSession(): SessionInfo | undefined {
  try {
    const raw = localStorage.getItem(OFFLINE_SESSION);
    if (!raw) return undefined;
    const { session, savedAt } = JSON.parse(raw) as { session: SessionInfo; savedAt: number };
    if (!session?.user) return undefined;
    const base = Date.parse(session.now);
    return { ...session, now: new Date((Number.isNaN(base) ? savedAt : base) + (Date.now() - savedAt)).toISOString() };
  } catch {
    return undefined;
  }
}

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
    setActiveAccount(s.user?.id ?? 'guest');
    saveOfflineSession(s);
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
    // A sign-out made with no connection goes first, so its session never signs this tab back in.
    await finishPendingSignOut();
    const s = await api.session();
    return s.user && signOuts() !== before ? undefined : s;
  }, []);

  // Each refresh is numbered: one that a newer refresh, a sign-out or another account overtook while
  // it waited for the device's copy to be read back is dropped instead of applied.
  const refreshes = useRef(0);
  const refresh = useCallback(async () => {
    const n = ++refreshes.current;
    const before = signOuts();
    const stillWanted = (account: string) => n === refreshes.current && signOuts() === before && activeAccount === account;
    setLoading(true);
    try {
      const s = await fetchSession();
      if (!s) return undefined;
      // Pages show what this device saved for the account at once, so it is read back first.
      const account = s.user?.id ?? 'guest';
      if (n !== refreshes.current || signOuts() !== before) return undefined;
      setActiveAccount(account);
      await accountSettled();
      if (!stillWanted(account)) return undefined;
      setSession(s);
      return s;
    } catch (e) {
      // No connection: carry on as the last person signed in here, with what the device saved for them.
      // Nothing is sent as them until the server is back, and it still decides what they may do.
      const saved = e instanceof ApiError && e.offline ? offlineSession() : undefined;
      if (saved && n === refreshes.current && signOuts() === before && (!activeAccount || activeAccount === saved.user!.id)) {
        setActiveAccount(saved.user!.id);
        await accountSettled();
        // Signed out (here or in another tab) while reading back: the saved session is gone too.
        if (!stillWanted(saved.user!.id) || !offlineSession()) return undefined;
        fetchedAt.current = Date.now();
        setSessionState(saved);
        setError(undefined);
        return saved;
      }
      if (n === refreshes.current) setError(e);
      return undefined;
    } finally {
      if (n === refreshes.current) setLoading(false);
    }
  }, [setSession, fetchSession]);

  // Signing out (here, or in another tab) closes the account on screen at once, even when the server
  // can't be reached to confirm it: pages showing its data unmount and sign-in is shown.
  useEffect(
    () =>
      onAccountChange(() => {
        if (activeAccount === undefined) setSessionState((s) => (s?.user ? { ...s, user: undefined } : s));
      }),
    [],
  );

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
      forgetOfflineSession();
      if (current) setSession({ ...current, user: undefined });
      setActiveAccount(undefined);
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
          // Another account, or the same one signed in again (a new session, so a new handle for a later sign-out).
          if (s && (s.user?.id !== sessionRef.current?.user?.id || s.sessionId !== sessionRef.current?.sessionId)) setSession(s);
        })
        .catch(() => {});
    };
    window.addEventListener('focus', check);
    window.addEventListener('online', check);
    document.addEventListener('visibilitychange', check);
    return () => {
      window.removeEventListener('focus', check);
      window.removeEventListener('online', check);
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
export function beginSignOut(userId: string) {
  forgetOfflineSession();
  setActiveAccount(undefined);
  clearDrafts(userId);
}
export function finishSignOut(userId: string) {
  forgetOfflineSession();
  setActiveAccount(undefined);
  try {
    localStorage.setItem(SIGN_OUTS, String(Number(signOuts()) + 1));
  } catch {
    /* storage unavailable */
  }
  clearDrafts(userId);
}
