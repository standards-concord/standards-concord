import { useCallback, useEffect, useRef, useState } from 'react';

export interface AsyncState<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  reload: () => Promise<void>;
  setData: (d: T | ((prev: T | undefined) => T)) => void;
}

/** Run an async loader whenever deps change; keeps previous data while reloading. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [data, setDataState] = useState<T>();
  const [error, setError] = useState<unknown>();
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const run = useCallback(async () => {
    const id = ++seq.current;
    setLoading(true);
    try {
      const d = await fnRef.current();
      if (id === seq.current) {
        setDataState(d);
        setError(undefined);
      }
    } catch (e) {
      if (id === seq.current) setError(e);
    } finally {
      if (id === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  const setData = useCallback((d: T | ((prev: T | undefined) => T)) => {
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

export function useLocalStorage<T>(key: string, initial: T): [T, (v: T | ((p: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (v: T | ((p: T) => T)) => {
      setValue((prev) => {
        const next = typeof v === 'function' ? (v as (p: T) => T)(prev) : v;
        try {
          localStorage.setItem(key, JSON.stringify(next));
        } catch {
          /* storage unavailable */
        }
        return next;
      });
    },
    [key],
  );
  return [value, set];
}

/** Re-render every `ms` (for countdowns and relative times). */
export function useTick(ms = 30_000) {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((x) => x + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}
