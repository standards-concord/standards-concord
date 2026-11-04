import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';
import {
  APP_RELEASES,
  APP_VERSION,
  changesFor,
  changesSince,
  compareVersions,
  findRelease,
  lastTestedBefore,
  type AlphaMe,
  type AppRelease,
  type ChangeWithRelease,
  type TesterRoleKey,
} from '@concord/shared';
import { api } from '../api';
import { useAsync, useLocalStorage } from './hooks';
import { useSession } from './session';

/**
 * Which version of Concord an alpha tester is using, which one they tested
 * last, and what changed in between.
 *
 * The last tested version comes from, in order: what the tester picked on the
 * alpha page, the record in their pod (when signed in), or the versions this
 * browser has seen.
 */

/** Short commit of this web build, when the build knew it. */
export const APP_COMMIT: string = (import.meta.env.VITE_APP_COMMIT as string | undefined) ?? '';
export const CURRENT_RELEASE: AppRelease = APP_RELEASES[0];

export type SinceSource = 'picked' | 'pod' | 'browser';

interface TesterCtx {
  version: string;
  commit: string;
  /** The tester's own account and the versions saved to their pod. */
  me?: AlphaMe;
  meLoading: boolean;
  meError: unknown;
  reloadMe: () => Promise<void>;
  /** The version they last tested, if known. Undefined for a first-time tester. */
  since?: string;
  sinceSource?: SinceSource;
  /** Pick the version they last tested; `null` means "this is my first time", `undefined` clears the choice. */
  pickSince: (v: string | null | undefined) => void;
  /** Everything that changed since `since`, newest first. */
  changes: ChangeWithRelease[];
  /** The same, ordered for the tester's current role. */
  forRole: ChangeWithRelease[];
  /** Changes that matter specifically to a role (not the ones for everyone). */
  newForRole: (role: TesterRoleKey) => ChangeWithRelease[];
  /** Releases older than this one, newest first (for the picker). */
  earlier: AppRelease[];
  roleKey?: TesterRoleKey;
}

const C = createContext<TesterCtx | null>(null);

export function TesterProvider({ children, roleKey }: { children: ReactNode; roleKey?: TesterRoleKey }) {
  const { session } = useSession();
  const userId = session?.user?.id;
  const me = useAsync(() => api.alphaMe(), [userId]);
  // What the tester picked here ("first" = first time), and which versions this browser has been used with.
  const [picked, setPicked] = useLocalStorage<string | null>('concord.alpha.since', null);
  const [seen, setSeen] = useLocalStorage<string[]>('concord.alpha.seen', []);

  useEffect(() => {
    if (!seen.includes(APP_VERSION)) setSeen((s) => [...new Set([...s, APP_VERSION])]);
  }, [seen, setSeen]);

  // Save this version (and the role being tried) to the tester's pod, once per version and role.
  const recorded = useRef<string>('');
  const me_ = me.data;
  const setMe = me.setData;
  useEffect(() => {
    const tester = me_?.tester;
    if (!tester) return;
    const key = `${tester.id}:${APP_VERSION}:${roleKey ?? ''}`;
    if (recorded.current === key) return;
    const entry = me_.versions.find((v) => v.version === APP_VERSION);
    if (entry && (!roleKey || entry.roles?.includes(roleKey))) {
      recorded.current = key;
      return;
    }
    recorded.current = key;
    void api
      .alphaVisit({ version: APP_VERSION, commit: APP_COMMIT || undefined, role: roleKey })
      .then((r) => setMe(r))
      .catch(() => {
        recorded.current = '';
      });
  }, [me_, roleKey, setMe]);

  const value = useMemo<TesterCtx>(() => {
    const fromPod = me_ ? lastTestedBefore(me_.versions) : undefined;
    const fromBrowser = lastTestedBefore(seen.map((version) => ({ version })));
    let since: string | undefined;
    let sinceSource: SinceSource | undefined;
    if (picked === 'first') sinceSource = 'picked';
    else if (picked && findRelease(picked) && compareVersions(picked, APP_VERSION) < 0) [since, sinceSource] = [findRelease(picked)!.version, 'picked'];
    else if (fromPod) [since, sinceSource] = [fromPod, 'pod'];
    else if (fromBrowser) [since, sinceSource] = [fromBrowser, 'browser'];
    const changes = since ? changesSince(since) : [];
    return {
      version: APP_VERSION,
      commit: APP_COMMIT,
      me: me_,
      meLoading: me.loading,
      meError: me.error,
      reloadMe: me.reload,
      since,
      sinceSource,
      pickSince: (v) => setPicked(v === null ? 'first' : (v ?? null)),
      changes,
      forRole: changesFor(changes, roleKey),
      newForRole: (role) => changes.filter((c) => c.roles.includes(role)),
      earlier: APP_RELEASES.filter((r) => compareVersions(r.version, APP_VERSION) < 0),
      roleKey,
    };
  }, [me_, me.loading, me.error, me.reload, seen, picked, setPicked, roleKey]);

  return <C.Provider value={value}>{children}</C.Provider>;
}

export function useTester() {
  const c = useContext(C);
  if (!c) throw new Error('useTester outside TesterProvider');
  return c;
}

/** Resolve a change's "where to try it" against the demo ontology. */
export function changeLink(to: string | undefined, demoId?: string): string | undefined {
  if (!to) return undefined;
  if (!to.includes('{o}')) return to;
  return demoId ? to.replace('{o}', `/o/${demoId}`) : undefined;
}
