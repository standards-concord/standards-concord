import { useCallback, useEffect, useRef, useState } from 'react';
import { finishLoad, forgetKept, keptKey, keptValue, startLoad } from './kept';

export interface AsyncState<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  reload: () => Promise<void>;
  setData: (d: T | ((prev: T | undefined) => T)) => void;
}

/**
 * Run an async loader whenever deps change; keeps previous data while reloading. With `keep`, a key
 * naming what is loaded (with every dep in it), the last answer for that key is shown at once when the
 * page is opened again, and replaced when the new one arrives.
 */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[], opts?: { keep?: string }): AsyncState<T> {
  const [data, setDataState] = useState<T | undefined>(() => keptValue<T>(keptKey(opts?.keep))?.value);
  const [error, setError] = useState<unknown>();
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const keepRef = useRef(opts?.keep);
  keepRef.current = opts?.keep;
  // The key (account included) the page last loaded, forgotten along with the current one on setData.
  const loadedKey = useRef(keptKey(opts?.keep));

  const run = useCallback(async () => {
    const id = ++seq.current;
    setLoading(true);
    const key = keptKey(keepRef.current);
    const started = startLoad(key);
    loadedKey.current = key;
    const shown = keptValue<T>(key);
    if (shown) {
      setDataState(shown.value);
      setError(undefined);
    }
    let answer: { value: T } | undefined;
    try {
      const d = await fnRef.current();
      answer = { value: d };
      if (id === seq.current) {
        setDataState(d);
        setError(undefined);
      }
    } catch (e) {
      if (id === seq.current) setError(e);
    } finally {
      finishLoad(started, answer);
      if (id === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  // A page's own change (after an edit) isn't kept: what was kept for it is forgotten instead, and the
  // next load keeps afresh. As before, a load already on its way still replaces the page's data when it
  // answers; pages that edit call reload() afterwards, which supersedes it.
  const setData = useCallback((d: T | ((prev: T | undefined) => T)) => {
    forgetKept(keepRef.current, loadedKey.current);
    setDataState((prev) => (typeof d === 'function' ? (d as (p: T | undefined) => T)(prev) : d));
  }, []);

  return { data, error, loading, reload: run, setData };
}

/** Wrap an async action with pending/error state. */
export function useAction<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const run = useCallback(async (...args: A): Promise<R | undefined> => {
    setPending(true);
    setError(undefined);
    try {
      return await fnRef.current(...args);
    } catch (e) {
      setError(e);
      return undefined;
    } finally {
      setPending(false);
    }
  }, []);
  return { run, pending, error, clearError: () => setError(undefined) };
}

/** The stored value; `readable` is false when storage couldn't be read (so it must not be written over). */
function readStored<T>(key: string, initial: T): { value: T; readable: boolean } {
  let raw: string | null;
  try {
    raw = localStorage.getItem(key);
  } catch {
    return { value: initial, readable: false };
  }
  try {
    return { value: raw ? (JSON.parse(raw) as T) : initial, readable: true };
  } catch {
    return { value: initial, readable: true };
  }
}

/**
 * State mirrored to localStorage under `key`. When the key changes (say, a
 * different ontology in the same mounted page) the value is re-read for the
 * new key, so one key's state never leaks into another's.
 */
export function useLocalStorage<T>(key: string, initial: T): [T, (v: T | ((p: T) => T)) => void] {
  const [state, setState] = useState(() => ({ key, ...readStored(key, initial) }));
  let current = state;
  if (state.key !== key) {
    // Derived-state reset during render: React re-renders straight away with the new key's value.
    current = { key, ...readStored(key, initial) };
    setState(current);
  }
  const set = useCallback(
    (v: T | ((p: T) => T)) => {
      setState((prev) => {
        const base = prev.key === key ? prev : { key, ...readStored(key, initial) };
        const next = typeof v === 'function' ? (v as (p: T) => T)(base.value) : v;
        // If what was stored couldn't be read, keep the change in memory only, so it isn't lost by being written over.
        if (base.readable) {
          try {
            localStorage.setItem(key, JSON.stringify(next));
          } catch {
            /* storage unavailable */
          }
        }
        return { key, value: next, readable: base.readable };
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initial is only a fallback
    [key],
  );
  return [current.value, set];
}

/** Re-render every `ms` (for countdowns and relative times). */
export function useTick(ms = 30_000) {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((x) => x + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}
