import { isValidElement, type ReactElement, type ReactNode } from 'react';
import type { SessionInfo } from '@concord/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A socket-free hook runner: real provider callbacks and API requests, with state/effects held here.
// Browser rendering and navigation are covered by e2e/account.spec.ts.
const hooks = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as unknown[],
  effects: [] as (() => void | (() => void))[],
  mounting: true,
  context: undefined as unknown,
}));
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useState: (initial: unknown) => {
    const i = hooks.cursor++;
    if (!(i in hooks.slots)) hooks.slots[i] = typeof initial === 'function' ? initial() : initial;
    return [hooks.slots[i], (next: unknown) => {
      hooks.slots[i] = typeof next === 'function' ? next(hooks.slots[i]) : next;
    }];
  },
  useRef: (initial: unknown) => {
    const i = hooks.cursor++;
    if (!(i in hooks.slots)) hooks.slots[i] = { current: initial };
    return hooks.slots[i];
  },
  useCallback: (fn: unknown) => fn,
  useMemo: (fn: () => unknown) => fn(),
  useEffect: (fn: () => void | (() => void)) => { if (hooks.mounting) hooks.effects.push(fn); },
  useContext: () => hooks.context,
}));
vi.mock('./diagramProposalStorage', () => ({ clearDiagramProposalStorage: () => {} }));
vi.mock('react-router', () => ({
  Link: 'a', NavLink: 'a', useLocation: () => ({ pathname: '/settings', search: '', hash: '' }),
  useNavigate: () => () => {}, useParams: () => ({}),
}));
vi.mock('./ontologies', () => ({ useOntologies: () => ({}) }));
vi.mock('./walkthrough', () => ({ useWalkthrough: () => ({}), testerRoleFor: () => ({}) }));
vi.mock('./hooks', () => ({ useAction: () => ({}), useTick: () => {} }));
vi.mock('../components/badges', () => ({ Logo: 'span', OdiLogo: 'span' }));
vi.mock('../components/ui', () => ({ Avatar: 'span', Button: 'button', LinkButton: 'a', buttonClasses: () => '', cx: () => '' }));
vi.mock('../components/WalkthroughDock', () => ({ WalkthroughDock: () => null }));
vi.mock('../components/Disclosure', () => ({ Popover: 'span' }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const guest = { now: '2026-11-13T12:00:00Z' } as SessionInfo;
const signedIn = {
  ...guest, sessionId: 'new-session',
  user: { id: 'tester', name: 'Tester', providers: [], webId: 'https://example.org/tester#me', createdAt: guest.now },
} as SessionInfo;
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
let traffic: string[];
let cleanups: (() => void)[];

beforeEach(() => {
  vi.resetModules();
  hooks.cursor = 0; hooks.slots = []; hooks.effects = []; hooks.mounting = true;
  cleanups = []; traffic = [];
  const saved: Record<string, string> = {};
  vi.stubGlobal('localStorage', new Proxy(saved, {
    get: (target, property) => {
      if (property === 'getItem') return (key: string) => target[key] ?? null;
      if (property === 'setItem') return (key: string, value: string) => { target[key] = value; };
      if (property === 'removeItem') return (key: string) => { delete target[key]; };
      return target[String(property)];
    },
  }));
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
  fetcher = vi.fn<typeof fetch>(async (url) => {
    traffic.push(String(url));
    return Response.json(String(url) === '/api/auth/demo' ? signedIn : guest);
  });
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  vi.unstubAllGlobals();
});

async function provider(loaded = true) {
  const mod = await import('./session');
  const slots: unknown[] = [];
  const read = () => {
    hooks.cursor = 0; hooks.slots = slots;
    return mod.SessionProvider({ children: null }).props.value as ReturnType<typeof mod.useSession>;
  };
  read();
  hooks.mounting = false;
  for (const effect of hooks.effects) {
    const cleanup = effect();
    if (cleanup) cleanups.push(cleanup);
  }
  if (loaded) await vi.waitFor(() => expect(read().loading).toBe(false));
  return { ...mod, read };
}

function find(node: ReactNode, matches: (element: ReactElement<any>) => boolean): ReactElement<any> | undefined {
  if (Array.isArray(node)) {
    for (const child of node) { const found = find(child, matches); if (found) return found; }
  } else if (isValidElement<{ children?: ReactNode }>(node)) {
    return matches(node) ? node : find(node.props.children, matches);
  }
}

describe('session requests overtaken by sign-in', () => {
  // Used to go wrong: the sign-out barrier included this refresh, so demo login never started.
  it('lets demo login finish while the session check after logout is held', async () => {
    const p = await provider();
    p.read().setSession(signedIn);
    const { Shell } = await import('../components/Shell');
    const menu = find(Shell({ children: null }), (el) => typeof el.type === 'function' && el.type.name === 'UserMenu')!;
    const slots: unknown[] = [];
    const renderMenu = () => {
      hooks.context = p.read(); hooks.slots = slots; hooks.cursor = 0;
      return (menu.type as () => ReactElement)();
    };
    find(renderMenu(), (el) => el.type === 'button')!.props.onClick();
    const held = deferred<Response>();
    traffic.length = 0;
    fetcher.mockImplementation(async (url) => {
      traffic.push(String(url));
      return String(url) === '/api/session' ? held.promise : Response.json(String(url) === '/api/auth/demo' ? signedIn : { ended: true });
    });
    find(renderMenu(), (el) => el.type === 'button' && el.props.children?.includes(' Sign out'))!.props.onClick();
    await vi.waitFor(() => expect(traffic).toContain('/api/session'));
    const { api } = await import('../api');
    const login = api.demoLogin();
    try {
      await vi.waitFor(() => expect(traffic).toContain('/api/auth/demo'), { timeout: 200 });
      p.read().setSession(await login);
    } finally {
      held.resolve(Response.json(guest));
      await login;
    }
    await vi.waitFor(() => expect(p.read().loading).toBe(false));
    expect(p.read().session?.user?.id).toBe('tester');
  });

  // Used to go wrong: a late signed-out answer replaced a session set by a newer sign-in.
  it.each(['refresh', 'focus', 'online', 'visibilitychange', 'storage'])(
    'drops a signed-out answer from %s started before a new sign-in', async (event) => {
      const p = await provider();
      const held = deferred<Response>();
      fetcher.mockImplementationOnce(() => held.promise);
      let refresh: Promise<unknown> | undefined;
      if (event === 'refresh') refresh = p.read().refresh();
      else if (event === 'storage') window.dispatchEvent(Object.assign(new Event('storage'), { key: 'concord.signOuts' }));
      else (event === 'visibilitychange' ? document : window).dispatchEvent(new Event(event));
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
      p.read().setSession(signedIn);
      p.read(); // Commit the new session to the ref used by the background checks.
      held.resolve(Response.json(guest));
      await refresh;
      // Drain the fetch, response body and event handler continuations before reading state.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(p.read().session?.user?.id).toBe('tester');
      expect(p.read().loading).toBe(false);
    },
  );

  // Used to go wrong: a sign-in as the same account during accountSettled was invisible to refresh.
  it('drops a refresh overtaken by setSession while account listeners settle', async () => {
    const p = await provider();
    const held = deferred<void>();
    const changed = vi.fn(() => held.promise);
    const unsubscribe = p.onAccountChange(changed);
    fetcher.mockResolvedValueOnce(Response.json(signedIn));
    const refresh = p.read().refresh();
    await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
    p.read().setSession({ ...signedIn, sessionId: 'newer-session' });
    held.resolve();
    expect(await refresh).toBeUndefined();
    expect(p.read().session?.sessionId).toBe('newer-session');
    expect(p.read().loading).toBe(false);
    unsubscribe();
  });

  // Used to go wrong: applying the older answer counted as a session change, so the newer check
  // (made after signing in in another tab) was dropped and this tab stayed on the sign-in page.
  it('applies a newer check after an older refresh has answered', async () => {
    const p = await provider();
    const older = deferred<Response>();
    const newer = deferred<Response>();
    fetcher.mockImplementationOnce(() => older.promise).mockImplementationOnce(() => newer.promise);
    const refresh = p.read().refresh();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    window.dispatchEvent(new Event('focus'));
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
    older.resolve(Response.json(guest));
    await refresh;
    expect(p.read().session?.user).toBeUndefined();
    newer.resolve(Response.json(signedIn));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(p.read().session?.user?.id).toBe('tester');
    expect(p.read().loading).toBe(false);
  });

  // The other order: the answer to the older question arrives last and must not replace the newer one.
  it.each(['a different session', 'the session already shown'])(
    'drops an older refresh that answers after a newer check found %s', async (found) => {
      const p = await provider();
      if (found === 'the session already shown') { p.read().setSession(signedIn); p.read(); }
      const older = deferred<Response>();
      const newer = deferred<Response>();
      fetcher.mockImplementationOnce(() => older.promise).mockImplementationOnce(() => newer.promise);
      const refresh = p.read().refresh();
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
      window.dispatchEvent(new Event('focus'));
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
      newer.resolve(Response.json(signedIn));
      await new Promise((resolve) => setTimeout(resolve, 0));
      p.read();
      older.resolve(Response.json(guest));
      expect(await refresh).toBeUndefined();
      expect(p.read().session?.user?.id).toBe('tester');
      expect(p.read().loading).toBe(false);
    },
  );

  // Used to go wrong: the newer check's signed-out answer matched "no session yet", so it was not shown, yet it
  // still outranked the first answer, which was dropped. With no session and no error, sign-in showed an error.
  it('shows the session when a newer check answers before the very first one', async () => {
    const first = deferred<Response>();
    fetcher.mockImplementationOnce(() => first.promise);
    const p = await provider(false);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    window.dispatchEvent(new Event('focus'));
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 0));
    first.resolve(Response.json(guest));
    await vi.waitFor(() => expect(p.read().loading).toBe(false));
    expect(p.read().session).toEqual(guest);
    expect(p.read().error).toBeUndefined();
  });

  // Used to go wrong: reconnect logout replay was absent from the sign-in barrier.
  it('waits for a pending offline logout before sending demo login', async () => {
    const p = await provider();
    p.markSignOutPending('old-session');
    const held = deferred<Response>();
    fetcher.mockImplementation(async (url) => {
      traffic.push(String(url));
      return String(url) === '/api/auth/logout' ? held.promise : Response.json(String(url) === '/api/auth/demo' ? signedIn : guest);
    });
    window.dispatchEvent(new Event('online'));
    await vi.waitFor(() => expect(traffic).toContain('/api/auth/logout'));
    const { api } = await import('../api');
    const login = api.demoLogin();
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(traffic).not.toContain('/api/auth/demo');
    } finally {
      held.resolve(Response.json({ ended: true }));
      p.read().setSession(await login);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(p.read().session?.user?.id).toBe('tester');
  });
});

