import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
 * The last tested version (the baseline) comes from, in order: the record in
 * their pod (when signed in), the versions this browser has been used with, or,
 * when neither knows, the version the tester picked (saved per tester). Picking
 * another version when the history is known is a temporary comparison that
 * lasts until "Back to …" or a reload.
 */

/** Short commit of this web build, when the build knew it. */
export const APP_COMMIT: string = (import.meta.env.VITE_APP_COMMIT as string | undefined) ?? '';
export const CURRENT_RELEASE: AppRelease = APP_RELEASES[0];

export type SinceSource = 'picked' | 'pod' | 'browser' | 'compare';

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
  /** Where the baseline came from when nothing is being compared. */
  baseline?: string;
  baselineSource?: Exclude<SinceSource, 'compare'>;
  /** True when the pod or this browser knows an earlier version, so a pick is only a comparison. */
  hasHistory: boolean;
  /**
   * Pick a version: with no history it becomes the saved baseline (`null` = "this is my first time");
   * with history it is a temporary comparison. `undefined` clears either.
   */
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
  // Each answer is tagged with the account it was asked for, so a slow answer for the
  // previous account (or a failed reload) never stands in for the current one.
  const me = useAsync(async () => ({ forUser: userId, me: await api.alphaMe() }), [userId]);
  // What each tester (or anyone signed out) said they last tested ("first" = first time), and the
  // versions this browser has been used with.
  const [picks, setPicks] = useLocalStorage<Record<string, string>>('concord.alpha.picks', {});
  const [seen, setSeen] = useLocalStorage<string[]>('concord.alpha.seen', []);
  // A comparison belongs to the tester who picked it: another tester in this browser starts from their own baseline.
  const [compareFor, setCompareFor] = useState<{ tester: string; version: string }>();

  useEffect(() => {
    if (!seen.includes(APP_VERSION)) setSeen((s) => [...new Set([...s, APP_VERSION])]);
  }, [seen, setSeen]);

  // Save this version (and the role being tried) to the tester's pod, once per version and role.
  const recorded = useRef<string>('');
  const me_ = me.data && me.data.forUser === userId ? me.data.me : undefined;
  const setMe = me.setData;
  useEffect(() => {
    const tester = me_?.tester;
    if (!tester) return;
    const key = `${tester.id}:${APP_VERSION}:${roleKey ?? ''}`;
    if (recorded.current === key) return;
    const entry = me_.versions.find((v) => v?.version === APP_VERSION);
    if (entry && (!roleKey || (Array.isArray(entry.roles) && entry.roles.includes(roleKey)))) {
      recorded.current = key;
      return;
    }
    recorded.current = key;
    void api
      .alphaVisit({ version: APP_VERSION, commit: APP_COMMIT || undefined, role: roleKey })
      .then((r) => setMe((prev) => (prev && prev.forUser === userId && prev.me.tester?.id === tester.id ? { forUser: userId, me: r } : prev!)))
      .catch(() => {
        recorded.current = '';
      });
  }, [me_, roleKey, setMe, userId]);

  const testerKey = me_?.tester?.id ?? 'anon';
  const compare = compareFor?.tester === testerKey ? compareFor.version : undefined;
  const value = useMemo<TesterCtx>(() => {
    const valid = (v: string | undefined) => (v && findRelease(v) && compareVersions(v, APP_VERSION) < 0 ? findRelease(v)!.version : undefined);
    const versions = Array.isArray(me_?.versions) ? me_.versions.filter((v) => typeof v?.version === 'string') : [];
    const fromPod = lastTestedBefore(versions);
    const fromBrowser = lastTestedBefore((Array.isArray(seen) ? seen : []).filter((v) => typeof v === 'string').map((version) => ({ version })));
    const pick = picks?.[testerKey] ?? (testerKey !== 'anon' ? picks?.anon : undefined);
    let baseline: string | undefined;
    let baselineSource: TesterCtx['baselineSource'];
    if (fromPod) [baseline, baselineSource] = [fromPod, 'pod'];
    else if (fromBrowser) [baseline, baselineSource] = [fromBrowser, 'browser'];
    else if (pick === 'first') baselineSource = 'picked';
    else if (valid(pick)) [baseline, baselineSource] = [valid(pick), 'picked'];
    const hasHistory = !!(fromPod || fromBrowser);
    const compared = valid(compare);
    const since = compared ?? baseline;
    const sinceSource: SinceSource | undefined = compared ? 'compare' : baselineSource;
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
      baseline,
      baselineSource,
      hasHistory,
      pickSince: (v) => {
        if (hasHistory) return setCompareFor(v && v !== baseline ? { tester: testerKey, version: v } : undefined);
        setPicks((p) => {
          const next = { ...(p ?? {}) };
          if (v === undefined) delete next[testerKey];
          else next[testerKey] = v === null ? 'first' : v;
          return next;
        });
      },
      changes,
      forRole: changesFor(changes, roleKey),
      newForRole: (role) => changes.filter((c) => c.roles.includes(role)),
      earlier: APP_RELEASES.filter((r) => compareVersions(r.version, APP_VERSION) < 0),
      roleKey,
    };
  }, [me_, me.loading, me.error, me.reload, seen, picks, setPicks, compare, testerKey, roleKey]);

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