describe('overlapping sign-out barriers', () => {
  // Used to go wrong: demo login was sent before logout answered, so logout could clear its cookie.
  it('waits for the logout response before sending a new demo login', async () => {
    const auth = await import('../api');
    const held = deferred<Response>();
    fetcher.mockImplementation(async (url) => {
      traffic.push(String(url));
      return String(url) === '/api/auth/logout' ? held.promise : Response.json(signedIn);
    });
    const logout = auth.api.logout();
    // Optional only so this regression can also run against the pre-barrier parent commit.
    auth.whileSigningOut?.(logout);
    const login = auth.api.demoLogin();
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(traffic).toEqual(['/api/auth/logout']);
    } finally {
      held.resolve(Response.json({ ended: true }));
      await login;
    }
    expect(traffic).toEqual(['/api/auth/logout', '/api/auth/demo']);
  });

  // Used to go wrong: a sign-out registered while login awaited an earlier one could be missed.
  it('also waits for a sign-out registered while login is already waiting', async () => {
    const { api, whileSigningOut } = await import('../api');
    const first = deferred<void>();
    const second = deferred<void>();
    whileSigningOut(first.promise);
    const login = api.demoLogin();
    whileSigningOut(second.promise);
    first.resolve();
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(traffic).not.toContain('/api/auth/demo');
    } finally {
      second.resolve();
      await login;
    }
    expect(traffic).toEqual(['/api/auth/demo']);
  });

  // Used to go wrong: registering a second sign-out replaced the first promise, releasing login early.
  it.each([false, true])('waits for both sign-outs when the second finishes first (rejected: %s)', async (reject) => {
    const { api, whileSigningOut } = await import('../api');
    const first = deferred<void>();
    const second = deferred<void>();
    whileSigningOut(first.promise);
    whileSigningOut(second.promise);
    const login = api.demoLogin();
    if (reject) second.reject(new Error('offline')); else second.resolve();
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(traffic).not.toContain('/api/auth/demo');
    } finally {
      first.resolve();
      await login;
    }
    expect(traffic).toEqual(['/api/auth/demo']);
  });
});
